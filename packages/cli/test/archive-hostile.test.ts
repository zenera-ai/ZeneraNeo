import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { extractArchive, readManifest } from '../src/archive.ts';
import { unpack } from '../src/commands/import.ts';
import { CliError, EXIT } from '../src/term.ts';
import { buildHostileArchives, type HostileCase } from './support/hostile-archives.ts';

// ---------------------------------------------------------------------------
// Hostile archives
//
// Every archive here is one the exporter would never write. The question is
// not only "does it throw" but "what is on disk when it does": a refusal after
// the first file has landed is a refusal that left something behind.
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'zen-hostile-'));
const cases = await buildHostileArchives(join(root, 'archives'));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const one = (id: string): HostileCase => {
    const found = cases.find((c) => c.id === id);
    if (!found) {
        throw new Error(`no hostile archive named ${id}`);
    }
    return found;
};

/** Every path under a directory, with `/` separators, sorted. */
function filesUnder(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    const out: string[] = [];
    const walk = (at: string, rel: string): void => {
        for (const entry of readdirSync(at, { withFileTypes: true })) {
            const child = join(at, entry.name);
            const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(child, path);
            } else {
                out.push(path);
            }
        }
    };
    walk(dir, '');
    return out.sort();
}

/** A fresh target under the case's own directory, so escapes are visible. */
function target(id: string): string {
    return join(mkdtempSync(join(root, `case-${id}-`)), 'target');
}

const refused = (): HostileCase[] =>
    cases.filter((c) => c.expect === 'refused' && c.id !== 'manifest-traversal');

describe('refusing a stranger’s archive', () => {
    for (const c of refused()) {
        it(`refuses ${c.id}`, async () => {
            const into = target(c.id);

            await expect(
                extractArchive({ file: c.file, into, root: 'proj', limits: c.limits }),
            ).rejects.toMatchObject({ code: EXIT.invalid });

            expect(filesUnder(into)).toEqual([]);
            // A traversal that got through would land beside the target.
            expect(existsSync(join(root, 'pwned.txt'))).toBe(false);
        });
    }

    it('names the case collision rather than overwriting one entry with the other', async () => {
        const c = one('case-collision');

        await expect(
            extractArchive({ file: c.file, into: target(c.id), root: 'proj' }),
        ).rejects.toThrow(/differ only in case/);
    });

    it('names a duplicate path rather than letting the last writer win', async () => {
        const c = one('duplicate-path');

        await expect(
            extractArchive({ file: c.file, into: target(c.id), root: 'proj' }),
        ).rejects.toThrow(/twice/);
    });

    it('refuses a file that is also a directory', async () => {
        const c = one('file-dir-collision');

        await expect(
            extractArchive({ file: c.file, into: target(c.id), root: 'proj' }),
        ).rejects.toThrow(/both a file and a directory/);
    });

    it('refuses a manifest that names a path outside the target', async () => {
        await expect(readManifest(one('manifest-traversal').file)).rejects.toMatchObject({
            code: EXIT.invalid,
        });
    });
});

describe('what a refusal leaves behind', () => {
    it('writes nothing when a benign entry comes before a hostile one', async () => {
        const c = one('partial-write');
        const into = target(c.id);

        await expect(extractArchive({ file: c.file, into, root: 'proj' })).rejects.toMatchObject({
            code: EXIT.invalid,
        });

        expect(filesUnder(into)).toEqual([]);
    });

    it('does not touch files that were already in the target', async () => {
        const into = target('existing');
        mkdirSync(into, { recursive: true });
        writeFileSync(join(into, 'mine.txt'), 'do not lose me\n');

        await expect(
            extractArchive({
                file: one('traversal-parent').file,
                into,
                root: 'proj',
            }),
        ).rejects.toMatchObject({ code: EXIT.invalid });

        expect(readFileSync(join(into, 'mine.txt'), 'utf8')).toBe('do not lose me\n');
        expect(filesUnder(into)).toEqual(['mine.txt']);
    });
});

describe('what an accepted archive leaves behind', () => {
    it('accepts a compressible payload below the byte limit, and says so in the report', async () => {
        const c = one('bomb-under-limit');
        const into = target(c.id);

        const taken = await extractArchive({ file: c.file, into, root: 'proj' });

        expect(taken.files).toBe(1);
        expect(filesUnder(into)).toEqual(['bomb.bin']);
        expect(statSync(join(into, 'bomb.bin')).size).toBe(1024 * 1024);
    });

    it('replaces the archive’s claim with a mode it chose', async () => {
        for (const c of cases.filter((one) => one.expect === 'accepted' && one.modes)) {
            const into = target(c.id);
            await extractArchive({ file: c.file, into, root: 'proj' });

            for (const [rel, expected] of Object.entries(c.modes ?? {})) {
                const mode = statSync(join(into, rel)).mode & 0o7777;
                expect(mode & 0o7000, `${rel} kept a setuid/setgid/sticky bit`).toBe(0);
                if (process.platform !== 'win32') {
                    expect(mode, `${rel} does not have the mode zen chose`).toBe(expected);
                }
                if (expected === 0o755) {
                    expect(mode & 0o111, `${rel} is not executable`).not.toBe(0);
                } else {
                    expect(mode & 0o111, `${rel} is executable`).toBe(0);
                }
            }
        }
    });

    it('replaces the mode of a file that was already in the target', async () => {
        const c = one('mode-setuid');
        const into = target('mode-existing');
        mkdirSync(into, { recursive: true });
        const at = join(into, 'tool');
        writeFileSync(at, 'old\n');
        chmodSync(at, 0o777);

        await extractArchive({ file: c.file, into, root: 'proj' });

        if (process.platform !== 'win32') {
            expect(statSync(at).mode & 0o7777).toBe(0o644);
        }
    });

    it('does not materialise an empty directory entry', async () => {
        const c = one('empty-dirs');
        const into = target(c.id);

        const taken = await extractArchive({ file: c.file, into, root: 'proj' });

        expect(taken.files).toBe(0);
        expect(filesUnder(into)).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')(
        'accepts names Windows cannot represent, as a documented residual risk',
        async () => {
            const c = one('windows-names');
            const into = target(c.id);

            await extractArchive({ file: c.file, into, root: 'proj' });

            expect(filesUnder(into)).toEqual(['C:/x', 'CON', 'aux.txt', 'name.']);
        },
    );
});

// ---------------------------------------------------------------------------
// The command, not just the guard
// ---------------------------------------------------------------------------

describe('zen import on a hostile archive', () => {
    async function run(cwd: string, ...args: string[]): Promise<any> {
        const out: string[] = [];
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: string | Uint8Array) => {
                out.push(String(chunk));
                return true;
            });
        const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await unpack.run({ args, json: true, cwd });
        } finally {
            write.mockRestore();
            quiet.mockRestore();
        }
        return out.length === 0 ? undefined : JSON.parse(out.join(''));
    }

    /** A home of its own, with any developer-supplied one restored afterwards. */
    async function withHome<T>(body: () => Promise<T>): Promise<T> {
        const home = mkdtempSync(join(root, 'home-'));
        const previous = process.env.ZENERA_HOME;
        process.env.ZENERA_HOME = home;
        try {
            return await body();
        } finally {
            if (previous === undefined) {
                delete process.env.ZENERA_HOME;
            } else {
                process.env.ZENERA_HOME = previous;
            }
            rmSync(home, { recursive: true, force: true });
        }
    }

    it('reports a refusal and leaves the target empty', async () => {
        await withHome(async () => {
            const c = one('traversal-parent');
            const into = target('command-refused');

            await expect(run(root, c.file, into, '--no-register')).rejects.toBeInstanceOf(CliError);
            expect(filesUnder(into)).toEqual([]);
        });
    });

    it('imports an archive that stays inside the policy', async () => {
        await withHome(async () => {
            const c = one('bomb-under-limit');
            const into = target('command-accepted');

            const imported = await run(root, c.file, into, '--no-register');

            expect(imported).toMatchObject({
                dir: into,
                name: 'proj',
                files: 1,
                registered: false,
            });
            expect(filesUnder(into)).toEqual(['bomb.bin']);
        });
    });
});
