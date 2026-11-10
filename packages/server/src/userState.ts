// Each user's data on a server that may be one of many: loaded before their first request, saved
// at safe points, released when the host moves them elsewhere. The server decides *when* (it
// alone knows when runs end and how to copy a live memory graph); a UserStateStore plugin decides
// *where* (ZEN_STATE_STORE, e.g. ZeneraLite's S3 store). Without one, the local store keeps
// everything on this disk, as a single server always has.
//   UserStateStore, UserRef, UserSnapshot, USER_LAYOUT - the plugin contract
//   StaleGenerationError - what a store throws when a newer lease owns the user
//   localStore           - the default: nothing to load or save
//   userStates           - the server's manager: acquire (middleware), session, changed,
//                          release, drain (no new users or runs; each user released once
//                          their runs end), stopTaking, list, start (recovery, timers), shutdown
//   userStateRouter      - /api/admin: the host's view of this server's users (system token only)
//   userUsageBytes       - a user's local disk use, for the soft quota
// Used by server.ts (middleware, admin routes, listen/stop), store.ts (privateStore hooks) and
// runs.ts (quota at run start).
import { copyMemory, isMemory } from '@zenera/neo';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { settings } from './config.ts';
import { HttpError } from './http.ts';
import { caller, userFolder } from './identity.ts';
import { ownerRuns, refuseRuns, stopOwnerRuns } from './runs.ts';
import { memoryDir, userDir } from './store.ts';

/** Where things are in a user's folder, for stores that cannot import this package. */
export const USER_LAYOUT = {
    /** the user's memory graph; checkpoints carry a consistent copy instead (`memoryDir`) */
    memory: 'memory',
    /** one folder per chat thread */
    sessions: 'sessions',
    /** inside a session folder: its metadata, which the session list reads */
    sessionMeta: '.data/session.json',
    /** the server's own record of the user's lease; never a store's to save */
    marker: '.zen-user.json',
} as const;

export interface UserRef {
    /** the user's folder name under `<root>/users/` */
    id: string;
    /** that folder: everything of theirs on this server */
    dir: string;
    /** the host's lease generation (the token's `gen`); undefined when the host does not lease */
    generation?: number;
}

export type CheckpointReason =
    'run-end' | 'changed' | 'periodic' | 'release' | 'shutdown' | 'recover';

export interface UserSnapshot {
    /** a consistent copy of the user's memory made for this call, removed after it; none: no memory */
    memoryDir?: string;
    /** threads with a run going: their files may change while they are read */
    activeThreads: string[];
}

export interface UserStateStore {
    readonly name: string;
    /** true: the store keeps users elsewhere, so a released user's local copy is deleted */
    readonly durable: boolean;
    /** Before the user's first request here: fetch what they need into `user.dir`. */
    load(user: UserRef): Promise<void>;
    /** Before a request names one thread: fetch it if `load` left it for later. */
    loadSession?(user: UserRef, threadId: string): Promise<void>;
    /** Save the user's folder as it is now (memory from `snapshot.memoryDir`). */
    checkpoint(user: UserRef, reason: CheckpointReason, snapshot: UserSnapshot): Promise<void>;
    /** After the final checkpoint, before the local copy goes. */
    release?(user: UserRef): Promise<void>;
    /** On start, for users whose folders survived a restart of this process. */
    recover?(users: UserRef[]): Promise<void>;
    close?(): Promise<void>;
}

/** Thrown by a store when a newer lease generation owns the user: this copy must go. */
export class StaleGenerationError extends Error {
    readonly code = 'stale_generation';
}

export const localStore: UserStateStore = {
    name: 'local',
    durable: false,
    load: async () => undefined,
    checkpoint: async () => undefined,
};

type Status = 'loading' | 'ready' | 'releasing';

interface Entry {
    id: string;
    generation?: number;
    status: Status;
    loaded: Promise<void>;
    sessions: Map<string, Promise<void>>;
    /** bumped on every change; `saved` is the last one a checkpoint covered */
    changes: number;
    saved: number;
    queue: Promise<void>;
    lastUsed: number;
    lastCheckpointAt?: string;
    lastError?: string;
}

export interface UserInfo {
    id: string;
    generation?: number;
    status: Status;
    activeRuns: number;
    unsaved: boolean;
    lastUsed: string;
    lastCheckpointAt?: string;
    lastError?: string;
    usageBytes?: number;
}

function store(): UserStateStore {
    return settings().stateStore ?? localStore;
}

function generationOf(req: Request): number | undefined {
    const gen = caller(req).gen;
    if (gen === undefined) return undefined;
    if (!Number.isSafeInteger(gen) || (gen as number) < 0) {
        throw new HttpError(401, 'the token names no valid lease generation (gen)');
    }
    return gen as number;
}

function refOf(entry: Pick<Entry, 'id' | 'generation'>): UserRef {
    return { id: entry.id, dir: userDir(entry.id), generation: entry.generation };
}

const markerOf = (id: string) => join(userDir(id), USER_LAYOUT.marker);

async function writeMarker(entry: Entry): Promise<void> {
    // Only a durable store recovers users after a restart; local users need no record, and
    // listing sessions must not create a user's folder.
    if (!store().durable) return;
    await mkdir(userDir(entry.id), { recursive: true });
    await writeFile(
        markerOf(entry.id),
        `${JSON.stringify({ generation: entry.generation, store: store().name, loadedAt: new Date().toISOString(), lastCheckpointAt: entry.lastCheckpointAt }, null, 2)}\n`,
    );
}

export interface DrainResult {
    released: string[];
    /** by user: why they could not be released (a run still going, a failed save) */
    failed: Record<string, string>;
}

class UserStates {
    readonly #users = new Map<string, Entry>();
    #draining = false;
    #drainJob?: Promise<DrainResult>;
    #timer?: NodeJS.Timeout;
    #quotaTimer?: NodeJS.Timeout;
    #usage = new Map<string, { bytes: number; at: number }>();

    get draining(): boolean {
        return this.#draining;
    }

    get size(): number {
        return this.#users.size;
    }

    /** The user's data, ready; their folder is theirs to use once this resolves. */
    async acquire(id: string, generation?: number): Promise<void> {
        let entry = this.#users.get(id);
        if (entry && generation !== undefined && entry.generation !== undefined) {
            if (generation < entry.generation) {
                throw Object.assign(
                    new HttpError(409, 'this lease is no longer current: the user moved'),
                    { code: 'stale_lease' },
                );
            }
            if (generation > entry.generation) {
                // Leased elsewhere and back: what is here may be older than what was saved there.
                if (ownerRuns(id).length) {
                    throw new HttpError(409, 'the user moved while a run is still going here');
                }
                await this.#forget(entry, 'a newer lease');
                entry = undefined;
            }
        }
        if (!entry) {
            if (this.#draining) throw new HttpError(503, 'this server is draining');
            entry = this.#load(id, generation);
        }
        if (entry.status === 'releasing') throw new HttpError(503, 'the user is being released');
        entry.lastUsed = Date.now();
        await entry.loaded;
    }

    #load(id: string, generation?: number): Entry {
        const entry: Entry = {
            id,
            generation,
            status: 'loading',
            loaded: Promise.resolve(),
            sessions: new Map(),
            changes: 0,
            saved: 0,
            queue: Promise.resolve(),
            lastUsed: Date.now(),
        };
        this.#users.set(id, entry);
        const s = store();
        entry.loaded = (async () => {
            // A durable store's user is whatever it holds: never mix that with a stale local copy.
            if (s.durable) await rm(userDir(id), { recursive: true, force: true });
            await s.load(refOf(entry));
            entry.status = 'ready';
            await writeMarker(entry);
        })().catch((err: unknown) => {
            this.#users.delete(id);
            throw new HttpError(503, `could not load the user's data: ${messageOf(err)}`);
        });
        return entry;
    }

    /** Before a request names a thread: the store fetches it if it left it for later. */
    async session(id: string, threadId: string): Promise<void> {
        const load = store().loadSession;
        const entry = this.#users.get(id);
        if (!load || !entry) return;
        let pending = entry.sessions.get(threadId);
        if (!pending) {
            pending = load.call(store(), refOf(entry), threadId).catch((err: unknown) => {
                entry.sessions.delete(threadId);
                throw new HttpError(503, `could not load the chat: ${messageOf(err)}`);
            });
            entry.sessions.set(threadId, pending);
        }
        await pending;
    }

    /** Something of the user's changed (a run ended, a thread went): save it. */
    changed(id: string, reason: CheckpointReason = 'changed'): void {
        this.#usage.delete(id);
        const entry = this.#users.get(id);
        if (!entry) return;
        entry.changes++;
        void this.checkpoint(id, reason).catch(() => undefined);
    }

    /** Saves the user now, after any save already queued; one at a time per user. */
    checkpoint(id: string, reason: CheckpointReason): Promise<void> {
        const entry = this.#users.get(id);
        if (!entry || !store().durable) return Promise.resolve();
        const run = entry.queue.then(() => this.#save(entry, reason));
        entry.queue = run.catch(() => undefined);
        return run;
    }

    async #save(entry: Entry, reason: CheckpointReason): Promise<void> {
        if (this.#users.get(entry.id) !== entry) return;
        const upTo = entry.changes;
        const tmp = join(
            settings().root,
            '.checkpoints',
            `${entry.id}-${randomBytes(4).toString('hex')}`,
        );
        try {
            const memory = memoryDir(entry.id);
            let snapshotDir: string | undefined;
            if (isMemory(memory)) {
                await mkdir(join(settings().root, '.checkpoints'), { recursive: true });
                await copyMemory(memory, tmp);
                snapshotDir = tmp;
            }
            await store().checkpoint(refOf(entry), reason, {
                memoryDir: snapshotDir,
                activeThreads: ownerRuns(entry.id).map((r) => r.threadId),
            });
            entry.saved = Math.max(entry.saved, upTo);
            entry.lastCheckpointAt = new Date().toISOString();
            entry.lastError = undefined;
            await writeMarker(entry);
        } catch (err) {
            if (
                err instanceof StaleGenerationError ||
                (err as { code?: string })?.code === 'stale_generation'
            ) {
                console.warn(`user ${entry.id}: ${messageOf(err)}; dropping this copy`);
                await this.#forget(entry, 'a newer lease', true);
                return;
            }
            entry.lastError = messageOf(err);
            console.error(`user ${entry.id}: checkpoint (${reason}) failed: ${entry.lastError}`);
            throw err;
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    }

    /** Drops the user here: their runs stopped, their local copy gone when the store keeps them. */
    async #forget(entry: Entry, why: string, stopRuns = false): Promise<void> {
        this.#users.delete(entry.id);
        if (stopRuns) await stopOwnerRuns(entry.id, `the run was stopped: ${why} owns this user`);
        if (store().durable) await rm(userDir(entry.id), { recursive: true, force: true });
        this.#usage.delete(entry.id);
    }

    /** Saves the user for the last time and lets them go; refused while their runs go on. */
    async release(id: string): Promise<'released' | 'absent'> {
        const entry = this.#users.get(id);
        if (!entry) return 'absent';
        await entry.loaded.catch(() => undefined);
        if (!this.#users.has(id)) return 'absent';
        if (ownerRuns(id).length) {
            throw Object.assign(new HttpError(409, 'the user has runs going'), { code: 'busy' });
        }
        entry.status = 'releasing';
        try {
            await this.checkpoint(id, 'release');
            await store().release?.(refOf(entry));
        } catch (err) {
            entry.status = 'ready';
            throw new HttpError(503, `could not save the user: ${messageOf(err)}`);
        }
        if (this.#users.get(id) === entry) await this.#forget(entry, 'release');
        return 'released';
    }

    /** No new users and no new runs; the runs going may finish (a stopping server's drain). */
    stopTaking(): void {
        this.#draining = true;
        refuseRuns(true);
    }

    /**
     * No new users or runs; each user here released once their runs end (at the latest when
     * `timeoutMs` is up, then refused if a run still goes). A second call joins the first.
     */
    drain(timeoutMs: number): Promise<DrainResult> {
        this.stopTaking();
        if (!this.#drainJob) {
            const job = this.#drain(timeoutMs).finally(() => {
                if (this.#drainJob === job) this.#drainJob = undefined;
            });
            this.#drainJob = job;
        }
        return this.#drainJob;
    }

    async #drain(timeoutMs: number): Promise<DrainResult> {
        const released: string[] = [];
        const failed: Record<string, string> = {};
        const deadline = Date.now() + timeoutMs;
        await Promise.all(
            [...this.#users.keys()].map(async (id) => {
                const runs = ownerRuns(id).map((r) => r.done);
                const left = Math.max(0, deadline - Date.now());
                await Promise.race([
                    Promise.all(runs),
                    new Promise((resolve) => setTimeout(resolve, left).unref()),
                ]);
                // Called off meanwhile (undrain): the user stays.
                if (!this.#draining) return;
                try {
                    if ((await this.release(id)) === 'released') released.push(id);
                } catch (err) {
                    failed[id] = messageOf(err);
                }
            }),
        );
        return { released, failed };
    }

    /** Takes users again: a drain that was called off. */
    undrain(): void {
        this.#draining = false;
        refuseRuns(false);
    }

    async list(withUsage = false): Promise<UserInfo[]> {
        return Promise.all(
            [...this.#users.values()].map(async (e) => ({
                id: e.id,
                generation: e.generation,
                status: e.status,
                activeRuns: ownerRuns(e.id).length,
                unsaved: store().durable && e.changes > e.saved,
                lastUsed: new Date(e.lastUsed).toISOString(),
                ...(e.lastCheckpointAt ? { lastCheckpointAt: e.lastCheckpointAt } : {}),
                ...(e.lastError ? { lastError: e.lastError } : {}),
                ...(withUsage ? { usageBytes: await userUsageBytes(e.id) } : {}),
            })),
        );
    }

    /** Over the soft quota: refuse new runs (checked before one starts). */
    async admit(id: string): Promise<void> {
        const quota = settings().userDiskQuotaBytes;
        if (!quota) return;
        const used = await this.#cachedUsage(id);
        if (used >= quota) {
            throw new HttpError(
                507,
                `your storage is full: ${mb(used)} of ${mb(quota)} MB; delete chats or files to continue`,
            );
        }
    }

    async #cachedUsage(id: string, maxAgeMs = 15_000): Promise<number> {
        const hit = this.#usage.get(id);
        if (hit && Date.now() - hit.at < maxAgeMs) return hit.bytes;
        const bytes = await userUsageBytes(id);
        this.#usage.set(id, { bytes, at: Date.now() });
        return bytes;
    }

    /** Recovers users whose folders survived a restart, and starts the timers. */
    async start(): Promise<void> {
        this.#draining = false;
        refuseRuns(false);
        const s = store();
        const recovered: Entry[] = [];
        const users = join(settings().root, 'users');
        if (s.durable && existsSync(users)) {
            for (const id of await readdir(users)) {
                let marker: { generation?: number };
                try {
                    marker = JSON.parse(await readFile(markerOf(id), 'utf8'));
                } catch {
                    continue;
                }
                const entry: Entry = {
                    id,
                    generation: marker.generation,
                    status: 'ready',
                    loaded: Promise.resolve(),
                    sessions: new Map(),
                    // Whatever happened before the restart may not be saved yet.
                    changes: 1,
                    saved: 0,
                    queue: Promise.resolve(),
                    lastUsed: Date.now(),
                };
                this.#users.set(id, entry);
                recovered.push(entry);
            }
        }
        if (recovered.length) {
            // A store that cannot recover still lets the server start; its saves will say why.
            await s.recover?.(recovered.map(refOf)).catch((err: unknown) => {
                console.error(`recovering ${recovered.length} users: ${messageOf(err)}`);
            });
            for (const entry of recovered)
                void this.checkpoint(entry.id, 'recover').catch(() => undefined);
        }
        const every = settings().checkpointSeconds * 1000;
        if (s.durable && every > 0) {
            this.#timer = setInterval(() => this.#periodic(), every);
            this.#timer.unref();
        }
        if (settings().userDiskQuotaBytes) {
            this.#quotaTimer = setInterval(() => void this.#enforceQuota(), 30_000);
            this.#quotaTimer.unref();
        }
    }

    // Users with runs going (their files keep changing) or a save that failed are saved again.
    #periodic(): void {
        for (const entry of this.#users.values()) {
            if (entry.status !== 'ready') continue;
            if (ownerRuns(entry.id).length) entry.changes++;
            if (entry.changes > entry.saved) {
                void this.checkpoint(entry.id, 'periodic').catch(() => undefined);
            }
        }
    }

    // A run that pushes its user far over the quota is stopped, before the pod's disk fills.
    async #enforceQuota(): Promise<void> {
        const quota = settings().userDiskQuotaBytes;
        for (const id of this.#users.keys()) {
            if (!ownerRuns(id).length) continue;
            const used = await this.#cachedUsage(id, 0).catch(() => 0);
            if (used > quota) {
                await stopOwnerRuns(
                    id,
                    `the run was stopped: your storage is over its limit (${mb(used)} of ${mb(quota)} MB)`,
                );
            }
        }
    }

    /** After the runs stopped: everyone saved once more, as far as the time allows. */
    async shutdown(timeoutMs: number): Promise<void> {
        clearInterval(this.#timer);
        clearInterval(this.#quotaTimer);
        const all = [...this.#users.keys()].map((id) => {
            this.changed(id, 'shutdown');
            return this.#users.get(id)?.queue ?? Promise.resolve();
        });
        await Promise.race([
            Promise.all(all),
            new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
        ]);
        await store().close?.();
        this.#users.clear();
        this.#usage.clear();
    }
}

export const userStates = new UserStates();

/** Every user-scoped route: the caller's data loaded first, and their thread when one is named. */
export async function loadCaller(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const id = userFolder(caller(req).sub);
    await userStates.acquire(id, generationOf(req));
    next();
}

export async function loadThread(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const tid = String(req.params.tid ?? '');
    if (tid) await userStates.session(userFolder(caller(req).sub), tid);
    next();
}

/** /api/admin: only for the host's own calls (its system subject, never a user's thread token). */
export function userStateRouter(): Router {
    const router = Router();
    router.use((req, _res, next) => {
        const claims = caller(req);
        if (claims.sub !== settings().systemSubject || claims.thr !== undefined) {
            throw new HttpError(403, 'for the host only');
        }
        next();
    });
    router.get('/users', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            store: store().name,
            durable: store().durable,
            draining: userStates.draining,
            users: await userStates.list(req.query.usage === '1'),
        });
    });
    router.post('/users/:sub/release', async (req, res) => {
        const result = await userStates.release(userFolder(String(req.params.sub)));
        res.json({ result });
    });
    // ?wait=0: answers at once; GET /users then shows who is left and `draining`.
    router.post('/drain', async (req, res) => {
        const seconds = Number(req.query.timeout ?? 600);
        const timeout = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 600_000;
        const job = userStates.drain(timeout);
        if (req.query.wait === '0') {
            job.catch(() => undefined);
            res.json({ draining: true, users: userStates.size });
            return;
        }
        res.json(await job);
    });
    router.post('/undrain', (_req, res) => {
        userStates.undrain();
        res.json({ draining: false });
    });
    return router;
}

/** Bytes under a user's folder, links not followed. */
export async function userUsageBytes(id: string): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile()) total += (await lstat(path).catch(() => ({ size: 0 }))).size;
        }
    };
    await walk(userDir(id));
    return total;
}

const mb = (bytes: number) => Math.round(bytes / 2 ** 20);

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
