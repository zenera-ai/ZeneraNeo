// The project's env file, applied to this process before a chat turn opens its engine. Which file
// is the engine's choice: $ZEN_ENV_FILE when set (the manager sets .env.test, for test chats),
// .env otherwise (the runtime, for private chats).
// The engine only fills names that are not set yet, which in a long-lived process means the
// first value it read stays until the container restarts. Applying the file here first, and
// overwriting, makes an edit reach the next turn's sandbox: changed values replace the old ones,
// and names no longer in the file are removed. The pod's own variables (BIFROST_*, ZEN_*, HOME,
// PATH...) are never touched, so a project file cannot redirect the pod.
//   applyProjectEnv    - set what the file says, drop what it stopped saying
//   withoutProjectEnv  - an environment for a zen subprocess: none of that, and no ZEN_ENV_FILE,
//                        so a zen command run from the editor reads .env like it would anywhere
import { ENV_FILE_ENV, readProjectEnv } from '@zenera/engine';
import { settings } from './config.ts';

const POD_ENV = new Set(Object.keys(process.env));
let applied = new Set<string>();

export function applyProjectEnv(): void {
    const values = readProjectEnv(settings().projectDir)?.values ?? {};
    for (const name of applied) {
        if (!(name in values)) delete process.env[name];
    }
    applied = new Set();
    for (const [name, value] of Object.entries(values)) {
        if (POD_ENV.has(name)) continue;
        process.env[name] = value;
        applied.add(name);
    }
}

export function withoutProjectEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out = { ...env };
    for (const name of applied) delete out[name];
    delete out[ENV_FILE_ENV];
    return out;
}
