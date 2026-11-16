import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
    attachmentsText,
    cleanFileName,
    cleanMimeType,
    commitUploads,
    discardUpload,
    stagedUpload,
    stageUpload,
    sweepUploads,
    UploadError,
    type UploadPlaces,
} from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function places(): UploadPlaces {
    const root = mkdtempSync(join(tmpdir(), 'zen-uploads-'));
    dirs.push(root);
    const workspace = join(root, 'workspace');
    return {
        staging: join(root, '.data', 'uploads'),
        dir: join(workspace, 'uploads'),
        workspace,
        workdir: '/workspace',
    };
}

const stage = (p: UploadPlaces, name: string, body = 'hello', mimeType = 'text/plain') =>
    stageUpload(p.staging, Readable.from([Buffer.from(body)]), { name, mimeType });

describe('file names', () => {
    it('keeps only a safe base name', () => {
        expect(cleanFileName('../../etc/passwd')).toBe('passwd');
        expect(cleanFileName('C:\\Users\\ann\\report.pdf')).toBe('report.pdf');
        expect(cleanFileName('.env')).toBe('env');
        expect(cleanFileName('a\u0000b\nc.txt')).toBe('abc.txt');
        expect(cleanFileName('..')).toBe('file');
        expect(cleanFileName('  ')).toBe('file');
        expect(cleanFileName('trailing. ')).toBe('trailing');
    });

    it('shortens a long name to 200 bytes and keeps its extension', () => {
        const name = cleanFileName(`${'я'.repeat(300)}.pdf`);
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
        expect(name.endsWith('.pdf')).toBe(true);
    });

    it('takes a plausible MIME type and nothing else', () => {
        expect(cleanMimeType('Application/PDF; charset=x')).toBe('application/pdf');
        expect(cleanMimeType('not a type')).toBe('application/octet-stream');
        expect(cleanMimeType(undefined)).toBe('application/octet-stream');
    });
});

describe('staging', () => {
    it('stores the bytes with their name, type, size and hash', async () => {
        const p = places();
        const up = await stage(p, 'notes.txt');
        expect(up).toMatchObject({ name: 'notes.txt', size: 5, mimeType: 'text/plain' });
        expect(up.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
        expect(stagedUpload(p.staging, up.id)).toEqual(up);
        expect(discardUpload(p.staging, up.id)).toBe(true);
        expect(stagedUpload(p.staging, up.id)).toBeUndefined();
        expect(discardUpload(p.staging, up.id)).toBe(false);
    });

    it('refuses a file over the cap and leaves nothing behind', async () => {
        const p = places();
        const body = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]);
        await expect(
            stageUpload(p.staging, body, { name: 'big.bin', maxBytes: 10 }),
        ).rejects.toMatchObject({ code: 'too_large' });
        expect(readdirSync(p.staging)).toEqual([]);
    });

    it('never treats an id as a path', () => {
        const p = places();
        expect(stagedUpload(p.staging, '../../etc/passwd')).toBeUndefined();
        expect(discardUpload(p.staging, '../x')).toBe(false);
    });

    it('sweeps files left waiting too long', async () => {
        const p = places();
        const old = await stage(p, 'old.txt');
        const fresh = await stage(p, 'fresh.txt');
        const then = new Date(Date.now() - 2 * 60 * 60 * 1000);
        for (const ext of ['bin', 'json']) {
            utimesSync(join(p.staging, `${old.id}.${ext}`), then, then);
        }
        expect(sweepUploads(p.staging, 60 * 60 * 1000)).toBe(1);
        expect(stagedUpload(p.staging, old.id)).toBeUndefined();
        expect(stagedUpload(p.staging, fresh.id)).toBeDefined();
    });
});

describe('sending', () => {
    it('moves a message’s files into one folder, numbering repeated names', async () => {
        const p = places();
        const a = await stage(p, 'report.pdf', 'a', 'application/pdf');
        const b = await stage(p, 'report.pdf', 'b', 'application/pdf');
        const c = await stage(p, 'data.csv', 'c,d', 'text/csv');
        const files = commitUploads(p, [a.id, b.id, c.id], '20261116-184500-a7f3');
        expect(files.map((f) => f.path)).toEqual([
            '/workspace/uploads/20261116-184500-a7f3/report.pdf',
            '/workspace/uploads/20261116-184500-a7f3/report (2).pdf',
            '/workspace/uploads/20261116-184500-a7f3/data.csv',
        ]);
        expect(readFileSync(files[1].file, 'utf8')).toBe('b');
        expect(readdirSync(p.staging)).toEqual([]);
    });

    it('moves nothing when one of the files is gone', async () => {
        const p = places();
        const a = await stage(p, 'a.txt');
        const err = (() => {
            try {
                commitUploads(p, [a.id, 'ffffffffffffffffffffffff']);
            } catch (e) {
                return e;
            }
        })();
        expect(err).toBeInstanceOf(UploadError);
        expect((err as UploadError).code).toBe('gone');
        expect(stagedUpload(p.staging, a.id)).toBeDefined();
        expect(existsSync(p.dir)).toBe(false);
    });

    it('names a folder inside the workspace by the sandbox’s path to it', async () => {
        const p = places();
        p.dir = join(p.workspace, '.tmp', 'chats', 'c1', 'uploads');
        const a = await stage(p, 'a.txt');
        const [file] = commitUploads(p, [a.id], 'b1');
        expect(file.path).toBe('/workspace/.tmp/chats/c1/uploads/b1/a.txt');
    });

    it('tells the agent the text, then each file with its type and size', () => {
        const files = [
            { path: '/workspace/uploads/b/report.pdf', mimeType: 'application/pdf', size: 1234567 },
            { path: '/workspace/uploads/b/data.csv', mimeType: 'text/csv', size: 512 },
        ];
        expect(attachmentsText('Compare these', files)).toBe(
            [
                'Compare these',
                '',
                '<attachments>',
                '- /workspace/uploads/b/report.pdf (application/pdf, 1.2 MB)',
                '- /workspace/uploads/b/data.csv (text/csv, 512 B)',
                '</attachments>',
            ].join('\n'),
        );
        expect(attachmentsText('', files.slice(1))).toBe(
            '<attachments>\n- /workspace/uploads/b/data.csv (text/csv, 512 B)\n</attachments>',
        );
        expect(attachmentsText('just text', [])).toBe('just text');
    });
});
