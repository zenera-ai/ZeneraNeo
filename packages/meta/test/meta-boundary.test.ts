import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The meta layer's boundary
//
// `src/meta/` reaches the rest of the CLI through `meta/host.ts` alone, and the
// rest of the CLI reaches into `src/meta/` from a short, named list of places.
// That is what keeps a later `@zenera/meta` a matter of moving files.
// ---------------------------------------------------------------------------

const SRC = resolve(import.meta.dirname, '..', 'src');
const META = join(SRC, 'meta');

/** Runtime files that may import from `src/meta/`, relative to `src/`. */
const DOORS = new Set(['commands/meta.ts', 'commands/open.ts', 'scaffold.ts']);

function sources(dir: string): string[] {
    return (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => join(dir, f));
}

/** Every relative module a file imports, resolved to an absolute path. */
function imports(file: string): string[] {
    const text = readFileSync(file, 'utf8');
    const found = [...text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)];
    return found.map((m) => resolve(dirname(file), m[1]));
}

const inMeta = (path: string): boolean => path === META || path.startsWith(META + sep);
const rel = (path: string): string => relative(SRC, path).split(sep).join('/');

describe('the meta layer', () => {
    it('reaches the rest of the CLI only through host.ts', () => {
        const strays = sources(META)
            .filter((file) => file !== join(META, 'host.ts'))
            .flatMap((file) =>
                imports(file)
                    .filter((target) => !inMeta(target))
                    .map((target) => `${rel(file)} -> ${rel(target)}`),
            );
        expect(strays).toEqual([]);
    });

    it('is reached from the rest of the CLI only through its named doors', () => {
        const strays = sources(SRC)
            .filter((file) => !inMeta(file) && !DOORS.has(rel(file)))
            .flatMap((file) =>
                imports(file)
                    .filter(inMeta)
                    .map((target) => `${rel(file)} -> ${rel(target)}`),
            );
        expect(strays).toEqual([]);
    });
});
