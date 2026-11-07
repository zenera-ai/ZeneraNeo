import {
    createWriteStream,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import {
    ARCHIVE_FORMAT,
    collect,
    ENV_EXAMPLE,
    envExample,
    excluded,
    extractArchive,
    MANIFEST_FILE,
    readManifest,
    safeName,
    safePath,
    writeArchive,
    type ArchiveManifest,
} from '../src/archive.ts';
import { pack } from '../src/commands/export.ts';
import { unpack } from '../src/commands/import.ts';
import { CliError, EXIT } from '../src/term.ts';

// ---------------------------------------------------------------------------
// Archives
//
// Two halves that have to agree, and one of them reads a file a stranger sent.
// So the round trip is here — what went in comes out — and beside it the four
// refusals that matter: a path that walks out of the target, a path that was
// never under the project's directory, an entry claiming to be a symbolic
// link, and a zip that is simply not one of ours.
//
// The hostile archives are built by hand, because yazl will not write them:
// its own validation rejects a traversal on the way in, which is why the test
// writes a benign name of the same length and patches the bytes afterwards.
// ---------------------------------------------------------------------------

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zen-archive-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const put = (dir: string, rel: string, text: string): string => {
    const at = join(dir, rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
    return at;
};

/** A project with one of everything the rules have an opinion about. */
function fixture(dir: string): string {
    mkdirSync(dir, { recursive: true });
    put(dir, 'agents.yaml', 'version: 1\nagents:\n  - name: default\n    description: Entry.\n');
    put(dir, 'agents/prompts/default.md', '# default\n');
    put(dir, 'agents/instructions.md', '# house rules\n');
    put(dir, 'SPECIFICATION.md', '# spec\n');
    put(dir, 'SPECIFICATION-FEEDBACK.md', '# feedback\n');
    put(dir, 'assets/docs/one.md', 'one\n');
    put(dir, 'assets/docs-db/manifest.json', '{"documents":1}\n');
    put(dir, 'assets/docs-db/lance/data.bin', 'vectors');
    put(dir, 'memory/graph.json', '{"nodes":[]}\n');
    put(dir, 'memory/vectors.f32', 'floats');
    put(dir, 'memory/.lock', '{"pid":1,"host":"nowhere"}');
    put(dir, 'memory/memory.db-wal', 'log');
    put(dir, 'memory/memory.db-shm', 'index');
    put(dir, 'scripts/_setup.sh', '#!/bin/sh\necho hi\n');
    put(dir, 'sandbox/Dockerfile', 'FROM scratch\n');
    put(dir, '.github/skills/zen-cli/SKILL.md', '# skill\n');
    put(dir, '.vscode/settings.json', '{}\n');
    put(dir, '.env', '# what this needs\nOPENAI_API_KEY=sk-secret\nACME_BASE_URL=https://a.test\n');
    put(dir, 'sessions/20260101-120000-abcd/meta.json', '{}');
    put(dir, '.tmp/scratch.txt', 'x');
    put(dir, '.git/HEAD', 'ref: refs/heads/main\n');
    put(dir, 'node_modules/dep/index.js', '');
    put(dir, '.DS_Store', 'noise');
    return dir;
}

const paths = (dir: string, opts = {}): string[] => collect(dir, opts).files.map((f) => f.rel);

// ---------------------------------------------------------------------------
// What travels
// ---------------------------------------------------------------------------

describe('collecting a project', () => {
    it('carries the project', () => {
        const rels = paths(fixture(join(root, 'proj')));

        expect(rels).toContain('agents.yaml');
        expect(rels).toContain('agents/prompts/default.md');
        expect(rels).toContain('SPECIFICATION.md');
        expect(rels).toContain('assets/docs/one.md');
        expect(rels).toContain('memory/graph.json');
        expect(rels).toContain('scripts/_setup.sh');
        expect(rels).toContain('sandbox/Dockerfile');
        expect(rels).toContain('.github/skills/zen-cli/SKILL.md');
        expect(rels).toContain('.vscode/settings.json');
    });

    it('leaves behind what belongs to this machine', () => {
        const rels = paths(fixture(join(root, 'proj')));

        expect(rels.some((r) => r.startsWith('sessions/'))).toBe(false);
        expect(rels.some((r) => r.startsWith('.tmp/'))).toBe(false);
        expect(rels.some((r) => r.startsWith('.git/'))).toBe(false);
        expect(rels.some((r) => r.startsWith('node_modules/'))).toBe(false);
        expect(rels).not.toContain('.env');
        expect(rels).not.toContain('memory/.lock');
        expect(rels).not.toContain('memory/memory.db-wal');
        expect(rels).not.toContain('memory/memory.db-shm');
        expect(rels).not.toContain('.DS_Store');
    });

    // The one decision this whole feature turns on: memory has no other source.
    it('carries the vectors by default, and only those with --no-vectors', () => {
        const dir = fixture(join(root, 'proj'));

        expect(paths(dir)).toContain('assets/docs-db/lance/data.bin');

        const lean = paths(dir, { vectors: false });
        expect(lean).not.toContain('assets/docs-db/lance/data.bin');
        expect(lean).toContain('assets/docs-db/manifest.json');
        expect(lean).toContain('memory/graph.json');
    });

    it('drops memory entirely with --no-memory', () => {
        const rels = paths(fixture(join(root, 'proj')), { memory: false });

        expect(rels.some((r) => r.startsWith('memory/'))).toBe(false);
        expect(rels).toContain('agents.yaml');
    });

    it('counts what it left out, by reason', () => {
        const { skipped } = collect(fixture(join(root, 'proj')));

        expect(skipped).toMatchObject({ sessions: 1, scratch: 1, git: 1, env: 1, noise: 1 });
    });

    it('never follows a symbolic link', () => {
        const dir = fixture(join(root, 'proj'));
        const outside = put(root, 'elsewhere/secret.txt', 'not yours');
        symlinkSync(outside, join(dir, 'assets', 'link.txt'));

        const { files, skipped } = collect(dir);

        expect(files.some((f) => f.rel === 'assets/link.txt')).toBe(false);
        expect(skipped.links).toBe(1);
    });

    it('lists the same files in the same order twice', () => {
        const dir = fixture(join(root, 'proj'));

        expect(paths(dir)).toEqual(paths(dir));
    });

    // `sessions/` is run state only when it is *the* sessions directory; a
    // corpus is allowed to have a folder by that name.
    it('anchors the top-level rules at the top level', () => {
        expect(excluded('sessions', true)).toBe('sessions');
        expect(excluded('assets/docs/sessions', true)).toBeUndefined();
        expect(excluded('.env', false)).toBe('env');
        expect(excluded('.env.test', false)).toBe('env');
        expect(excluded('.env.example', false)).toBeUndefined();
        expect(excluded('assets/docs/.env', false)).toBeUndefined();
    });

    // The default destination is the working directory, which is normally the
    // project itself, so exporting twice must not pack the first archive.
    it('does not carry an archive left beside the project', () => {
        const dir = fixture(join(root, 'proj'));
        put(dir, 'proj-20260101-120000-abcd.zip', 'an earlier export');
        put(dir, 'assets/docs/bundle.zip', 'material');

        const { files, skipped } = collect(dir);

        expect(files.map((f) => f.rel)).not.toContain('proj-20260101-120000-abcd.zip');
        expect(files.map((f) => f.rel)).toContain('assets/docs/bundle.zip');
        expect(skipped.archives).toBe(1);
    });
});

describe('the .env example', () => {
    it('keeps the names and the comments, and no value', () => {
        const out = envExample('# what this needs\nOPENAI_API_KEY=sk-secret\nexport N=2\n');

        expect(out).toBe('# what this needs\nOPENAI_API_KEY=\nexport N=\n');
        expect(out).not.toContain('sk-secret');
    });

    it('drops the continuation of a quoted value rather than passing it through', () => {
        const out = envExample('KEY="line one\nline two"\nOTHER=x\n');

        expect(out).toBe('KEY=\nOTHER=\n');
        expect(out).not.toContain('line two');
    });
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('where an entry may be written', () => {
    const into = '/tmp/target';

    it('accepts a path under the project directory', () => {
        expect(safePath('proj/agents/prompts/a.md', 'proj', into)).toBe(
            join(into, 'agents/prompts/a.md'),
        );
    });

    it.each([
        ['../escape.txt', 'a traversal'],
        ['proj/../../escape.txt', 'a traversal through the root'],
        ['/etc/passwd', 'an absolute path'],
        ['C:\\windows\\x', 'a drive letter'],
        ['proj\\..\\x', 'a backslash'],
        ['other/a.txt', 'a different root'],
        ['proj', 'the root and nothing else'],
        ['proj//a.txt', 'an empty segment'],
        ['proj/a\u0000b.txt', 'a NUL byte'],
        ['proj/a\nb.txt', 'a newline'],
        ['proj/a\u001bb.txt', 'a terminal escape'],
        [`proj/${'a'.repeat(4096)}`, 'a name over the length bound'],
        [`proj/${'a/'.repeat(64)}x`, 'a path over the depth bound'],
        ['', 'nothing at all'],
    ])('refuses %s (%s)', (name) => {
        expect(safePath(name, 'proj', into)).toBeUndefined();
    });
});

describe('a name from an archive', () => {
    it('takes one a person would give a directory', () => {
        expect(safeName('docs-rag')).toBe('docs-rag');
        expect(safeName('My Project.v2')).toBe('My Project.v2');
    });

    it.each([['..'], ['.'], ['a/b'], ['a\\b'], ['-force'], ['a\nb'], ['a\u001bb'], ['']])(
        'refuses %j',
        (value) => {
            expect(safeName(value)).toBeUndefined();
        },
    );
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

const manifestFor = (over: Partial<ArchiveManifest> = {}): ArchiveManifest => ({
    format: ARCHIVE_FORMAT,
    name: 'proj',
    root: 'proj',
    exportedAt: new Date().toISOString(),
    cli: '0.0.0-test',
    vectors: true,
    memory: true,
    files: 0,
    bytes: 0,
    ...over,
});

describe('writing and reading an archive', () => {
    it('gives back every file, byte for byte', async () => {
        const dir = fixture(join(root, 'proj'));
        const zip = join(root, 'out.zip');
        const collected = collect(dir);
        await writeArchive({
            out: zip,
            root: 'proj',
            entries: collected.files,
            extra: new Map([[ENV_EXAMPLE, envExample(readFileSync(join(dir, '.env'), 'utf8'))]]),
            manifest: manifestFor({ files: collected.files.length }),
        });

        const into = join(root, 'copy');
        const taken = await extractArchive({ file: zip, into, root: 'proj' });

        expect(taken.files).toBe(collected.files.length + 1);
        expect(paths(into).filter((r) => r !== ENV_EXAMPLE)).toEqual(
            collected.files.map((f) => f.rel),
        );
        for (const file of collected.files) {
            expect(readFileSync(join(into, file.rel))).toEqual(readFileSync(file.abs));
        }
        expect(readFileSync(join(into, ENV_EXAMPLE), 'utf8')).not.toContain('sk-secret');
    });

    it('describes itself without unpacking anything', async () => {
        const zip = join(root, 'out.zip');
        await writeArchive({
            out: zip,
            root: 'proj',
            entries: [],
            manifest: manifestFor({ vectors: false, files: 0 }),
        });

        expect(await readManifest(zip)).toMatchObject({ name: 'proj', vectors: false });
    });

    it('refuses a zip that is not one of ours', async () => {
        const zip = await handmade(join(root, 'plain.zip'), (z) => {
            z.addBuffer(Buffer.from('hello'), 'proj/a.txt');
        });

        await expect(readManifest(zip)).rejects.toMatchObject({ code: EXIT.usage });
    });

    it('refuses an archive from a newer zen', async () => {
        const zip = join(root, 'out.zip');
        await writeArchive({
            out: zip,
            root: 'proj',
            entries: [],
            manifest: manifestFor({ format: ARCHIVE_FORMAT + 1 }),
        });

        await expect(readManifest(zip)).rejects.toMatchObject({ code: EXIT.invalid });
    });
});

// ---------------------------------------------------------------------------
// Hostile archives
// ---------------------------------------------------------------------------

describe('unpacking something a stranger sent', () => {
    it('refuses an entry that walks out of the target', async () => {
        // yazl will not write a traversal, so a benign name of exactly the
        // same length goes in and the bytes are patched afterwards — in the
        // local header and the central directory both.
        const zip = await handmade(join(root, 'evil.zip'), (z) => {
            z.addBuffer(Buffer.from(JSON.stringify(manifestFor())), MANIFEST_FILE);
            z.addBuffer(Buffer.from('pwned'), 'proj/xxxxxx.txt');
        });
        patch(zip, 'proj/xxxxxx.txt', '../../pwned.txt');

        await expect(
            extractArchive({ file: zip, into: join(root, 'copy'), root: 'proj' }),
        ).rejects.toThrow();
    });

    it('refuses an entry that was never under the project directory', async () => {
        const zip = await handmade(join(root, 'evil.zip'), (z) => {
            z.addBuffer(Buffer.from(JSON.stringify(manifestFor())), MANIFEST_FILE);
            z.addBuffer(Buffer.from('pwned'), 'proj/xx.txt');
        });
        patch(zip, 'proj/xx.txt', 'zzzz/xx.txt');

        await expect(
            extractArchive({ file: zip, into: join(root, 'copy'), root: 'proj' }),
        ).rejects.toMatchObject({ code: EXIT.invalid });
    });

    it('refuses an entry claiming to be a symbolic link', async () => {
        const zip = await handmade(join(root, 'link.zip'), (z) => {
            z.addBuffer(Buffer.from(JSON.stringify(manifestFor())), MANIFEST_FILE);
            z.addBuffer(Buffer.from('/etc/passwd'), 'proj/a.txt', { mode: 0o120777 });
        });

        await expect(
            extractArchive({ file: zip, into: join(root, 'copy'), root: 'proj' }),
        ).rejects.toMatchObject({ code: EXIT.invalid });
    });
});

/** A zip built entry by entry, for the archives `writeArchive` would not make. */
async function handmade(out: string, build: (zip: ZipFile) => void): Promise<string> {
    const zip = new ZipFile();
    const finished = pipeline(zip.outputStream as never, createWriteStream(out));
    build(zip);
    zip.end();
    await finished;
    return out;
}

/** Rewrites a file name in place. Same length, so every offset still holds. */
function patch(file: string, from: string, to: string): void {
    if (from.length !== to.length) {
        throw new Error(`patch needs the same length: ${from} / ${to}`);
    }
    const bytes = readFileSync(file);
    let at = bytes.indexOf(from);
    while (at >= 0) {
        bytes.write(to, at, 'utf8');
        at = bytes.indexOf(from, at + 1);
    }
    writeFileSync(file, bytes);
}

// ---------------------------------------------------------------------------
// The commands
//
// Driven through `run` with `--json`, which is the contract another program
// uses. `ZENERA_HOME` is set per test rather than once, because neighbouring
// suites snapshot and restore the whole environment.
// ---------------------------------------------------------------------------

describe('zen export and zen import', () => {
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'zen-home-'));
        process.env.ZENERA_HOME = home;
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        delete process.env.ZENERA_HOME;
    });

    async function run(command: typeof pack, cwd: string, ...args: string[]): Promise<any> {
        const out: string[] = [];
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: string | Uint8Array) => {
                out.push(String(chunk));
                return true;
            });
        const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await command.run({ args, json: true, cwd });
        } finally {
            write.mockRestore();
            quiet.mockRestore();
        }
        return out.length === 0 ? undefined : JSON.parse(out.join(''));
    }

    it('takes a project out of one directory and puts it in another', async () => {
        const dir = fixture(join(root, 'proj'));
        const zip = join(root, 'proj.zip');

        const exported = await run(pack, dir, '--out', zip);
        expect(exported).toMatchObject({ file: zip, project: 'proj', vectors: true });
        expect(exported.skipped).toMatchObject({ sessions: 1, env: 1 });

        const landing = mkdtempSync(join(tmpdir(), 'zen-landing-'));
        try {
            const imported = await run(unpack, landing, zip);
            const into = join(landing, 'proj');

            expect(imported).toMatchObject({ dir: into, name: 'proj', registered: true });
            expect(readFileSync(join(into, 'agents.yaml'), 'utf8')).toBe(
                readFileSync(join(dir, 'agents.yaml'), 'utf8'),
            );
            expect(readFileSync(join(into, 'memory/graph.json'), 'utf8')).toBe(
                readFileSync(join(dir, 'memory/graph.json'), 'utf8'),
            );
            expect(readFileSync(join(into, ENV_EXAMPLE), 'utf8')).toContain('OPENAI_API_KEY=');
            expect(readFileSync(join(into, ENV_EXAMPLE), 'utf8')).not.toContain('sk-secret');
            expect(readFileSync(join(home, 'projects.json'), 'utf8')).toContain('"proj"');
        } finally {
            rmSync(landing, { recursive: true, force: true });
        }
    });

    it('will not overwrite an archive that is already there', async () => {
        const dir = fixture(join(root, 'proj'));
        const zip = join(root, 'proj.zip');
        writeFileSync(zip, 'in the way');

        await expect(run(pack, dir, '--out', zip)).rejects.toMatchObject({
            code: EXIT.usage,
        });
    });

    it('will not unpack over a directory with something in it', async () => {
        const dir = fixture(join(root, 'proj'));
        const zip = join(root, 'proj.zip');
        await run(pack, dir, '--out', zip);
        put(root, 'landing/mine.txt', 'do not lose me');

        await expect(run(unpack, root, zip, join(root, 'landing'))).rejects.toBeInstanceOf(
            CliError,
        );
        expect(readFileSync(join(root, 'landing/mine.txt'), 'utf8')).toBe('do not lose me');
    });
});
