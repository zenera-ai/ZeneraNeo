/**
 * Startup memory snapshots for the server CLI and its host-side container launcher.
 * prepareMemorySeed resolves the seed, captures committed SQLite/WAL data and attached
 * files into a rollback-journal snapshot, and returns its path and cleanup function.
 * New users copy this fixed seed; existing private user memories are never replaced.
 */
import {
    copyMemory,
    isMemory,
    LEGACY_GRAPH_FILE,
    MEMORY_DB,
    memoryDir,
    readProjectConfig,
} from '@zenera/neo';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CliError, EXIT } from './term.ts';

export interface PreparedMemorySeed {
    dir: string;
    cleanup(): Promise<void>;
}

export async function prepareMemorySeed(
    projectDir: string,
    serverRoot: string,
    selected?: string | null,
): Promise<PreparedMemorySeed | null> {
    if (selected === null) return null;
    let source = selected;
    if (source === undefined) {
        const { root, config } = readProjectConfig(projectDir);
        source = memoryDir(root, config);
    }
    if (!source) return null;
    if (!isMemory(source)) {
        if (existsSync(join(source, LEGACY_GRAPH_FILE))) {
            throw new CliError(
                `the memory seed ${source} holds a version 1 memory`,
                EXIT.invalid,
                `convert it first: zen memory migrate --dir ${source}`,
            );
        }
        // An uninitialized seed means every new user starts with empty memory.
        return null;
    }
    await mkdir(serverRoot, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(serverRoot, '.memory-seed-'));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
        await copyMemory(source, dir);
        const db = new DatabaseSync(join(dir, MEMORY_DB));
        try {
            db.exec('PRAGMA journal_mode = DELETE');
        } finally {
            db.close();
        }
        await makeReadable(dir);
        return { dir, cleanup };
    } catch (err) {
        await cleanup();
        throw new CliError(
            `cannot snapshot the memory seed ${source}: ${err instanceof Error ? err.message : err}`,
            EXIT.failed,
            'the host must be able to read the seed and create SQLite WAL/SHM files beside it',
        );
    }
}

/** The root controls privacy; the mounted snapshot must be readable by image UID 10001. */
async function makeReadable(dir: string): Promise<void> {
    await chmod(dir, 0o755);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            await makeReadable(path);
        } else if (entry.isFile()) {
            await chmod(path, 0o644);
        }
        // Never chmod a copied symlink's target outside this snapshot.
    }
}
