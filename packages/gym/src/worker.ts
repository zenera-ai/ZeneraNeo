import { pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';
import {
    createContext,
    HttpError,
    type Bindings,
    type HandlerRequest,
    type LongList,
    type SynthesisRequest,
    type Use,
} from './runtime.ts';
import { WorldStore } from './store.ts';

// ---------------------------------------------------------------------------
// The handler worker
//
// Model-written code runs here rather than on the server's own thread, for one
// reason: a handler stuck in `while (true)` must cost one request and a worker
// restart, not the whole mock. Everything else — the world, the paging rule,
// asking an agent for content — is the same code the host would have run.
//
// Asking for content is the one thing a worker cannot do itself, since the
// agents live on the host with the model and the keys. So `synthesize` is a
// message out and a message back, and the host stops the handler's clock while
// it waits: an agent call is slow on purpose, a handler is not allowed to be.
// ---------------------------------------------------------------------------

export type ToWorker =
    | {
          type: 'run';
          id: number;
          file: string;
          version: string;
          db: string;
          input: HandlerRequest;
          bindings: Bindings;
          /** set only for the operation `--pages` stretches */
          long?: LongList;
      }
    | { type: 'synthesized'; id: number; call: number; records?: unknown[]; error?: string }
    | { type: 'close'; db: string };

export type FromWorker =
    | { type: 'synthesize'; id: number; call: number; db: string; request: SynthesisRequest }
    | { type: 'done'; id: number; ok: true; value: unknown; status?: number; used: Use[] }
    | { type: 'done'; id: number; ok: false; fault: string; stderr?: string; used: Use[] };

const port = parentPort;
if (!port) {
    throw new Error('worker.ts must be started as a worker thread');
}

const stores = new Map<string, WorldStore>();
const pending = new Map<string, { resolve: (v: unknown[]) => void; reject: (e: Error) => void }>();
let calls = 0;

const storeFor = (path: string): WorldStore => {
    let store = stores.get(path);
    if (!store) {
        store = new WorldStore(path);
        stores.set(path, store);
    }
    return store;
};

port.on('message', (message: ToWorker) => {
    if (message.type === 'close') {
        stores.get(message.db)?.close();
        stores.delete(message.db);
        return;
    }
    if (message.type === 'synthesized') {
        const key = `${message.id}:${message.call}`;
        const waiter = pending.get(key);
        pending.delete(key);
        if (message.error !== undefined) {
            waiter?.reject(new Error(message.error));
        } else {
            waiter?.resolve(message.records ?? []);
        }
        return;
    }
    void run(message);
});

async function run(message: Extract<ToWorker, { type: 'run' }>): Promise<void> {
    const { id } = message;
    const used = new Map<string, Use>();
    const record = (use: Use): void => {
        used.set(`${use.collection}\u0000${use.type ?? ''}\u0000${use.idField ?? ''}`, use);
    };
    const reply = (m: DistributiveOmit<FromWorker, 'used'>): void =>
        port!.postMessage({ ...m, used: [...used.values()] } as FromWorker);
    try {
        const mod = (await import(`${pathToFileURL(message.file).href}?v=${message.version}`)) as {
            default?: unknown;
            handle?: unknown;
        };
        const handle = (mod.default ?? mod.handle) as
            ((req: HandlerRequest, ctx: unknown) => unknown) | undefined;
        if (typeof handle !== 'function') {
            reply({
                type: 'done',
                id,
                ok: false,
                fault: 'exports no handler: write `export default async function handle(req, ctx)`',
            });
            return;
        }
        const store = storeFor(message.db);
        const ctx = createContext(
            message.input,
            store,
            (request) => {
                const call = ++calls;
                return new Promise<unknown[]>((resolve, reject) => {
                    pending.set(`${id}:${call}`, { resolve, reject });
                    port!.postMessage({
                        type: 'synthesize',
                        id,
                        call,
                        db: message.db,
                        request,
                    } satisfies FromWorker);
                }) as Promise<Record<string, unknown>[]>;
            },
            message.bindings,
            record,
            message.long,
        );
        const value = await handle(structuredClone(message.input), ctx);
        reply({ type: 'done', id, ok: true, value: value === undefined ? null : value });
    } catch (err) {
        if (err instanceof HttpError) {
            reply({ type: 'done', id, ok: true, value: err.body, status: err.status });
            return;
        }
        const e = err instanceof Error ? err : new Error(String(err));
        reply({
            type: 'done',
            id,
            ok: false,
            fault: `threw ${e.name}: ${e.message.split('\n')[0]}`,
            stderr: e.stack,
        });
    }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
