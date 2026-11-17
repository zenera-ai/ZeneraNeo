#!/bin/sh
# Entry point used by run-in-docker.sh. Runs as root only to install legacy iptables, then runs
# probe.sh as the unprivileged `podman` user, so every podman command in it is rootless.
#
# Why legacy iptables: the test machine's kernel (Docker Desktop, WSL2 5.15) could not load the
# nftables ruleset netavark writes ("Could not process rule: No such file or directory"), and the
# image ships no iptables. The firewall driver only matters for the isolation between networks;
# --internal itself works by having no route and no forwarding, not by firewall rules.
set -e
dnf -y -q install iptables-legacy >/dev/null
ln -sf /usr/sbin/iptables-legacy /usr/local/sbin/iptables
ln -sf /usr/sbin/ip6tables-legacy /usr/local/sbin/ip6tables
echo "iptables: $(iptables --version)"
conf=/home/podman/.config/containers/containers.conf.d
install -d -o podman -g podman "$conf"
printf '[network]\nfirewall_driver="iptables"\n' > "$conf/90-firewall.conf"
chown podman:podman "$conf/90-firewall.conf"
exec runuser -u podman -- env HOME=/home/podman PATH="/usr/local/sbin:$PATH" \
    PODMAN_IGNORE_CGROUPSV1_WARNING=1 MUTATE="${MUTATE:-}" sh /probe/probe.sh
