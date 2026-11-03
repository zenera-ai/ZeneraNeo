import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { liveHolder } from '../lock.ts';
import { MemoryGraph } from './graph.ts';
import {
    isMemory,
    LEGACY_GRAPH_FILE,
    MEMORY_DB,
    MEMORY_VERSION,
    MemoryStore,
    type MemoryEmbedding,
} from './store.ts';
import { MemoryError } from './types.ts';

// ---------------------------------------------------------------------------
// From the version 1 layout to the database
//
// Version 1 kept a memory as `graph.json`, `vectors.f32`, `vectors.json` and a
// `manifest.json` written last. The conversion reads all of it, writes the
// database in one transaction, and moves the old files into `v1/` rather than
// deleting them, so a migration that turns out wrong is undone by moving four
// files back. `files/` is shared by both layouts and does not move.
// ---------------------------------------------------------------------------

/** Where the version 1 files are kept once converted. */
export const LEGACY_DIR = 'v1';

const LEGACY_FILES = [LEGACY_GRAPH_FILE, 'vectors.f32', 'vectors.json', 'manifest.json', '.lock'];

export interface MigrationReport {
    dir: string;
    nodes: number;
    edges: number;
    vectors: number;
    embedding?: MemoryEmbedding;
    /** where the version 1 files went */
    legacy: string;
}

export async function migrateMemory(dir: string): Promise<MigrationReport> {
    if (isMemory(dir)) {
        throw new MemoryError(`${dir} is already a version ${MEMORY_VERSION} memory`);
    }
    if (!existsSync(join(dir, LEGACY_GRAPH_FILE))) {
        throw new MemoryError(`${dir} is not a version 1 memory`, `no ${LEGACY_GRAPH_FILE} in it`);
    }
    const held = liveHolder(join(dir, '.lock'));
    if (held) {
        throw new MemoryError(
            `this memory is in use (pid ${held.pid}, since ${held.startedAt})`,
            'wait for that run to finish',
        );
    }

    const manifest = await readJson<{ version?: number; embedding?: MemoryEmbedding }>(
        join(dir, 'manifest.json'),
    );
    if (manifest?.version !== undefined && manifest.version !== 1) {
        throw new MemoryError(`${dir} is version ${manifest.version}, not version 1`);
    }
    const graph = MemoryGraph.from(
        JSON.parse(await readFile(join(dir, LEGACY_GRAPH_FILE), 'utf8')),
    );
    const embedding = manifest?.embedding;
    const vectors = embedding
        ? await readVectors(dir, embedding.dimensions)
        : new Map<string, Float32Array>();

    const legacy = join(dir, LEGACY_DIR);
    await mkdir(legacy, { recursive: true });
    const moved: string[] = [];
    for (const name of LEGACY_FILES) {
        if (existsSync(join(dir, name))) {
            await rename(join(dir, name), join(legacy, name));
            moved.push(name);
        }
    }

    try {
        const store = await MemoryStore.open(dir, embedding ? { embedding } : {});
        try {
            for (const node of graph.nodes()) {
                store.graph.adopt(node);
            }
            for (const link of graph.links()) {
                store.graph.adoptEdge(link.source, link.target, link.attrs);
            }
            for (const [id, vector] of vectors) {
                if (graph.has(id)) {
                    store.vectors?.set(id, vector);
                }
            }
            await store.commit();
        } finally {
            store.release();
        }
    } catch (err) {
        for (const suffix of ['', '-wal', '-shm']) {
            await rm(join(dir, MEMORY_DB + suffix), { force: true });
        }
        for (const name of moved) {
            await rename(join(legacy, name), join(dir, name));
        }
        throw err;
    }

    return {
        dir,
        nodes: graph.order,
        edges: graph.size,
        vectors: [...vectors.keys()].filter((id) => graph.has(id)).length,
        ...(embedding ? { embedding } : {}),
        legacy,
    };
}

async function readJson<T>(path: string): Promise<T | undefined> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

/** Vectors of a width that no longer matches the manifest are dropped, as version 1 did. */
async function readVectors(dir: string, dimensions: number): Promise<Map<string, Float32Array>> {
    const out = new Map<string, Float32Array>();
    const meta = await readJson<{ dims: number; ids: string[] }>(join(dir, 'vectors.json'));
    if (!meta || meta.dims !== dimensions) {
        return out;
    }
    const raw = await readFile(join(dir, 'vectors.f32'));
    const data = new Float32Array(Math.floor(raw.byteLength / 4));
    new Uint8Array(data.buffer).set(raw.subarray(0, data.length * 4));
    meta.ids.forEach((id, row) => {
        if ((row + 1) * dimensions <= data.length) {
            out.set(id, data.slice(row * dimensions, (row + 1) * dimensions));
        }
    });
    return out;
}
