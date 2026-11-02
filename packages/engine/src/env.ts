import { isIdentityEnv } from '@zenera/neo';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { FILE_ENVS } from './keys.ts';

// ---------------------------------------------------------------------------
// The project's `.env`
//
// A project is a directory, and some of what it needs to run is particular to
// it: the token for the service it talks to, the base url of the environment
// it talks to it in. The keyring answers "what can this machine pay for"; this
// answers "what does this project need", and the two are different questions
// often enough to be worth two places.
//
// Precedence is the same one everything else here uses — the real environment
// always wins. What is already set in the shell is left alone, this file fills
// the gaps, and the keyring fills whatever is still missing after that. So a
// variable exported for one command still overrides the file, which is the
// behaviour anybody typing `FOO=bar zen run` is expecting.
//
// The names, not the values, are what leaves this module: they are what the
// sandbox forwards, and forwarding by name is what keeps a secret out of an
// argv. See `forwarded()` in sandbox.ts for the rest of that story.
// ---------------------------------------------------------------------------

/** The file, relative to the project directory. */
export const ENV_FILE = '.env';

/**
 * Names another file to read instead of `.env` — relative to the project
 * directory, or absolute. A host running the same project for different
 * purposes points each process at its own file this way.
 */
export const ENV_FILE_ENV = 'ZEN_ENV_FILE';

export interface ProjectEnv {
    /** the file it was read from */
    path: string;
    /** every name the file declares, whether or not its value won */
    names: string[];
    /** what the file says, credential paths made absolute */
    values: Record<string, string>;
    /**
     * Names the file declared and was not allowed to: `ZEN_USER_*` says who a
     * run is acting for, and only the host gets to say that. A project that
     * could set it in a committed file could be anyone it liked.
     */
    refused: string[];
}

/** The env file a project in `dir` reads: `$ZEN_ENV_FILE` when set, `.env` otherwise. */
export function projectEnvPath(dir: string): string {
    return resolve(dir, process.env[ENV_FILE_ENV]?.trim() || ENV_FILE);
}

/**
 * Reads the project's env file without touching `process.env`. `undefined`
 * when there is no such file.
 */
export function readProjectEnv(dir: string): ProjectEnv | undefined {
    const path = projectEnvPath(dir);
    if (!existsSync(path)) {
        return undefined;
    }
    const values: Record<string, string> = {};
    const refused: string[] = [];
    for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
        if (isIdentityEnv(name)) {
            refused.push(name);
        } else if (value !== undefined) {
            values[name] = located(dir, name, value);
        }
    }
    return { path, names: Object.keys(values), values, refused };
}

/**
 * Reads the project's env file (`.env`, or `$ZEN_ENV_FILE`) into
 * `process.env`, without overwriting anything already set, and returns the
 * names it found. A project with no such file is not a problem to report —
 * most have none — so the answer is simply `undefined`.
 *
 * The names are returned in full, including the ones the environment already
 * answered: the variable is in play either way, and the sandbox forwards by
 * name, so what it needs to know is which names matter and not which of the
 * two sources supplied them.
 */
export function loadProjectEnv(dir: string): ProjectEnv | undefined {
    const env = readProjectEnv(dir);
    for (const [name, value] of Object.entries(env?.values ?? {})) {
        // An empty string is not an answer: tools test for absence, and a
        // commented-out line someone half-filled in should not shadow a key
        // the keyring has.
        if (!process.env[name]) {
            process.env[name] = value;
        }
    }
    return env;
}

/**
 * A service-account file is normally kept beside the `.env` that names it, so
 * a relative path there means relative to the *project* — not to wherever the
 * command happened to be run, which is what both the Google SDK and podman's
 * bind mount would otherwise make of it.
 */
function located(dir: string, name: string, value: string): string {
    return FILE_ENVS.includes(name) && !isAbsolute(value) ? resolve(dir, value) : value;
}
