import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveView, startView } from '../src/meta/finetune/view.ts';

describe('the tuning in a browser', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('serves the project from STATUS.md, and says where while it does', async () => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'zenera-finetune-view-')));
        mkdirSync(join(dir, 'finetune'));
        writeFileSync(join(dir, 'finetune', 'STATUS.md'), '# Fine-tuning\n');
        expect(liveView(dir)).toBeUndefined();

        const viewing = await startView(dir);
        expect(viewing.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/finetune\/STATUS\.md$/);
        expect(liveView(dir)).toBe(viewing.url);
        const page = await fetch(viewing.url);
        expect(page.status).toBe(200);
        const render = await fetch(new URL('/_view/render?path=/finetune/STATUS.md', viewing.url));
        expect(((await render.json()) as { title: string }).title).toBe('Fine-tuning');

        await viewing.close();
        expect(existsSync(join(dir, 'finetune', 'view.json'))).toBe(false);
        expect(liveView(dir)).toBeUndefined();
    });
});
