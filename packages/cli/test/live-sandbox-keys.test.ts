import { buildSandbox, sessionPaths, stamp, type SandboxSetup } from '@zenera/engine';
import { DEFAULT_SANDBOX_IMAGE, runProcess, type ProjectConfig } from '@zenera/neo';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Credentials, all the way into a real container.
//
// The unit tests assert which arguments podman is handed. That is the wrong
// instrument for this: the whole point of forwarding a secret by name is that
// the value is *not* in the arguments, so argv inspection can prove the value
// is absent from the command line and nothing at all about whether it arrived.
// Only the engine can say that, and only a bind mount can say that a file the
// SDK opens by path is the file the host meant.
//
// So this asks the container: what is in your environment, what is at that
// path, what else came with it. It self-skips when no engine answers, and it
// is excluded by `npm test -- --exclude '**/live-*'`.
// ---------------------------------------------------------------------------

const IMAGE = process.env.ZENERA_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
const MINUTE = 60_000;

/** Nothing here reaches a provider, but it must still look like nothing else. */
const SECRET = 'sk-live-sandbox-0000-not-a-real-key';
const PROJECT = 'zenera-live-test';
const LOCATION = 'europe-west4';
const SERVICE_ACCOUNT = JSON.stringify(
    {
        type: 'service_account',
        project_id: PROJECT,
        client_email: 'nobody@example.invalid',
        private_key: 'not-a-key',
    },
    null,
    2,
);

/** `info` rather than `--version`: on macOS the binary exists long before the VM does. */
async function engineAnswers(): Promise<boolean> {
    try {
        const res = await runProcess('podman', ['info', '--format', '{{.Host.OS}}'], {
            timeoutMs: MINUTE,
        });
        return res.code === 0;
    } catch {
        return false;
    }
}

const ENABLED = await engineAnswers();

if (!ENABLED) {
    console.warn('[live-sandbox-keys] skipped: `podman info` did not answer');
}

describe.skipIf(!ENABLED)('the credentials a real container is given', () => {
    const kept = { ...process.env };
    // realpath matters on macOS, where the mkdtemp path is under a symlink
    // (/var -> /private/var) and the VM only shares the resolved one.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zn-live-keys-')));
    const gcp = join(dir, 'gcloud');
    const credential = join(gcp, 'creds.json');
    const beside = join(gcp, 'other-secret.txt');

    let forwarding: SandboxSetup;
    let withheld: SandboxSetup;

    const config: ProjectConfig = { version: 1, agents: [{ name: 'main' }] };

    /** The container's own record of how it was created — podman keeps the argv. */
    const createCommand = async (name: string): Promise<string[]> => {
        const res = await runProcess(
            'podman',
            ['container', 'inspect', name, '--format', '{{json .Config.CreateCommand}}'],
            { timeoutMs: MINUTE },
        );
        expect(res.code).toBe(0);
        return JSON.parse(res.stdout.trim()) as string[];
    };

    beforeAll(async () => {
        mkdirSync(gcp, { recursive: true });
        writeFileSync(credential, SERVICE_ACCOUNT);
        writeFileSync(beside, 'the file the user keeps next to their key\n');

        // A developer's own keys must neither decide what this asserts nor ride
        // into the container the test starts.
        for (const name of Object.keys(process.env)) {
            if (/_API_KEY$|^GOOGLE_APPLICATION_CREDENTIALS$|^GOOGLE_CLOUD_/.test(name)) {
                delete process.env[name];
            }
        }
        process.env.OPENAI_API_KEY = SECRET;
        process.env.GOOGLE_APPLICATION_CREDENTIALS = credential;
        process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
        process.env.GOOGLE_CLOUD_LOCATION = LOCATION;
        process.env.ZENERA_LIVE_NOISE = 'not a credential';

        const has = await runProcess('podman', ['image', 'exists', IMAGE], { timeoutMs: MINUTE });
        if (has.code !== 0) {
            const pull = await runProcess('podman', ['pull', IMAGE], { timeoutMs: 10 * MINUTE });
            if (pull.code !== 0) {
                throw new Error(`could not pull ${IMAGE}: ${pull.stderr.trim()}`);
            }
        }

        const build = (id: string, keys?: boolean): SandboxSetup => {
            const session = sessionPaths(dir, id);
            mkdirSync(session.workspace, { recursive: true });
            const setup = buildSandbox({
                config,
                session,
                workspace: session.workspace,
                root: dir,
                image: IMAGE,
                keys,
            });
            mkdirSync(setup.home, { recursive: true });
            return setup;
        };

        forwarding = build(stamp());
        withheld = build(stamp(), false);
    }, 12 * MINUTE);

    afterAll(async () => {
        await forwarding?.sandbox.close();
        await withheld?.sandbox.close();
        process.env = { ...kept };
        rmSync(dir, { recursive: true, force: true });
    }, 3 * MINUTE);

    it(
        'hands a secret over without writing it down anywhere',
        async () => {
            const box = forwarding.sandbox;
            expect((await box.exec('printf %s "$OPENAI_API_KEY"')).stdout).toBe(SECRET);

            // Which is the half argv cannot show. This is the other half: the
            // value is not in the command line any user on this machine can
            // list, only the name is.
            const argv = await createCommand(box.name);
            expect(argv).toContain('OPENAI_API_KEY');
            expect(JSON.stringify(argv)).not.toContain(SECRET);
        },
        3 * MINUTE,
    );

    it(
        'mounts the credential file, and nothing that was sitting beside it',
        async () => {
            const box = forwarding.sandbox;

            const at = (await box.exec('printf %s "$GOOGLE_APPLICATION_CREDENTIALS"')).stdout;
            expect(at).toBe('/run/zenera/keys/creds.json');

            const read = await box.exec('cat "$GOOGLE_APPLICATION_CREDENTIALS"');
            expect(read.exit_code).toBe(0);
            expect(read.stdout).toBe(SERVICE_ACCOUNT);

            // The directory it came from holds a second file, and the host path
            // is not reachable at all: one file was mounted, not a tree.
            expect((await box.exec('ls /run/zenera/keys')).stdout.trim()).toBe('creds.json');
            expect(
                (await box.exec(`[ -e '${gcp}' ] && echo visible || echo isolated`)).stdout,
            ).toBe('isolated\n');

            const write = await box.exec('printf x > "$GOOGLE_APPLICATION_CREDENTIALS"');
            expect(write.exit_code).not.toBe(0);
            expect(write.stderr.toLowerCase()).toContain('read-only');
        },
        3 * MINUTE,
    );

    it(
        'brings the two things a service account cannot say for itself',
        async () => {
            const box = forwarding.sandbox;
            const res = await box.exec(
                'printf "%s %s" "$GOOGLE_CLOUD_PROJECT" "$GOOGLE_CLOUD_LOCATION"',
            );
            expect(res.stdout).toBe(`${PROJECT} ${LOCATION}`);
        },
        MINUTE,
    );

    it(
        'forwards credentials and not the rest of the shell',
        async () => {
            const box = forwarding.sandbox;
            const absent = async (name: string): Promise<string> =>
                (await box.exec(`printf %s "\${${name}:-absent}"`)).stdout;

            expect(await absent('ANTHROPIC_API_KEY')).toBe('absent');
            expect(await absent('ZENERA_LIVE_NOISE')).toBe('absent');
        },
        MINUTE,
    );

    it(
        'gives a run that refused them a container with none of it',
        async () => {
            const box = withheld.sandbox;

            expect((await box.exec('printf %s "${OPENAI_API_KEY:-absent}"')).stdout).toBe('absent');
            expect(
                (await box.exec('printf %s "${GOOGLE_APPLICATION_CREDENTIALS:-absent}"')).stdout,
            ).toBe('absent');
            expect(
                (await box.exec('[ -d /run/zenera/keys ] && echo there || echo gone')).stdout,
            ).toBe('gone\n');

            // And it is a different container, not the same one with the
            // variables dropped: which credentials reach a box is part of what
            // that box *is*.
            expect(box.name).not.toBe(forwarding.sandbox.name);
        },
        3 * MINUTE,
    );
});
