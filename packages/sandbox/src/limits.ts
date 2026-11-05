import type { SandboxHardening, SandboxSpec } from './contract.ts';

// ---------------------------------------------------------------------------
// A sandbox's ceilings
//
// Stated once, here, so the sandbox that applies them and `zen sandbox status`
// that reports them cannot disagree.
// ---------------------------------------------------------------------------

// Standard mode's resource ceilings. Even without the strict profile, an
// unbounded container can exhaust host cores or memory during runaway builds.
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY = 4096;

// Strict mode's own defaults. A limit that is only there when someone
// remembered to write it down is not a limit, so the profile supplies one for
// each of the four exhaustible things: cores, memory, processes and disk.
const STRICT_CPUS = 2;
const STRICT_MEMORY = 2048;

export interface SandboxLimits {
    /** MiB */
    memory: number;
    /** fractional cores */
    cpus: number;
    hardening: SandboxHardening;
    /** whether the numbers above were written down, or are this profile's defaults */
    declared: boolean;
}

/**
 * What a spec's ceilings come to, for a report that has no container to ask.
 *
 * It exists so `zen sandbox status` cannot disagree with what a run actually
 * applies: the defaults are stated once, here and in `resolveSpec`, and
 * nothing outside this module repeats them.
 */
export function sandboxLimits(
    spec: Pick<SandboxSpec, 'cpus' | 'memory' | 'hardening'> = {},
): SandboxLimits {
    const hardening = spec.hardening ?? 'standard';
    const strict = hardening === 'strict';
    return {
        memory: spec.memory ?? (strict ? STRICT_MEMORY : DEFAULT_MEMORY),
        cpus: spec.cpus ?? (strict ? STRICT_CPUS : DEFAULT_CPUS),
        hardening,
        declared: spec.memory !== undefined || spec.cpus !== undefined,
    };
}
