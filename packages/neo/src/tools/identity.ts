import { tool, type AnyTool } from '../types.ts';

// ---------------------------------------------------------------------------
// Who a run is for
//
// Not who wrote the project and not whose keys pay for it: the person the host
// authenticated and is running this turn on behalf of. The host knows that and
// the model does not, so it travels the one way that cannot be argued with — as
// a value the host hands in, read back by a tool that takes no arguments. There
// is nothing for the model to pass, so there is nothing for it to make up.
//
// The same values reach code in the sandbox as `ZEN_USER_*` variables, set on
// every command rather than on the container: a container outlives a run, and
// one kept between sessions must not answer for whoever used it last.
// ---------------------------------------------------------------------------

/** The family name config selects the set by: `tools: [identity:*]`. */
export const IDENTITY_GROUP = 'identity';

/**
 * Where an identity came from. Only `host` is vouched for: the process that
 * opened the run authenticated the user itself. `local` is whatever this
 * machine was told — `zen run --as`, or variables already in the environment —
 * which is fine for testing a project and means nothing as proof.
 */
export type IdentitySource = 'host' | 'local';

export interface RunIdentity {
    /** stable id of the user; what to key anything per-user on */
    id: string;
    email?: string;
    name?: string;
    /** the user's role in this project, in the host's own words */
    role?: string;
    source: IdentitySource;
}

/** The variables the identity is exported as, inside the sandbox. */
export const IDENTITY_ENV = {
    id: 'ZEN_USER_ID',
    email: 'ZEN_USER_EMAIL',
    name: 'ZEN_USER_NAME',
    role: 'ZEN_USER_ROLE',
    source: 'ZEN_USER_SOURCE',
} as const;

/** Every name under it is the host's to set; a project may not. */
export const IDENTITY_ENV_PREFIX = 'ZEN_USER_';

export function isIdentityEnv(name: string): boolean {
    return name.startsWith(IDENTITY_ENV_PREFIX);
}

/**
 * Where a sandbox service is and the credential that reaches it — read by the
 * plugin that provides the sandbox, from the machine's environment only.
 */
export const SANDBOX_SERVICE_ENV_PREFIX = 'ZEN_SANDBOX_';

/**
 * Variables that are the host's alone: who a run acts for, which plugins load
 * into the engine, and which sandbox service it uses. A project that could set
 * one in a committed file — or forward one into the sandbox it runs code in —
 * could be anyone, run anything, or send its users' work anywhere.
 */
export function isHostOnlyEnv(name: string): boolean {
    return (
        isIdentityEnv(name) || name === 'ZEN_PLUGINS' || name.startsWith(SANDBOX_SERVICE_ENV_PREFIX)
    );
}

/** The identity as the variables a command sees; nothing at all when there is none. */
export function identityEnv(identity: RunIdentity | undefined): Record<string, string> {
    if (!identity) {
        return {};
    }
    const env: Record<string, string> = {
        [IDENTITY_ENV.id]: identity.id,
        [IDENTITY_ENV.source]: identity.source,
    };
    for (const key of ['email', 'name', 'role'] as const) {
        const value = identity[key];
        if (value) {
            env[IDENTITY_ENV[key]] = value;
        }
    }
    return env;
}

/**
 * Reads an identity back out of an environment — a `zen run` started inside a
 * sandbox inherits its parent's, which is what keeps a nested run acting for
 * the same person. Always `local`: a variable says what someone set, not who
 * checked it.
 */
export function identityFromEnv(env: NodeJS.ProcessEnv): RunIdentity | undefined {
    const id = env[IDENTITY_ENV.id]?.trim();
    if (!id) {
        return undefined;
    }
    const pick = (name: string): string | undefined => env[name]?.trim() || undefined;
    return compactIdentity({
        id,
        email: pick(IDENTITY_ENV.email),
        name: pick(IDENTITY_ENV.name),
        role: pick(IDENTITY_ENV.role),
        source: 'local',
    });
}

/** Drops the fields that say nothing, so `current_user` and the report show only what is known. */
export function compactIdentity(identity: RunIdentity): RunIdentity {
    return Object.fromEntries(
        Object.entries(identity).filter(([, v]) => v !== undefined && v !== ''),
    ) as unknown as RunIdentity;
}

/**
 * `current_user`. The description is the same whoever is signed in, so every chat on a
 * shared project keeps sending byte-identical tool schemas; who it is arrives
 * only in the result.
 */
export function identityTools<TCtx = unknown>(identity?: RunIdentity): AnyTool<TCtx>[] {
    const currentUser = tool<Record<string, never>, TCtx>({
        name: 'current_user',
        group: IDENTITY_GROUP,
        description:
            'Returns the signed-in user this run is acting for: id, and email, name and role ' +
            'when known. Use it when an answer depends on who is asking, instead of asking ' +
            'them or guessing. `source: "host"` means the application authenticated them; ' +
            '`"local"` means it was only stated on this machine. Code you run in the sandbox ' +
            `sees the same as $${IDENTITY_ENV.id}, $${IDENTITY_ENV.email}, $${IDENTITY_ENV.name} ` +
            `and $${IDENTITY_ENV.role}, or through the \`zenera\` library: ` +
            '`import zenera; zenera.identity()` in Python, `require("zenera").identity()` in Node.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () =>
            identity
                ? { authenticated: true, ...identity }
                : {
                      authenticated: false,
                      hint: 'this run has no signed-in user; do not assume one',
                  },
    });
    return [currentUser];
}
