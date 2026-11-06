// imageReady: the runtime's preflight. It asks the run's sandbox to ready its image without
// building, and turns what the sandbox says into an EngineError a chat can show.
import { EXIT, type SandboxSetup } from '@zenera/engine';
import { ImageBuildError, SandboxError, type PrepareOptions } from '@zenera/neo';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

const { configure, DEFAULTS } = await import('../src/config.ts');
configure({
    ...DEFAULTS,
    projectId: 'project',
    user: { id: 'u' },
    stateDir: mkdtempSync(join(tmpdir(), 'image-ready-')),
});
const { imageReady } = await import('../src/store.ts');

function setup(prepare: (opts?: PrepareOptions) => Promise<void>): {
    setup: SandboxSetup;
    asked: (PrepareOptions | undefined)[];
} {
    const asked: (PrepareOptions | undefined)[] = [];
    const sandbox = {
        prepare: (opts?: PrepareOptions) => {
            asked.push(opts);
            return prepare(opts);
        },
    };
    return {
        setup: { sandbox, image: 'localhost/zenera-sandbox:abc' } as unknown as SandboxSetup,
        asked,
    };
}

test('readies the image without ever building it', async () => {
    const s = setup(async () => {});
    await imageReady(s.setup);
    assert.deepEqual(s.asked, [{ allowBuild: false }]);
});

test('an image that would have to be built sends the user to the editor', async () => {
    const s = setup(async () => {
        throw new SandboxError(
            'the sandbox image localhost/zenera-sandbox:abc is not built',
            'zen sandbox up',
        );
    });
    await assert.rejects(imageReady(s.setup), {
        message: 'the sandbox image localhost/zenera-sandbox:abc is not built',
        code: EXIT.sandbox,
        hint: 'rebuild it from the project editor',
    });
});

test('any other failure keeps what the sandbox said, and its hint', async () => {
    const s = setup(async () => {
        throw new ImageBuildError('could not pull docker.io/x', 'check the image name');
    });
    await assert.rejects(imageReady(s.setup), {
        message: 'the sandbox image is not ready: could not pull docker.io/x',
        code: EXIT.sandbox,
        hint: 'check the image name',
    });
});
