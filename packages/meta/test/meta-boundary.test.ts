import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The meta package's boundary
//
// `@zenera/meta` reaches `zen` through `src/host.ts` alone, and only through
// `@zenera/cli/lib`: never a path into the CLI's source, never another of its
// entry points. That keeps what it needs of `zen` one list, and `zen` free to
// rearrange everything else.
// ---------------------------------------------------------------------------

const SRC = resolve(import.meta.dirname, '..', 'src');
const HOST = join(SRC, 'host.ts');

function sources(dir: string): string[] {
    return (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => join(dir, f));
}

/** Every module a file imports, statically or not, as written. */
function imports(file: string): string[] {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]);
}

const inside = (path: string): boolean => path === SRC || path.startsWith(SRC + sep);
const rel = (path: string): string => relative(SRC, path).split(sep).join('/');

describe('the meta package', () => {
    it('never imports a path outside its own source', () => {
        const strays = sources(SRC).flatMap((file) =>
            imports(file)
                .filter((spec) => spec.startsWith('.'))
                .filter((spec) => !inside(resolve(dirname(file), spec)))
                .map((spec) => `${rel(file)} -> ${spec}`),
        );
        expect(strays).toEqual([]);
    });

    it('reaches zen only through host.ts, and only through @zenera/cli/lib', () => {
        const strays = sources(SRC).flatMap((file) =>
            imports(file)
                .filter((spec) => spec === '@zenera/cli' || spec.startsWith('@zenera/cli/'))
                .filter((spec) => file !== HOST || spec !== '@zenera/cli/lib')
                .map((spec) => `${rel(file)} -> ${spec}`),
        );
        expect(strays).toEqual([]);
    });
});
