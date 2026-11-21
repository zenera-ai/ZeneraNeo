import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';

// ---------------------------------------------------------------------------
// Hostile archives
//
// `zen export` will not write any of these: yazl validates names on the way
// out, and the exporter never emits a symlink, a directory entry, a duplicate
// or a second root. So each archive starts as something the writer accepts and
// is patched afterwards: names in the local header and the central directory
// both, sizes in the central directory, with a name or a size of exactly the
// same length so every offset still holds.
//
// The catalogue is data. The tests and the report generator import it, so the
// bytes in the report are the bytes in the tests.
// ---------------------------------------------------------------------------

/** Kept in step with `ARCHIVE_FORMAT`; this module must not import the CLI's
 * dependency graph just to build a fixture. */
const FORMAT = 1;

export const MANIFEST = 'zenera-export.json';
export const ROOT = 'proj';

export interface Limits {
    entries?: number;
    bytes?: number;
}

export interface HostileCase {
    /** stable name, also the archive's file name */
    id: string;
    /** what a person should read first */
    title: string;
    /** why this shape is dangerous */
    why: string;
    /** what the importer ought to do */
    expect: 'refused' | 'accepted';
    /** the generated archive */
    file: string;
    /** only for the cases that would otherwise need a gigabyte to build */
    limits?: Limits;
    /** files expected under the landing directory when the archive is accepted */
    lands?: string[];
    /** expected permission bits, relative path -> mode & 0o7777 */
    modes?: Record<string, number>;
}

interface Manifest {
    format: number;
    name: string;
    root: string;
    exportedAt: string;
    cli: string;
    vectors: boolean;
    memory: boolean;
    files: number;
    bytes: number;
}

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
    format: FORMAT,
    name: ROOT,
    root: ROOT,
    exportedAt: '2026-01-01T00:00:00.000Z',
    cli: '0.0.0-hostile',
    vectors: true,
    memory: true,
    files: 0,
    bytes: 0,
    ...over,
});

const addManifest = (zip: ZipFile, over: Partial<Manifest> = {}): void => {
    zip.addBuffer(Buffer.from(JSON.stringify(manifest(over))), MANIFEST, { mode: 0o100644 });
};

/** A zip built entry by entry, for the archives yazl would not write. */
async function handmade(out: string, build: (zip: ZipFile) => void): Promise<void> {
    mkdirSync(dirname(out), { recursive: true });
    const zip = new ZipFile();
    const finished = pipeline(zip.outputStream as never, createWriteStream(out));
    build(zip);
    zip.end();
    await finished;
}

/** Rewrites a name in place. Same length, so every offset still holds. */
function patchName(file: string, from: string, to: string): void {
    if (from.length !== to.length) {
        throw new Error(`patch needs the same length: ${from} / ${to}`);
    }
    const bytes = readFileSync(file);
    const needle = Buffer.from(from);
    let at = bytes.indexOf(needle);
    while (at >= 0) {
        bytes.write(to, at, 'utf8');
        at = bytes.indexOf(needle, at + 1);
    }
    writeFileSync(file, bytes);
}

/**
 * Rewrites the uncompressed size a central/local header declares. The data is
 * untouched, which is exactly what a declared bomb is: a tiny file that says
 * it expands to gigabytes. The importer's preflight must refuse it before it
 * opens a stream, because a decompressor is not the place to discover it.
 */
function patchSize(file: string, name: string, size: number): void {
    const bytes = readFileSync(file);
    const needle = Buffer.from(name);
    let at = bytes.indexOf(needle);
    while (at >= 0) {
        // The central directory is what a reader trusts for the sizes. The
        // local header is left alone: with a streamed entry its sizes are zero
        // and live in the data descriptor, and changing them adds nothing.
        if (at >= 46 && bytes.readUInt32LE(at - 46) === 0x02014b50) {
            bytes.writeUInt32LE(size, at - 46 + 24);
        }
        at = bytes.indexOf(needle, at + 1);
    }
    writeFileSync(file, bytes);
}

/** Sets a general-purpose bit, which is how a zip says an entry is encrypted. */
function patchFlag(file: string, name: string, flag: number): void {
    const bytes = readFileSync(file);
    const needle = Buffer.from(name);
    let at = bytes.indexOf(needle);
    while (at >= 0) {
        if (at >= 46 && bytes.readUInt32LE(at - 46) === 0x02014b50) {
            const offset = at - 46 + 8;
            bytes.writeUInt16LE(bytes.readUInt16LE(offset) | flag, offset);
        }
        if (at >= 30 && bytes.readUInt32LE(at - 30) === 0x04034b50) {
            const offset = at - 30 + 6;
            bytes.writeUInt16LE(bytes.readUInt16LE(offset) | flag, offset);
        }
        at = bytes.indexOf(needle, at + 1);
    }
    writeFileSync(file, bytes);
}

/** A file of zeroes that deflate can shrink a thousandfold. */
const zeros = (bytes: number): Buffer => Buffer.alloc(bytes, 0);

/**
 * Writes a zip with `count` empty entries, by hand.
 *
 * yazl is happy to describe a few thousand entries but its pump recurses once
 * per entry, so two hundred thousand of them overflows the stack. An archive
 * that only has to be *read* does not need a compressor: local headers with no
 * data, a central directory, and the Zip64 records the 16-bit end record
 * cannot hold. This is also what makes the full flood cheap to build.
 */
function writeFlood(out: string, kind: 'files' | 'dirs', count: number): void {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (let i = 0; i < count; i += 1) {
        const name = Buffer.from(kind === 'dirs' ? `proj/d${i}/` : `proj/f${i}.txt`);
        const mode = kind === 'dirs' ? 0o040755 : 0o100644;

        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt16LE(0, 10); // time
        local.writeUInt16LE(0, 12); // date
        local.writeUInt32LE(0, 14); // crc
        local.writeUInt32LE(0, 18); // compressed size
        local.writeUInt32LE(0, 22); // uncompressed size
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        name.copy(local, 30);
        locals.push(local);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x031e, 4); // made by unix, version 30
        central.writeUInt16LE(20, 6);
        // flags, method, time, date, crc and both sizes stay zero
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE((mode << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);
        centrals.push(central);

        offset += local.length;
    }

    const centralSize = centrals.reduce((n, b) => n + b.length, 0);

    const zip64 = Buffer.alloc(56);
    zip64.writeUInt32LE(0x06064b50, 0);
    zip64.writeBigUInt64LE(44n, 4);
    zip64.writeUInt16LE(45, 12);
    zip64.writeUInt16LE(45, 14);
    zip64.writeUInt32LE(0, 16);
    zip64.writeUInt32LE(0, 20);
    zip64.writeBigUInt64LE(BigInt(count), 24);
    zip64.writeBigUInt64LE(BigInt(count), 32);
    zip64.writeBigUInt64LE(BigInt(centralSize), 40);
    zip64.writeBigUInt64LE(BigInt(offset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset + centralSize), 8);
    locator.writeUInt32LE(1, 16);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.concat([...locals, ...centrals, zip64, locator, eocd]));
}

export interface BuildOptions {
    /**
     * Build the real thing: two hundred thousand entries and a bomb measured
     * in megabytes. Tests leave this off and shrink the limit instead, so the
     * suite stays fast while the report still exercises the production bound.
     */
    full?: boolean;
}

export async function buildHostileArchives(
    dir: string,
    opts: BuildOptions = {},
): Promise<HostileCase[]> {
    const cases: HostileCase[] = [];
    const full = opts.full === true;

    const add = async (
        id: string,
        title: string,
        why: string,
        expect: 'refused' | 'accepted',
        build: (zip: ZipFile) => void,
        patch?: (file: string) => void,
        extra: Pick<HostileCase, 'limits' | 'lands' | 'modes'> = {},
    ): Promise<void> => {
        const file = join(dir, `${id}.zip`);
        await handmade(file, build);
        patch?.(file);
        cases.push({ id, title, why, expect, file, ...extra });
    };

    // -- the target ---------------------------------------------------------

    await add(
        'traversal-parent',
        'A path that walks out of the target',
        'The classic zip-slip: the entry name contains `..`, so a naive reader writes beside the destination.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('pwned'), 'proj/xxxxxx.txt');
        },
        (f) => patchName(f, 'proj/xxxxxx.txt', '../../pwned.txt'),
    );

    await add(
        'traversal-absolute',
        'An absolute path',
        '`/etc/passwd` is not a project file, whatever the manifest says.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('pwned'), 'proj/xxxxxx');
        },
        (f) => patchName(f, 'proj/xxxxxx', '/etc/passwd'),
    );

    await add(
        'traversal-backslash',
        'A Windows separator in the name',
        'A reader that normalises `\\` to `/` after checking the path has already lost the argument.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('pwned'), 'proj/xxxxxxxx');
        },
        (f) => patchName(f, 'proj/xxxxxxxx', 'proj\\..\\pwned'),
    );

    await add(
        'wrong-root',
        'An entry outside the manifest root',
        'The manifest names one directory; an entry from another one was not written by the exporter.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('pwned'), 'proj/xx.txt');
        },
        (f) => patchName(f, 'proj/xx.txt', 'zzzz/xx.txt'),
    );

    // -- entry types --------------------------------------------------------

    await add(
        'symlink-file',
        'A symbolic link to /etc/passwd',
        'Writing a link is writing a path the extractor never checked.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('/etc/passwd'), 'proj/a.txt', { mode: 0o120777 });
        },
    );

    await add(
        'symlink-dir',
        'A symbolic link shaped like a directory',
        'The trailing slash makes a naive reader treat it as a directory entry, which is often skipped before the mode is checked.',
        'refused',
        (z) => {
            addManifest(z);
            z.addEmptyDirectory('proj/link/', { mode: 0o120777 });
        },
    );

    await add(
        'fifo-entry',
        'A fifo that claims to be a file',
        'Only regular files and directories belong in a project archive. A fifo is a different kind of object and must not be materialised.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('pipe'), 'proj/fifo', { mode: 0o010644 });
        },
    );

    await add(
        'dir-mode-no-slash',
        'A directory mode on a file name',
        'The type bits say directory and the name says file; the two disagree, so the entry is not trustworthy.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.alloc(0), 'proj/weird', { mode: 0o040755 });
        },
    );

    await add(
        'encrypted',
        'An encrypted entry',
        'This tool does not write encrypted entries, so it cannot tell what this one contains.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('ciphertext'), 'proj/secret.txt');
        },
        (f) => patchFlag(f, 'proj/secret.txt', 0x0001),
    );

    // -- counts and sizes ---------------------------------------------------

    // The full flood is one entry over the production bound and is written by
    // hand: yazl recurses per entry, and two hundred thousand is more than a
    // stack can take. Tests shrink the bound instead of the archive, which is
    // why the quick cases carry a limit at all.
    const floodFiles = full ? 200_001 : 6;
    const floodDirs = full ? 200_001 : 6;

    if (full) {
        for (const [id, title, why, kind] of [
            [
                'entry-flood-files',
                'An absurd number of file entries',
                'A central directory can ask for more work than a person would ever pack. It should be refused before the first file is created.',
                'files',
            ],
            [
                'entry-flood-dirs',
                'An absurd number of directory entries',
                'Directory entries are not files, but they are still records in the central directory. A count that only counts files lets a flood through.',
                'dirs',
            ],
        ] as const) {
            const file = join(dir, `${id}.zip`);
            writeFlood(file, kind, kind === 'files' ? floodFiles : floodDirs);
            cases.push({ id, title, why, expect: 'refused', file });
        }
    } else {
        await add(
            'entry-flood-files',
            'An absurd number of file entries',
            'A central directory can ask for more work than a person would ever pack. It should be refused before the first file is created.',
            'refused',
            (z) => {
                addManifest(z);
                for (let i = 0; i < floodFiles; i += 1) {
                    z.addBuffer(Buffer.alloc(0), `proj/f${i}.txt`, { compress: false });
                }
            },
            undefined,
            { limits: { entries: floodFiles } },
        );

        await add(
            'entry-flood-dirs',
            'An absurd number of directory entries',
            'Directory entries are not files, but they are still records in the central directory. A count that only counts files lets a flood through.',
            'refused',
            (z) => {
                addManifest(z);
                for (let i = 0; i < floodDirs; i += 1) {
                    z.addEmptyDirectory(`proj/d${i}/`);
                }
            },
            undefined,
            { limits: { entries: floodDirs } },
        );
    }

    const bombChunks = 3;
    await add(
        'bomb-declared',
        'An expansion bomb that declares more than 8 GiB',
        'The payload is a few bytes; the central directory claims gigabytes. The preflight must sum the claims before opening a decompressor.',
        'refused',
        (z) => {
            addManifest(z);
            for (let i = 0; i < bombChunks; i += 1) {
                // Deflated, not stored: a stored entry must declare matching
                // compressed and uncompressed sizes, and the reader rejects
                // that lie before the size guard can say anything useful.
                z.addBuffer(Buffer.from('x'), `proj/bomb-${i}.bin`);
            }
        },
        (f) => {
            for (let i = 0; i < bombChunks; i += 1) {
                patchSize(f, `proj/bomb-${i}.bin`, 0xf0000000);
            }
        },
    );

    await add(
        'bomb-under-limit',
        'A highly compressible payload below the limit',
        'This one is accepted by policy: the absolute byte bound is the defence, not a compression-ratio rule. The report records the residual risk.',
        'accepted',
        (z) => {
            addManifest(z);
            z.addBuffer(zeros(full ? 64 * 1024 * 1024 : 1024 * 1024), 'proj/bomb.bin');
        },
        undefined,
        {
            lands: ['bomb.bin'],
        },
    );

    // -- names that collide -------------------------------------------------

    await add(
        'case-collision',
        'Two names that differ only in case',
        'On macOS and Windows one entry silently overwrites the other; which one wins depends on extraction order.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('lower\n'), 'proj/agents.yaml');
            z.addBuffer(Buffer.from('UPPER\n'), 'proj/AGENTS.yaml');
        },
    );

    await add(
        'unicode-collision',
        'Two spellings of the same Unicode name',
        'NFC and NFD are different bytes and the same name on a filesystem that normalises. Folding only case misses this.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('one\n'), 'proj/caf\u00e9.txt');
            z.addBuffer(Buffer.from('two\n'), 'proj/cafe\u0301.txt');
        },
    );

    await add(
        'duplicate-path',
        'The same path twice',
        'The result depends on which entry the reader writes last, so the archive means different things to different readers.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('first\n'), 'proj/a.txt');
            z.addBuffer(Buffer.from('second\n'), 'proj/b.txt');
        },
        (f) => patchName(f, 'proj/b.txt', 'proj/a.txt'),
    );

    await add(
        'file-dir-collision',
        'A path that is both a file and a directory',
        'Writing the file succeeds and writing below it fails with ENOTDIR, leaving a half-written tree.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('file\n'), 'proj/a');
            z.addBuffer(Buffer.from('below\n'), 'proj/a/b');
        },
    );

    // -- permissions --------------------------------------------------------

    await add(
        'mode-setuid',
        'A setuid bit on a regular file',
        "A mode is the archive's claim. The importer replaces it, so setuid cannot survive.",
        'accepted',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('#!/bin/sh\n'), 'proj/tool', { mode: 0o104755 });
        },
        undefined,
        { lands: ['tool'], modes: { tool: 0o644 } },
    );

    await add(
        'mode-zero',
        'A file with no permission bits',
        'A zero mode is a valid claim but not a useful file; the importer decides the mode instead.',
        'accepted',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('read me\n'), 'proj/zero', { mode: 0o100000 });
        },
        undefined,
        { lands: ['zero'], modes: { zero: 0o644 } },
    );

    await add(
        'mode-world',
        'A world-writable file',
        'A 0777 claim must not become a 0777 file.',
        'accepted',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('write me\n'), 'proj/world', { mode: 0o100777 });
        },
        undefined,
        { lands: ['world'], modes: { world: 0o644 } },
    );

    await add(
        'mode-shell',
        'An executable shell script',
        'A script has to be runnable to be useful, and that is the only bit the importer grants.',
        'accepted',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('#!/bin/sh\necho hi\n'), 'proj/run.sh', { mode: 0o100600 });
        },
        undefined,
        { lands: ['run.sh'], modes: { 'run.sh': 0o755 } },
    );

    // -- the manifest and ordering ------------------------------------------

    await add(
        'manifest-traversal',
        'A manifest that names a path outside the target',
        'The root and the name are used to build paths and registry keys, so they are checked rather than trusted.',
        'refused',
        (z) => {
            addManifest(z, { root: '../x', name: '../x' });
            z.addBuffer(Buffer.from('anything\n'), 'proj/a.txt');
        },
    );

    await add(
        'partial-write',
        'A benign entry before a hostile one',
        'If the guard runs while writing, the benign file is already on disk when the hostile entry is refused.',
        'refused',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.from('safe\n'), 'proj/agents.yaml');
            z.addBuffer(Buffer.from('pwned'), 'proj/xxxxxx.txt');
        },
        (f) => patchName(f, 'proj/xxxxxx.txt', '../../pwned.txt'),
    );

    await add(
        'windows-names',
        'Names Windows cannot represent safely',
        'A Linux import accepts these, then a Windows checkout has to deal with them. The report records them as residual risk rather than claiming they are safe.',
        'accepted',
        (z) => {
            addManifest(z);
            z.addBuffer(Buffer.alloc(0), 'proj/CON');
            z.addBuffer(Buffer.alloc(0), 'proj/aux.txt');
            z.addBuffer(Buffer.alloc(0), 'proj/name.');
            z.addBuffer(Buffer.alloc(0), 'proj/C:/x');
        },
        undefined,
        { lands: ['CON', 'aux.txt', 'name.', 'C:/x'] },
    );

    await add(
        'empty-dirs',
        'Directory entries with no files',
        'An empty directory is not part of the project; the archive is accepted and the directory does not travel.',
        'accepted',
        (z) => {
            addManifest(z);
            z.addEmptyDirectory('proj/empty/');
        },
        undefined,
        { lands: [] },
    );

    return cases;
}
