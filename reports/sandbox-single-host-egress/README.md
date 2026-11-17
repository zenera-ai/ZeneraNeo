# Reaching exactly one internal host from a sandbox

A design, not an implementation. The question: a `strict` sandbox has no network, and a customer
wants it to reach one internal host (say `db.corp.internal:5432`) and nothing else. Where can that
be enforced, what can rootless podman on a Mac actually do, what does the agent see when something
is blocked, how is the block tested, and what should we refuse to promise.

Short answer: put the sandbox on its own `--internal` podman network with no DNS, and give it one
way out - a small gateway container on that network and on a normal one, which forwards to the one
allowed `host:port` and takes no destination from the client. Nothing is filtered; everything else
simply has no route. Every claim below marked _(probe)_ was run under rootless podman with
[`probe.sh`](probe.sh); the output is in [`probe-output.txt`](probe-output.txt).

## What exists today

- The network is one of three values, `bridge | none | host`
  ([`contract.ts`](../../packages/sandbox/src/contract.ts), `SandboxNetwork`), passed straight to
  `podman run --network` ([`podman.ts`](../../packages/sandbox/src/podman.ts), `#createArgs`).
- `strict` drops every capability, makes the root filesystem read-only, runs as the host's uid via
  `--userns keep-id` and defaults the network to `none`. The docs say the only way back to egress is
  `network: bridge`, "a project that needs egress and has accepted what that means"
  ([`docs/agents-yaml.md`](../../docs/agents-yaml.md)) - all of the internet, with the model
  credentials that reach the container by default.
- `network` is hashed into the container's name (`containerName` in `podman.ts`). A new network
  option must leave the hash of every existing configuration byte-identical, or every persisted
  container is silently abandoned.
- The `bwrap` backend has two network states: its own empty namespace (`--unshare-net`) or the
  host's (`bwrapArgs` in [`bwrap.ts`](../../packages/sandbox/src/bwrap.ts)). It has nothing to
  build an allow-list from.
- On macOS, `zen` drives `podman` inside a Linux VM (`podman machine`, reached over ssh). The
  containers are rootless inside that VM.

## Threat model

**What is protected:** the workspace, the credentials forwarded into the container, and every host
on the internal network other than the allowed one.

**The adversary** is the code running in the sandbox: whatever the model wrote, or pulled in and
ran - `strict` exists for code nobody has read. Assume it is adaptive and has read this document.
It runs with the sandbox's privileges: any syscall podman's seccomp profile allows, as root inside
the container under `standard`, as the host's uid under `strict`.

**What it wants:** a connection to anything but the allowed `host:port` - to send data out, to reach
other internal hosts, or to use the sandbox as a pivot.

**Out of scope:** a container or kernel escape (the attacker is then the host user, and no in-VM
mechanism holds), access to the podman socket, a malicious or compromised allowed host, and what
other processes of the same user do.

## Where enforcement could live

|                                                         | Linux, rootless                                               | macOS, `podman machine` (rootless)                                                             | Verdict           |
| ------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------- |
| **Image** (no curl, a fixed `/etc/hosts`, proxy env)    | Advisory only: the code opens its own sockets                 | Same                                                                                           | Not enforcement   |
| **pasta** (rootless network helper) options             | Protocols on/off and port forwards, no destination filter     | Same, inside the VM                                                                            | Cannot express it |
| **Firewall in the sandbox's own netns**                 | Possible if a helper with `NET_ADMIN` writes nftables rules   | Same                                                                                           | Rejected          |
| **Firewall in the rootless netns** (`podman unshare`)   | Shared by every container of the user; netavark owns it       | Same                                                                                           | Rejected          |
| **Host firewall**                                       | Needs root; pasta re-originates traffic as the user's sockets | `pf` sees one process, gvproxy, for the whole VM                                               | Not possible      |
| **VM firewall** (`podman machine ssh`, root in the VM)  | n/a                                                           | Root exists, but rootless container traffic leaves through the user's pasta: no container seen | Not possible      |
| **Gateway container on an `--internal` network** (here) | Rootless, per sandbox, no root                                | Identical, inside the VM                                                                       | Chosen            |

Why the rejected ones lose:

- **Firewall in the sandbox's netns.** It works rootless: a helper container joins the sandbox's
  netns (`--network container:<sb>`) with `NET_ADMIN`, writes rules, exits. But the sandbox then
  has a real default route and the block is a rule list that has to be right, so every failure
  mode - the helper not running, a rule that does not load, an IPv6 path nobody wrote - fails open.
  It also filters by IP, so the allowed name has to be resolved and pinned somewhere, and DNS needs
  its own hole.
- **Host, VM and rootless-netns firewalls** cannot tell one container from another. pasta forwards
  by opening ordinary sockets as the user, and on a Mac all of the VM's traffic reaches the Mac
  through gvproxy, a user-space stack; podman's own documentation says a VPN on the Mac sees it all
  "as coming from the host". A rule there blocks the user, not the sandbox, and would block image
  pulls with it.
- **An HTTP `CONNECT` proxy** (squid, tinyproxy) on the same internal network would also work. It
  takes the destination from the client, so its allow-list parsing becomes the boundary, and it only
  serves clients that honour `HTTPS_PROXY`. For one host, a forwarder with the destination built in
  is smaller and has nothing to steer.

## The design

Configuration, one value and no more:

```yaml
sandbox:
    hardening: strict
    network:
        allow: db.corp.internal:5432
```

What `zen` creates for it, in order, all labelled `zenera=1` and `zenera.key=<key>` like the
sandbox container today:

```sh
# 1. a network of its own: no route out, no DNS server, isolated from every other bridge network
podman network create --internal --disable-dns --opt isolate=strict zn-<name>-net

# 2. the gateway: on that network and on podman's default one, forwarding off, nothing writable,
#    no capabilities, the host's uid, one upstream fixed at start
podman run --detach --name zn-<name>-gw --network zn-<name>-net --network podman \
    --read-only --cap-drop ALL --security-opt no-new-privileges --userns keep-id \
    --pids-limit 64 --memory 64m \
    --sysctl net.ipv4.ip_forward=0 --sysctl net.ipv6.conf.all.forwarding=0 \
    --sysctl net.ipv4.ip_unprivileged_port_start=0 \
    <gateway image> socat TCP-LISTEN:5432,fork,reuseaddr TCP:db.corp.internal:5432

# 3. the sandbox as today, on the internal network, with the one name pointing at the gateway
podman run ... --network zn-<name>-net --add-host db.corp.internal:<gateway's address> ...
```

The gateway's address is read back with `podman inspect` after step 2, so `zen` does not have to
manage subnets.

Properties that matter:

- **The block is the absence of a route**, not a rule. The internal network has no default route
  and no forwarding on its bridge _(probe)_, so a broken or missing gateway leaves the sandbox with
  no network at all. If any step fails, `zen` reports a `SandboxError` and starts nothing -
  it never falls back to `bridge`.
- **The client chooses nothing.** The gateway has one upstream, set when it starts. There is no
  protocol to ask it for another host.
- **TLS stays end to end.** The sandbox connects to the real name, `/etc/hosts` sends it to the
  gateway, the gateway passes bytes. The certificate still matches the name, and the gateway never
  holds a key. It is plain TCP, so Postgres, ssh and HTTPS all work.
- **No DNS at all inside the sandbox.** The only name that resolves is the one in `/etc/hosts`. The
  gateway resolves the real name itself, with the VM's resolver - on a Mac that is the Mac's,
  through gvproxy, so split DNS and a VPN apply as they do for any other process there.
- **Forwarding off in the gateway.** Podman created the gateway with `ip_forward=1` _(probe)_. A
  sandbox that could set its own default route through the gateway would then be routed by it.
  Podman's default capabilities do not include `NET_ADMIN`, so a `standard` sandbox cannot set that
  route _(probe)_, and in the probe even a sandbox given `NET_ADMIN` got nothing back with
  forwarding on. I did not isolate what stopped it (most likely netavark's forwarding rules), so the
  design does not rely on it: forwarding is switched off in the gateway itself.
- **`isolate=strict` is explicit.** It is the default from podman 6 / netavark 2, but not in podman
  5, which is what the probe ran (see below).
- **Container names do not move.** `allow` is an object where `network` is a string today, so
  `JSON.stringify` in `containerName` produces exactly the old bytes for `bridge`, `none` and `host`
  and a new name only for the new form. The gateway and network take the sandbox's name with a
  `-gw` and `-net` suffix, live and die with it, and follow `persist` the same way.
- **`bwrap` refuses.** `network.allow` with the `bwrap` backend is a configuration error at load
  time, not a silent `none` and certainly not the host's network.

## What the agent sees

Everything else fails at once, not after a timeout _(probe)_:

| What the code tries                    | What it gets                                              |
| -------------------------------------- | --------------------------------------------------------- |
| `db.corp.internal:5432`                | A normal connection                                       |
| Any IP address, internal or public     | `Failed to connect ... after 0 ms` (no route to the host) |
| Any other name                         | `Could not resolve host`                                  |
| Any DNS server, including a public one | `network unreachable`                                     |
| `host.containers.internal`             | `Failed to connect ... after 0 ms`                        |

Two smaller points. Podman still writes the host's nameservers into `/etc/resolv.conf`; they are
unreachable, but a tool that prints them may confuse a reader, and `--dns none` would remove them.
And the agent should be told, in whatever describes the sandbox to it: _only db.corp.internal:5432
is reachable; anything else fails immediately_ - an agent that knows the rule stops retrying.

The gateway's own log lists the connections it carried. Blocked attempts never reach it, so they are
not logged anywhere.

## How the block is tested

The probe ([`probe.sh`](probe.sh)) builds the whole arrangement against two local targets, an
allowed and a forbidden one, so it needs no internet except for two checks that show the real world
_is_ reachable where it should be. It refuses to report anything unless the allowed path works
first, because a probe that cannot connect at all "passes" every block. Results, 21 of 21 as
expected ([`probe-output.txt`](probe-output.txt)):

- allowed host by name, through the gateway: works
- forbidden host by IP; the allowed host's own IP (bypassing the gateway); the public internet by
  name and by IP; DNS through the configured resolvers; DNS straight to `1.1.1.1`;
  `host.containers.internal`; the gateway on a port it does not serve: all fail
- an internal network that keeps its DNS server answers `NXDOMAIN` for public names and still
  resolves container names, as podman documents
- a `standard` sandbox cannot change its routes; a sandbox given `NET_ADMIN` that routes everything
  through the gateway, or adds an on-link default route, still reaches nothing - with the gateway
  as podman creates it and with forwarding off
- another sandbox on its own internal network cannot reach this one
- the gateway, hardened exactly as above (uid 1000, no capabilities, read-only, port 443), still
  carries the allowed connection, and still reaches the outside world through pasta

**Breaking it on purpose:** with `MUTATE=no-internal` the probe creates the same network without
`--internal`, and four checks turn red - the public internet by name and by IP, and DNS both ways
([`probe-output-without-internal.txt`](probe-output-without-internal.txt)). One honest gap: removing
the gateway's `ip_forward=0` turns nothing red here, because something else on the path already
stopped the routing attack. The setting stays because that something is a firewall rule set, and on
the test machine the default nftables rules did not even load.

In the repository this would become:

- **Unit tests** (no podman): the argv for the `allow` form - the network flags, the gateway's
  sysctls and `--read-only`, the sandbox's `--network` and `--add-host`; every existing
  `containerName` unchanged; `bwrap` rejecting `allow`; the `host:port` parser rejecting a
  wildcard, a CIDR, a scheme, a path, a missing or out-of-range port.
- **A live test** next to `live-podman.test.ts`, kept out of default CI like the other `live-*`
  tests: the probe's checks as test cases, against containers it starts itself.
- **A failure test:** a gateway that cannot start must leave no sandbox running, rather than a
  sandbox on some other network.

## What I would refuse to promise

- **That data cannot leave.** It can leave through the allowed host: a database the agent can write
  to, an HTTP service that fetches URLs or relays messages. "One host" bounds where packets go, not
  where information ends up.
- **Anything about the content of allowed traffic.** It is a TCP pipe: no method, path or query
  filtering, no protection from covert channels inside an allowed connection.
- **More than one `host:port`**, UDP or ICMP, wildcards, CIDR ranges. Each is a different design
  with its own failure modes; one host is the request.
- **The allowed name's DNS.** The gateway trusts the VM's resolver for that one name; if internal
  DNS answers with another address, the gateway connects to it.
- **The `bwrap` backend, rootful podman or Docker.** Only rootless podman was tested.
- **macOS, beyond what podman documents.** The probe ran on Linux. The containers on a Mac run under
  the same rootless podman inside the VM, so the sandbox side should behave the same; that the
  gateway reaches a host on the Mac's VPN through gvproxy is podman's documentation, not my test.
- **A record of blocked attempts.** They fail inside the sandbox and are never seen.

## Open questions

- The gateway image: a small image published with the sandbox images (alpine and socat, pinned by
  digest), or a forwarder inside `zen` itself? The second needs no extra image but only works where
  the project's image has Node, which a published `python:3.12-slim` does not.
- Should the gateway resolve the allowed name once, at start, and keep the address? Fewer moving
  parts and no address changes mid-session, at the cost of a restart when the host moves.
- Is `network: { allow: ... }` the right place in `agents.yaml`, or should it be its own key, since
  it also changes what the `bwrap` backend accepts?
- Where should the sandbox's description to the agent carry the one-line rule about what is
  reachable?

## Reproduce

Any Linux machine with rootless podman and access to `docker.io`:

```sh
sh probe.sh                     # the design
MUTATE=no-internal sh probe.sh  # the same without --internal: four checks must fail
```

On a machine with only Docker, [`run-in-docker.sh`](run-in-docker.sh) runs the same probe as an
unprivileged user inside `quay.io/podman/stable`. The recorded outputs come from that path: podman
5.8.9, netavark 1.17.2, aardvark-dns 1.17.1, cgroups v1 (Docker Desktop on WSL2, kernel 5.15), with
netavark's iptables driver because that kernel could not load its nftables rules. Podman 6 refuses
cgroups v1, so 6.x was not tested.
