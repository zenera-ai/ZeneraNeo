# Allowing one destination from a strict sandbox

## Problem

A customer wants a strict sandbox to reach one internal service without gaining general network access. The sandbox runs model-written code, so environment variables, DNS configuration, and application-level conventions are not security boundaries: the code can open sockets directly and may run as root inside its container.

The current Podman backend can give a sandbox `bridge`, `host`, or `none` networking. Strict hardening defaults to `none`, and `PodmanSandbox` passes the selected value directly to `podman run --network`. There is no destination-aware policy between a sandbox and the network.

## Security goal

Permit outbound connections only to a configured destination set that resolves to one service identity:

- one hostname;
- an explicit set of TCP ports;
- one protocol policy, either HTTP/HTTPS through an application proxy or raw TCP through a fixed forwarder;
- an explicit DNS policy for how the hostname is resolved and when a changed address is accepted.

Deny every other route, including direct connections by IP, alternate DNS servers, access to the Podman host or VM, cloud metadata addresses, other sandboxes, and destinations reached through an allowed host acting as a general proxy.

This policy limits network destinations. It does not make the allowed service safe, prevent data exfiltration to that service, or prove which application receives traffic after it reaches a shared IP.

## Threat model

The attacker controls every process inside the agent sandbox and can:

- ignore `HTTP_PROXY`, rewrite resolver settings where permissions allow, and create raw sockets;
- use IPv4, IPv6, numeric addresses, redirects, unusual HTTP methods, WebSockets, and long-lived connections;
- scan reachable addresses and ports;
- send secrets, workspace data, and generated data to anything reachable;
- exploit DNS rebinding or changes in a hostname's address set;
- try the Podman gateway, host aliases, link-local addresses, and services in the Podman machine;
- run many short connections to race policy updates;
- compromise the allowed service and use it as a relay.

The attacker does not control the Podman host process, the rootless Podman machine, or the policy sidecar image. A compromise of Podman, the Linux kernel in the Podman machine, or the sidecar is outside this control's boundary and must be handled by patching and host isolation.

## Proposed architecture

Use a dedicated internal network and a policy sidecar for each sandbox. Do not attach the agent container to any network with a default route.

```text
agent container
  strict hardening
  only attached to sandbox-<id>-internal
        |
        | no route beyond this isolated network
        v
policy sidecar
  attached to sandbox-<id>-internal
  attached to an egress-capable network
  allow-list compiled by the host
        |
        v
one configured internal service
```

The host creates a private Podman network for the session with external routing disabled, starts the policy sidecar on both the private network and an egress-capable network, and starts the agent container only on the private network. The private network is unique to the sandbox and contains no unrelated workloads. The agent therefore has no path around the sidecar even if it opens sockets directly.

The sidecar gets a generated, read-only policy file rather than policy in environment variables. The file contains the destination hostname, ports, protocol mode, resolved addresses, expiry, and a policy identifier used in logs. The agent gets no Podman socket, network-administration capability, host mount, or sidecar control endpoint.

### HTTP and HTTPS mode

For HTTP-based services, the sidecar is a forward proxy with these rules:

- accept requests only from the sandbox's private network;
- allow only the configured hostname and ports;
- for HTTPS, allow `CONNECT` only to the exact configured authority;
- resolve the hostname itself and connect only to the address set approved by the host policy compiler;
- reject redirects to another authority rather than following them in the proxy;
- reject requests that name a numeric address, user-info authority, malformed hostname, or a hostname that differs only after normalization;
- do not expose a general DNS resolver to the agent;
- cap connection count, idle time, request-header size, and bytes per connection.

The sandbox receives proxy variables for compatible tools, but those variables are only usability hints. The network topology is the enforcement boundary.

A TLS pass-through proxy can restrict the destination and port, but it cannot validate the HTTP path or method. If the customer needs path-level policy, the sidecar must terminate TLS with a customer-managed trust arrangement. That changes the security and privacy model and should be a separate feature.

### Raw TCP mode

For a non-HTTP service, expose one sidecar listener for each allowed destination port. Each listener forwards to one pre-resolved destination address and port. The agent connects to the sidecar's stable private-network name and port, not to the original host directly.

Raw TCP mode cannot distinguish protocols that share a port. UDP is not included in the first version because a connectionless relay needs separate timeout, spoofing, amplification, and response-association controls.

### DNS and address changes

A hostname is not a stable network identity. The host resolves it before the sandbox starts and rejects addresses in forbidden ranges unless the policy explicitly permits the customer's internal range. The resulting address set is pinned for the lifetime of the sandbox.

A policy refresh creates a new sidecar or atomically installs a new address set only after the host validates it. Existing connections keep their old decision; new connections use the new one. A DNS result that unexpectedly crosses from an approved internal range to loopback, link-local, metadata, multicast, or a public range fails closed and produces a visible policy error.

For services behind a load balancer, the customer must choose one of these semantics:

1. pin the resolved addresses for the session;
2. approve a bounded CIDR owned by the service;
3. use HTTPS mode and treat a validated TLS service identity as the primary identity, while still blocking forbidden address ranges.

The configuration must not silently switch between these meanings.

## Where enforcement could live

### In the agent image

Tools such as shell wrappers, proxy variables, `/etc/hosts`, or a custom resolver improve usability but do not enforce policy against arbitrary code. A process can bypass them with a direct socket. Image-only enforcement is insufficient.

An in-container firewall is also the wrong boundary. It requires network-administration capability, and code running in the same container may be able to inspect, alter, or exploit the enforcement process. Strict hardening currently drops every capability, so adding one for firewall management would weaken the profile.

### In the agent container runtime configuration

A container network with no external route is a useful boundary and should remain the first layer. Podman's current `--network none` is strong for total denial, but it cannot express one destination.

Attaching the agent directly to a normal bridge and filtering by DNS or proxy variables is insufficient. The agent still has a route to every address that bridge can reach.

### In the policy sidecar

The sidecar is the best place for protocol-aware decisions, useful denial messages, limits, and audit records. It is not sufficient by itself if the agent shares an egress-capable network with it. The dedicated internal network is what prevents bypass.

The sidecar image must be minimal, immutable, non-root, capability-free, read-only, and configured without a writable control plane. Its logs must omit request bodies, credentials, URL query strings, and other application data.

### In the Podman machine or host

A firewall in the Linux Podman machine can enforce destination IP and port below the container, which is a strong second layer. It is operationally attractive on a managed Linux host where the service owns the network namespace and firewall rules.

On macOS, rootless Podman runs containers inside a Linux virtual machine. macOS packet-filter rules do not identify an individual container once traffic has crossed the VM boundary, and a rootless client should not assume it can install host-wide nftables rules inside the machine. Requiring privileged, machine-wide firewall mutation would also make one user's project affect other Podman workloads.

For that reason, the portable macOS design uses rootless Podman networks plus the dual-homed sidecar. A managed deployment may add VM-level firewall rules as defense in depth, but the feature must not claim that those rules are available on every rootless Podman machine.

### In an external network proxy

An enterprise egress proxy can be the final enforcement point and may already have identity, audit, and destination policy. The sandbox sidecar can forward to it. The private-network topology is still required so agent code cannot bypass the proxy.

The product should not assume the proxy can identify individual sandboxes unless it receives a per-sandbox credential or runs on a dedicated path. Shared credentials make attribution and revocation ambiguous.

## Fit with rootless Podman on macOS

The following design properties fit the current local backend:

- The agent remains an ordinary rootless container and does not need extra capabilities.
- Isolation is expressed with Podman networks and container attachments inside the Podman machine, not macOS firewall rules.
- The sidecar owns the only attachment to an egress-capable network.
- Every sandbox gets a unique private network, preventing lateral access to other sessions.
- Cleanup removes the agent container, sidecar, and private network together.

Before implementation, a spike must verify the exact Podman version's internal-network behavior on macOS. The acceptance test is packet behavior, not the presence of a CLI flag: from the agent container there must be no route to an external IP, the VM gateway, host aliases, or another network, while the sidecar remains reachable. If Podman's rootless network backend supplies an unexpected route, the feature must fail closed rather than fall back to a normal bridge.

The current `SandboxNetwork` union is too small for this policy. I would not overload `network: bridge` with hidden semantics. A new structured policy should be explicit, for example:

```yaml
sandbox:
    hardening: strict
    egress:
        mode: https-proxy
        host: inventory.corp.example
        ports: [443]
        addresses:
            strategy: pin-for-session
            allowedCidrs: [10.42.0.0/16]
```

`network: none` and an `egress` block should be mutually exclusive at validation time. `network: host` should remain incompatible with destination filtering because host networking removes the topology that makes the policy enforceable.

## What the agent sees when traffic is blocked

There are two useful failure classes:

1. A connection that bypasses the sidecar gets a fast network failure because there is no route.
2. A request made through the sidecar gets a small protocol-appropriate denial with a stable policy code.

For HTTP, the sidecar returns `403` with a response like:

```text
ZEN_EGRESS_DENIED policy=egress-7 reason=destination-not-allowed
```

For an unapproved `CONNECT`, it returns `403` before opening an upstream connection. For a configured destination that cannot be reached, it returns `502` with `reason=approved-destination-unavailable`, which distinguishes policy from service health.

Raw TCP cannot reliably return a structured application error, so the sidecar closes the connection and records a sanitized denial event. The CLI and sandbox status command should expose recent policy counters and the configured destination without exposing application data:

```text
egress: restricted
policy: egress-7
allowed: inventory.corp.example:443
allowed connections: 18
denied connections: 4
last denial: destination-not-allowed
```

## Test plan

### Unit tests

Test policy parsing and normalization with:

- mixed-case names, trailing dots, internationalized names, IPv4-in-IPv6 forms, and numeric host spellings;
- duplicate and invalid ports;
- forbidden address ranges, including loopback, link-local, multicast, and common metadata addresses;
- DNS answers that move between approved and forbidden ranges;
- incompatible combinations such as `network: host` plus restricted egress;
- policy identity changes whenever any enforcement-relevant field changes.

Test sidecar decisions for exact authority matching, alternate ports, redirects, WebSocket upgrades, oversized headers, connection limits, timeouts, and sanitized logs.

### Integration tests in Linux CI

Run an allowed service and a forbidden service, then execute adversarial clients inside the sandbox:

- resolve and reach the allowed hostname and port;
- try the allowed service by its direct IP;
- try the same hostname on another port;
- try another container, the network gateway, loopback, link-local, metadata addresses, public IPv4 and public IPv6;
- ignore proxy variables and open raw sockets;
- specify a public DNS server directly;
- use redirects, `CONNECT`, WebSockets, and an allowed HTTP server that redirects elsewhere;
- restart the sidecar and verify the agent never gains a temporary default route;
- stop the allowed service and verify the error is availability, not policy;
- close the sandbox and verify its sidecar and network are removed.

Packet capture belongs outside the agent container. The test passes only if no denied SYN or UDP packet leaves the private network toward the target network.

### macOS rootless Podman tests

Run the same black-box suite on a real macOS runner with a Podman machine. Add probes for Podman host aliases and addresses used by the VM gateway. Reboot the Podman machine between suites to catch rules or networks that were not cleaned up.

A version matrix should cover the oldest supported Podman release and the current release. If the required internal-network behavior is unavailable, restricted egress is reported as unsupported; it must not degrade to `bridge`.

### Abuse and failure tests

- Kill the sidecar during active and new connections. New traffic must fail closed.
- Corrupt or remove the policy file. The sidecar must refuse to start.
- Return an empty, very large, or rapidly changing DNS answer.
- Make the allowed service a proxy and confirm that this destination-only control cannot stop application-level relaying; document that limitation in the result.
- Attempt container escape and Podman API access as separate sandbox-isolation tests, not as proof of egress correctness.

## Rollout and observability

Ship this as an opt-in strict-sandbox feature. Startup performs a capability probe and a short connectivity self-test before any agent command runs. A failed probe is a sandbox error with a remediation message, never a warning followed by unrestricted networking.

Record policy decisions as counters and structured events keyed by sandbox and policy identifiers. Do not record payloads, authorization headers, full URLs, DNS response contents beyond approved addresses, or workspace data. Rate-limit repeated denial events so a scan cannot fill logs.

The status output should state where enforcement is active: private Podman network, sidecar mode, and optional upstream enterprise proxy. This makes a partial deployment visible.

## What I would refuse to promise

I would not promise any of the following:

- that allowing one host prevents exfiltration, because the allowed host can receive arbitrary data;
- that a hostname always names one machine or organization;
- that TLS pass-through validates an HTTP path, method, or application identity;
- that an allowed service cannot proxy, redirect, tunnel, or be compromised;
- that IP filtering alone identifies a service on shared infrastructure;
- that macOS host firewall rules can portably enforce per-container rootless Podman policy;
- that `HTTP_PROXY`, `/etc/hosts`, DNS settings, or an in-image firewall are security boundaries against arbitrary code;
- that UDP, ICMP, Unix sockets, host networking, or every future protocol is covered by the first version;
- that this control survives a Podman, policy-sidecar, VM-kernel, or host compromise;
- that traffic is confidential unless the allowed protocol provides authenticated encryption.

The product can promise a narrower, testable property: while the sandbox and policy components are uncompromised, the agent container has no network path except to its private sidecar, and the sidecar opens upstream connections only for the normalized destinations and ports in the active policy.

## Open questions

- Is the customer's target HTTP/HTTPS, or does it require arbitrary TCP?
- Does “one host” mean a DNS name, a stable IP set, a CIDR, or a TLS service identity?
- Which ports and address ranges are valid, and may the service move during a session?
- Must the destination receive the original hostname and end-to-end TLS, or may the sidecar terminate TLS?
- Is an enterprise egress proxy already available, and can it issue per-sandbox credentials?
- What Podman versions and macOS versions are supported?
- Should a persisted sandbox also persist its network policy, or must every session recreate and revalidate it?
