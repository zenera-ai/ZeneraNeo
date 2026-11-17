#!/bin/sh
# Checks the claims in README.md under ROOTLESS podman. Needs nothing but podman and network access
# to docker.io (one alpine image). Every check prints PASS/FAIL against what the design expects;
# the run refuses to report anything unless the allowed path works first.
#   sh probe.sh                       # the design as proposed
#   MUTATE=no-internal sh probe.sh    # the same with --internal removed: checks must report leaks
set -u
NET=zn-egress-probe
SUB=10.250.7.0/24
GW_IP=10.250.7.10
T=5   # seconds; a blocked connect must fail fast, not hang

say()  { printf '%s\n' "$*"; }
expect_ok()   { if eval "$2" >/tmp/out 2>&1; then say "PASS  $1"; else say "FAIL  $1  -> $(head -c 300 /tmp/out | tr '\n' ' ')"; fi; }
expect_fail() { if eval "$2" >/tmp/out 2>&1; then say "FAIL  $1  (it worked)  -> $(head -c 200 /tmp/out | tr '\n' ' ')"; else say "PASS  $1  -> $(head -c 160 /tmp/out | tr '\n' ' ')"; fi; }

say "== environment"
podman info --format 'podman={{.Version.Version}} rootless={{.Host.Security.Rootless}} netbackend={{.Host.NetworkBackend}} cgroups={{.Host.CgroupsVersion}}' 2>/dev/null
podman info --format '{{.Host.NetworkBackendInfo.Version}} | dns: {{.Host.NetworkBackendInfo.DNS.Version}} | pasta: {{.Host.Pasta.Version}}' 2>/dev/null | tr '
' ' '; echo

# Setup must fully succeed, or nothing below means anything.
set -e

say "== setup"
podman build -q -t probe-tools -f - . >/dev/null <<'EOF'
FROM docker.io/library/alpine:3.20
RUN apk add --no-cache curl socat bind-tools iproute2
EOF
# The "outside world": two hosts on an ordinary network. Only one may be reached.
podman network create outside >/dev/null
podman run -d -q --name allowed   --network outside probe-tools socat TCP-LISTEN:8080,fork,reuseaddr SYSTEM:'echo allowed-ok' >/dev/null
podman run -d -q --name forbidden --network outside probe-tools socat TCP-LISTEN:8080,fork,reuseaddr SYSTEM:'echo forbidden-LEAK' >/dev/null
ALLOWED_IP=$(podman inspect allowed --format '{{(index .NetworkSettings.Networks "outside").IPAddress}}')
FORBIDDEN_IP=$(podman inspect forbidden --format '{{(index .NetworkSettings.Networks "outside").IPAddress}}')
say "allowed=$ALLOWED_IP forbidden=$FORBIDDEN_IP"

# Per-sandbox network: internal (no route out) and no DNS server at all.
if [ "${MUTATE:-}" = no-internal ]; then
  say "MUTATION: sandbox network created WITHOUT --internal (the checks below must now report leaks)"
  podman network create --disable-dns --opt isolate=strict --subnet $SUB $NET >/dev/null
else
  podman network create --internal --disable-dns --opt isolate=strict --subnet $SUB $NET >/dev/null
fi
# Egress gateway: on both networks, fixed address on the internal one, ONE upstream baked in.
podman run -d -q --name gw --network $NET:ip=$GW_IP --network outside probe-tools \
  socat TCP-LISTEN:8080,fork,reuseaddr TCP:allowed:8080 >/dev/null
# The sandbox, as `strict` creates it today, plus the internal network and one static name.
podman run -d -q --name sb --network $NET --add-host allowed.internal:$GW_IP \
  --cap-drop ALL --read-only --security-opt no-new-privileges --init probe-tools sleep infinity >/dev/null
X="podman exec sb"
set +e

# Gate: the sandbox must be running and the allowed path must work. Otherwise every
# "blocked" check below would pass for the wrong reason (nothing ran at all).
if [ "$(podman inspect sb --format '{{.State.Running}}' 2>/dev/null)" != "true" ] ||    ! $X curl --http0.9 -sS --max-time $T http://allowed.internal:8080 2>/dev/null | grep -q allowed-ok; then
  say "INVALID RUN: setup did not produce a working sandbox and gateway; no results reported."
  say "--- diagnostics"
  podman ps -a --format '{{.Names}} {{.Status}}'
  say "gw logs:"; podman logs gw 2>&1 | tail -5
  say "gw networks:"; podman inspect gw --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}'
  say "gw -> allowed:"; podman exec gw sh -c "getent hosts allowed; curl --http0.9 -sS --max-time 5 http://allowed:8080" 2>&1 | tail -3
  say "sb routes/hosts:"; $X sh -c "ip route; grep allowed /etc/hosts" 2>&1
  say "sb -> gw:"; $X curl --http0.9 -sS -v --max-time 5 http://allowed.internal:8080 2>&1 | tail -6
  exit 2
fi

say "== what the sandbox sees"
$X sh -c 'echo "routes:"; ip route; echo "resolv.conf:"; cat /etc/resolv.conf 2>&1; echo "hosts:"; cat /etc/hosts'

say "== checks (strict sandbox)"
expect_ok   "allowed host by name, through the gateway"      "$X curl --http0.9 -sS --max-time $T http://allowed.internal:8080 | grep -q allowed-ok"
expect_fail "forbidden host by IP"                            "$X curl --http0.9 -sS --max-time $T http://$FORBIDDEN_IP:8080"
expect_fail "allowed host by IP, bypassing the gateway"      "$X curl --http0.9 -sS --max-time $T http://$ALLOWED_IP:8080"
expect_fail "public internet by name"                         "$X curl --http0.9 -sS --max-time $T https://example.com"
expect_fail "public internet by IP (1.1.1.1:443)"             "$X curl --http0.9 -sS --max-time $T https://1.1.1.1"
expect_fail "DNS lookup of a public name"                     "$X nslookup -timeout=3 example.com"
expect_fail "DNS straight to a public resolver over UDP"     "$X nslookup -timeout=3 example.com 1.1.1.1"
expect_fail "host.containers.internal"                        "$X curl --http0.9 -sS --max-time $T http://host.containers.internal:8080"
expect_fail "gateway steered to another port (no listener)"   "$X curl --http0.9 -sS --max-time $T http://$GW_IP:22"

say "== DNS on an internal network that KEEPS its DNS server (documented: NXDOMAIN for non-container names)"
podman network create --internal ${NET}-dns >/dev/null
podman run -d -q --name sbdns --network ${NET}-dns probe-tools sleep infinity >/dev/null
podman run -d -q --name peer  --network ${NET}-dns probe-tools sleep infinity >/dev/null
expect_fail "aardvark answers a public name"                   "podman exec sbdns nslookup -timeout=3 example.com"
expect_ok   "aardvark still resolves a container name"         "podman exec sbdns nslookup -timeout=3 peer"

say "== adversarial: a STANDARD sandbox (capabilities kept) tries to add its own default route"
podman run -d -q --name sbstd --network $NET --cap-add NET_ADMIN probe-tools sleep infinity >/dev/null
BR=$(podman exec sbstd ip -4 route | awk '/proto kernel/ {print $1; exit}')
say "internal subnet route: $BR"
podman exec sbstd sh -c "ip route add default via $GW_IP 2>&1 || true; ip route"
expect_fail "forbidden host after routing everything via the gateway container" "podman exec sbstd curl --http0.9 -sS --max-time $T http://$FORBIDDEN_IP:8080"
podman exec sbstd sh -c "ip route del default 2>/dev/null; ip route add default dev eth0 2>&1 || true"
expect_fail "forbidden host after an on-link default route"     "podman exec sbstd curl --http0.9 -sS --max-time $T http://$FORBIDDEN_IP:8080"
say "gateway container forwards packets? ip_forward=$(podman exec gw cat /proc/sys/net/ipv4/ip_forward)"

say "== isolation between sandboxes (Netavark 2 default isolate=strict)"
podman network create --internal --disable-dns --opt isolate=strict --subnet 10.250.8.0/24 ${NET}-other >/dev/null
podman run -d -q --name other --network ${NET}-other probe-tools sleep infinity >/dev/null
SB_IP=$(podman inspect sb --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}")
podman exec -d sb socat TCP-LISTEN:9000,fork,reuseaddr SYSTEM:'echo sb-LEAK'
expect_fail "another sandbox reaches this one"                 "podman exec other curl --http0.9 -sS --max-time $T http://$SB_IP:9000"

say "== the gateway itself reaches the real world through pasta (path an internal host would take)"
expect_ok   "gateway resolves and connects outward"            "podman exec gw sh -c 'curl --http0.9 -sS --max-time 10 -o /dev/null -w %{http_code} https://example.com | grep -q 200'"

say "== adversarial 2: can the gateway container be used as a router to the PUBLIC internet?"
PUB=$(podman exec gw sh -c "getent ahostsv4 example.com | awk 'NR==1{print \$1}'")
say "example.com resolves (on the gateway side) to $PUB"
podman run -d -q --name sbplain --network $NET probe-tools sleep infinity >/dev/null
expect_fail "a STANDARD sandbox (podman default caps) changes its routes" "podman exec sbplain ip route add default via $GW_IP"
podman exec sbstd sh -c "ip route del default 2>/dev/null; ip route add default via $GW_IP"
say "gateway ip_forward=$(podman exec gw cat /proc/sys/net/ipv4/ip_forward) (as podman creates it)"
expect_fail "NET_ADMIN sandbox -> public IP via the gateway (gateway as created)"   "podman exec sbstd curl --http0.9 -sS --max-time $T http://$PUB"
expect_fail "NET_ADMIN sandbox -> pasta DNS via the gateway (gateway as created)"   "podman exec sbstd nslookup -timeout=3 example.com 169.254.1.1"
podman rm -f -t 0 gw >/dev/null
# The gateway exactly as the design specifies it: forwarding off, read-only, no capabilities,
# unprivileged uid, and still able to listen on a port below 1024 (namespaced sysctl).
podman run -d -q --name gw --network $NET:ip=$GW_IP --network outside   --read-only --cap-drop ALL --security-opt no-new-privileges --userns keep-id   --pids-limit 64 --memory 64m   --sysctl net.ipv4.ip_forward=0 --sysctl net.ipv6.conf.all.forwarding=0   --sysctl net.ipv4.ip_unprivileged_port_start=0 probe-tools   socat TCP-LISTEN:443,fork,reuseaddr TCP:allowed:8080 >/dev/null
say "gateway ip_forward=$(podman exec gw cat /proc/sys/net/ipv4/ip_forward), uid=$(podman exec gw id -u), caps=$(podman exec gw grep CapEff /proc/self/status | tr -d '	')"
expect_ok   "allowed path through the hardened gateway (port 443, no caps, read-only)" "podman exec sb curl --http0.9 -sS --max-time $T http://allowed.internal:443 | grep -q allowed-ok"
expect_fail "NET_ADMIN sandbox -> public IP via the gateway (forwarding off)"       "podman exec sbstd curl --http0.9 -sS --max-time $T http://$PUB"
expect_fail "NET_ADMIN sandbox -> pasta DNS via the gateway (forwarding off)"       "podman exec sbstd nslookup -timeout=3 example.com 169.254.1.1"

say "== done"
