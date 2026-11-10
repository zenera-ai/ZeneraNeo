import type { Embedder } from '@zenera/neo';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkTexts, expandSchemas } from '../src/inputs.ts';
import { indexDir, NO_STORY, openKnowledge, TEXT_ONLY, type Knowledge } from '../src/knowledge.ts';
import { spec } from './helpers.ts';

let dir: string;
let open: Knowledge[] = [];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gym-knowledge-'));
    open = [];
    // The vector and parse caches are machine-wide; a test must neither read
    // what a person has cached nor leave anything in it.
    vi.stubEnv('ZENERA_HOME', join(dir, '.home'));
});

afterEach(() => {
    open.forEach((k) => k.close());
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, text: string): string => {
    const at = join(dir, path);
    mkdirSync(join(at, '..'), { recursive: true });
    writeFileSync(at, text);
    return at;
};

const know = async (opts: {
    story?: string[];
    docs?: string[];
    embedding?: { ref: string; embedder: Embedder };
    warn?: string[];
}): Promise<Knowledge> => {
    const k = await openKnowledge({
        story: opts.story ?? [],
        docs: opts.docs ?? [],
        cwd: dir,
        root: join(dir, '.gym'),
        embedding: opts.embedding,
        onWarn: (m) => opts.warn?.push(m),
    });
    open.push(k);
    return k;
};

/** Embeds by counting letters: deterministic, offline, and different from TEXT_ONLY. */
const letters = (fail = false): Embedder & { calls: number } => {
    const e = {
        id: 'test:letters',
        calls: 0,
        embed: (req: { input: string[] }) => {
            e.calls++;
            if (fail) {
                return Promise.reject(new Error('quota exceeded'));
            }
            return TEXT_ONLY.embed(req as never);
        },
    };
    return e;
};

describe('naming API documents', () => {
    it('takes files, walks directories for documents, and expands quoted globs', async () => {
        write('api/a.yaml', 'openapi: 3.0.3\n');
        write('api/nested/b.json', '{\n  "info": {},\n  "swagger": "2.0"\n}\n');
        write('api/package.json', '{ "name": "not an api" }');
        write('api/notes.md', '# notes');
        expect(await expandSchemas(['api'], dir)).toEqual([
            join(dir, 'api/a.yaml'),
            join(dir, 'api/nested/b.json'),
        ]);
        expect(await expandSchemas(['api/**/*.json'], dir)).toEqual([
            join(dir, 'api/nested/b.json'),
        ]);
        expect(await expandSchemas(['api/a.yaml', 'api', 'api/a.yaml'], dir)).toHaveLength(2);
    });

    it('says what to do with a story or docs passed as a document', async () => {
        write('world.md', '# world');
        await expect(expandSchemas(['world.md'], dir)).rejects.toMatchObject({
            message: expect.stringMatching(/not an API document/),
            hint: expect.stringMatching(/--story.*--docs/),
        });
        await expect(expandSchemas(['missing.yaml'], dir)).rejects.toThrow(/no such file/);
        write('empty/x.json', '{}');
        await expect(expandSchemas(['empty'], dir)).rejects.toThrow(/holds no API document/);
        await expect(expandSchemas(['nope/*.yaml'], dir)).rejects.toMatchObject({
            hint: expect.stringMatching(/quote the pattern/),
        });
    });

    it('turns an API document away from --story and --docs', async () => {
        write('api.yaml', 'openapi: 3.0.3\n');
        await expect(checkTexts(['api.yaml'], dir, '--docs')).rejects.toMatchObject({
            hint: expect.stringMatching(/--schema/),
        });
        await expect(checkTexts(['gone.md'], dir, '--story')).rejects.toThrow(/no such file/);
    });

    // The real specs this package is tested against are found the same way.
    it('finds the test specs in their directory', async () => {
        const found = await expandSchemas([join(spec('petstore.yaml'), '..')], dir);
        expect(found.map((f) => f.split('/').at(-1))).toEqual(
            expect.arrayContaining(['petstore.yaml', 'paged.yaml']),
        );
    });
});

describe('the story', () => {
    it('is quoted whole, whatever its length, and warns when it is long', async () => {
        write('lore/people.md', '# People\n\nAda Lovelace runs ops.\n');
        write('lore/long.md', `# Long\n\n${'Grace Hopper writes compilers.\n'.repeat(2000)}`);
        const warn: string[] = [];
        const k = await know({ story: ['lore'], warn });
        expect(k.story).toContain('Ada Lovelace runs ops.');
        expect(k.story).toContain('Grace Hopper writes compilers.');
        expect(k.storyFiles).toBe(2);
        expect(warn.join()).toMatch(/--docs/);
    });

    it('is named by what it says, not where it is', async () => {
        write('a/world.md', '# Same\n');
        write('b/world.md', '# Same\n');
        write('c/world.md', '# Different\n');
        const [a, b, c] = await Promise.all([
            know({ story: ['a/world.md'] }),
            know({ story: ['b/world.md'] }),
            know({ story: ['c/world.md'] }),
        ]);
        expect(a.storyDigest).toBe(b.storyDigest);
        expect(a.storyDigest).not.toBe(c.storyDigest);
    });

    it('is replaced by an invitation to invent when there is none', async () => {
        const k = await know({});
        expect(k.story).toBe(NO_STORY);
        expect(k.storyDigest).toBe('');
        expect(k.tools).toEqual([]);
        expect(await k.recall('anything')).toBe('');
    });
});

describe('the docs', () => {
    const kb = (): void => {
        write('kb/bgp.md', '# BGP\n\nEdge routers peer over BGP. The local ASN is 65001.\n');
        write('kb/subnets.md', '# Subnets\n\nEvery subnet attaches to an availability zone.\n');
    };

    it('are indexed by wording when there is no embedding model, and searched', async () => {
        kb();
        const k = await know({ docs: ['kb'] });
        expect(k.docs).toMatchObject({ files: 2, search: 'text', reused: false });
        expect(k.tools.map((t) => t.name).sort()).toEqual([
            'grep_docs',
            'list_docs',
            'read_docs',
            'search_docs',
        ]);
        expect(await k.recall('availability zone')).toContain('Every subnet attaches');
        // A vector wording is asked of the text index instead of failing.
        const search = k.tools.find((t) => t.name === 'search_docs')!;
        const found = (await search.execute({ vector_query: 'ASN' }, {} as never)) as {
            passages?: string;
        };
        expect(found.passages).toContain('65001');
    });

    it('are indexed by meaning and wording with an embedding model', async () => {
        kb();
        const embedder = letters();
        const k = await know({ docs: ['kb'], embedding: { ref: 'test:letters', embedder } });
        expect(k.docs).toMatchObject({ search: 'hybrid', embedding: 'test:letters' });
        expect(embedder.calls).toBeGreaterThan(0);
        expect(await k.recall('BGP ASN')).toContain('65001');
    });

    it('reuse the index they already have', async () => {
        kb();
        (await know({ docs: ['kb'] })).close();
        const again = await know({ docs: ['kb'] });
        expect(again.docs?.reused).toBe(true);
        expect(readdirSync(join(dir, '.gym', 'indexes'))).toHaveLength(1);
    });

    // Changing what embeds the docs changes their index, never the world.
    it('are indexed apart per embedding model and per content', async () => {
        expect(indexDir('/r', 'abc', 'openai:text-embedding-3-small')).toBe(
            join('/r', 'indexes', 'docs-abc-openai-text-embedding-3-small'),
        );
        expect(indexDir('/r', 'abc', undefined)).toBe(join('/r', 'indexes', 'docs-abc-text'));
    });

    it('fall back to wording when the embedding model fails', async () => {
        kb();
        const warn: string[] = [];
        const k = await know({
            docs: ['kb'],
            embedding: { ref: 'test:broken', embedder: letters(true) },
            warn,
        });
        expect(k.docs?.search).toBe('text');
        expect(warn.join()).toMatch(/quota exceeded/);
        expect(existsSync(indexDir(join(dir, '.gym'), 'x', undefined))).toBe(false);
    });
});
