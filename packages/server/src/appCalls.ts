// A page's calls to the Python functions of its `*.api.py` files, as zen server (@zenera/server)
// runs them: the thread's sandbox, opened as its turns open theirs, acting for the caller
// (@zenera/engine appCalls.ts does the rest: one sandbox kept per thread, limits, answers).
//
// Main functions:
//   appCalls          - the server's AppCalls: sandboxes opened with the server's sandbox and
//                       preflight, writes marked as the user's data changed (userState.ts)
//   closeAppSandboxes - closes every kept sandbox (server stop)
// Used by: views.ts (/v/ in insecure mode, /api/sessions/:tid/view/* in jwt mode); server.ts.
import { AppCalls, openSessionSandbox } from '@zenera/engine';
import { settings } from './config.ts';
import { applyProjectEnv } from './projectEnv.ts';
import { imageReady, serverSandbox } from './store.ts';
import { userStates } from './userState.ts';

let current: AppCalls | undefined;

export function appCalls(): AppCalls {
    current ??= new AppCalls({
        open: async (t, user) => {
            applyProjectEnv();
            const setup = await openSessionSandbox({
                projectDir: settings().projectDir,
                session: t.session,
                user,
                newSandbox: serverSandbox(),
                provider: settings().sandboxProvider,
            });
            await (settings().preflight ?? imageReady)(setup);
            return setup;
        },
        changed: (t) => userStates.changed(t.owner, 'changed'),
        warn: (message, detail) => console.warn(message, detail),
    });
    return current;
}

export async function closeAppSandboxes(): Promise<void> {
    const calls = current;
    current = undefined;
    await calls?.close();
}
