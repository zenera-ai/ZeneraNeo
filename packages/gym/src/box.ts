import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Bindings, HandlerRequest, SynthesisRequest, Use } from './runtime.ts';
import type { FromWorker, ToWorker } from './worker.ts';

// ---------------------------------------------------------------------------
// Where handlers run
//
// A worker thread, not a container. The code is TypeScript that Node runs as
// it is, the world is a SQLite file the worker opens itself, and the only thing
// that crosses back to this thread is a request for content an agent has to
// write.
//
// What a thread does not give is a wall between the handler and the network.
// The handler is written by the model this process asked, from documents the
// user named, and it is judged before it is kept; the worker gets an empty
// environment, so no credential is in reach either way.
// ---------------------------------------------------------------------------

export const HANDLERS = 'handlers';
const ENTRY = 'handler.ts';

/** Asked when a handler wants content the world does not have yet. */
export type SynthesizeHook = (
    request: SynthesisRequest,
    context: { db: string; probe: boolean; input: HandlerRequest },
) => Promise<Record<string, unknown>[]>;

export interface BoxOptions {
    /** holds handlers/ */
    root: string;
    /** the live world every real request reads and writes */
    db: string;
    /** seconds one handler may run, not counting time spent waiting on an agent */
    timeout?: number;
    synthesize?: SynthesizeHook;
    /** where each type lives, as of now; asked on every run */
    bindings?: () => Bindings;
}

export interface RunOptions {
    /** another world to run against, e.g. a snapshot for judging */
    db?: string;
    /** the call is a judgement, not traffic: content is sampled, not written by an agent */
    probe?: boolean;
    /** bindings to run with instead of the current ones */
    bindings?: Bindings;
}

/**
 * The worker could not be started at all. This says nothing about the handler
 * and must never be fed back to a model as a fault in its code.
 */
export class WorkerUnavailable extends Error {
    readonly hint: string;
    readonly stderr?: string;

    constructor(message: string, opts: { hint: string; stderr?: string }) {
        super(message);
        this.name = 'WorkerUnavailable';
        this.hint = opts.hint;
        this.stderr = opts.stderr;
    }
}

export interface Outcome {
    ok: boolean;
    /** the body the handler answered with */
    value?: unknown;
    /** set when the handler answered with `ctx.fail` rather than a body */
    status?: number;
    /** what went wrong, in the words the build loop feeds back to the model */
    fault?: string;
    stderr?: string;
    /** the handler failed because the world agent did, not because of its code */
    agentFault?: boolean;
    /** the collections the run touched, and as which types */
    used?: Use[];
    durationMs: number;
}

interface Call {
    settle: (o: Outcome) => void;
    started: number;
    /** milliseconds of handler time left */
    left: number;
    /** when the clock last started */
    since?: number;
    timer?: NodeJS.Timeout;
    /** agent calls in flight; the clock is stopped while there are any */
    waiting: number;
    probe: boolean;
    input: HandlerRequest;
    /** why the world agent failed this call, when it did */
    agentError?: string;
}

export class Box {
    readonly root: string;
    readonly db: string;
    synthesize?: SynthesizeHook;
    readonly #bindings: () => Bindings;
    readonly #timeout: number;
    readonly #calls = new Map<number, Call>();
    readonly #versions = new Map<string, string>();
    #worker?: Worker;
    #next = 0;

    constructor(opts: BoxOptions) {
        this.root = opts.root;
        this.db = opts.db;
        this.#timeout = (opts.timeout ?? 30) * 1000;
        this.synthesize = opts.synthesize;
        this.#bindings = opts.bindings ?? (() => ({}));
        mkdirSync(join(opts.root, HANDLERS), { recursive: true });
        // Handlers are ES modules whatever the directory above them says.
        writeFileSync(
            join(opts.root, HANDLERS, 'package.json'),
            '{ "type": "module", "private": true }\n',
        );
    }

    /** Host path of a handler's source file. */
    sourceOf(key: string): string {
        return join(this.root, HANDLERS, key, ENTRY);
    }

    async write(key: string, source: string): Promise<void> {
        mkdirSync(join(this.root, HANDLERS, key), { recursive: true });
        await writeFile(this.sourceOf(key), source, 'utf8');
        this.#versions.set(key, hash(source));
    }

    /** Deletes a handler's file and forgets its version. */
    async remove(key: string): Promise<void> {
        this.#versions.delete(key);
        await rm(join(this.root, HANDLERS, key), { recursive: true, force: true });
    }

    run(key: string, input: HandlerRequest, opts: RunOptions = {}): Promise<Outcome> {
        const worker = this.#ensure();
        const id = ++this.#next;
        const message: ToWorker = {
            type: 'run',
            id,
            file: this.sourceOf(key),
            version: this.#versions.get(key) ?? this.#version(key),
            db: opts.db ?? this.db,
            input,
            bindings: opts.bindings ?? this.#bindings(),
        };
        return new Promise<Outcome>((settle) => {
            const call: Call = {
                settle,
                started: Date.now(),
                left: this.#timeout,
                waiting: 0,
                probe: Boolean(opts.probe),
                input,
            };
            this.#calls.set(id, call);
            this.#tick(id, call);
            worker.postMessage(message);
        });
    }

    /** Closes the worker's handle on a borrowed world, so its file can be deleted. */
    release(db: string): void {
        this.#worker?.postMessage({ type: 'close', db } satisfies ToWorker);
    }

    async dispose(): Promise<void> {
        const worker = this.#worker;
        this.#worker = undefined;
        this.#failAll('the server is shutting down');
        await worker?.terminate();
    }

    // -----------------------------------------------------------------------

    #ensure(): Worker {
        if (this.#worker) {
            return this.#worker;
        }
        const entry = new URL(
            import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
            import.meta.url,
        );
        let worker: Worker;
        try {
            worker = new Worker(entry, { stdout: true, stderr: true, env: {} });
        } catch (err) {
            throw new WorkerUnavailable(
                `could not start the handler worker: ${err instanceof Error ? err.message : String(err)}`,
                { hint: 'Node.js 24 or later is required to run TypeScript handlers' },
            );
        }
        // Handler chatter is not the server's log; read it so it never backs up.
        worker.stdout.resume();
        worker.stderr.resume();
        worker.on('message', (m: FromWorker) => void this.#message(worker, m));
        worker.on('error', (err) =>
            this.#lost(worker, `the worker crashed: ${err.message}`, err.stack),
        );
        worker.on('exit', () => this.#lost(worker, 'the worker exited'));
        this.#worker = worker;
        return worker;
    }

    async #message(worker: Worker, m: FromWorker): Promise<void> {
        const call = this.#calls.get(m.id);
        if (!call) {
            return;
        }
        if (m.type === 'done') {
            this.#finish(m.id, call, {
                used: m.used,
                ...(m.ok
                    ? { ok: true, value: m.value, status: m.status }
                    : call.agentError
                      ? { ok: false, fault: call.agentError, stderr: m.stderr, agentFault: true }
                      : { ok: false, fault: m.fault, stderr: m.stderr }),
                durationMs: Date.now() - call.started,
            });
            return;
        }
        // An agent is about to work: the handler's clock stops until it is done.
        this.#pause(call);
        call.waiting++;
        let reply: ToWorker;
        try {
            if (!this.synthesize) {
                throw new Error('this server has no world agent to make content with');
            }
            const records = await this.synthesize(m.request, {
                db: m.db,
                probe: call.probe,
                input: call.input,
            });
            reply = { type: 'synthesized', id: m.id, call: m.call, records };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            call.agentError = `the world agent could not make ${m.request?.collection ?? 'content'}: ${error}`;
            reply = { type: 'synthesized', id: m.id, call: m.call, error };
        }
        call.waiting--;
        if (this.#calls.get(m.id) === call && this.#worker === worker) {
            worker.postMessage(reply);
            this.#tick(m.id, call);
        }
    }

    #tick(id: number, call: Call): void {
        if (call.waiting > 0 || call.timer) {
            return;
        }
        call.since = Date.now();
        call.timer = setTimeout(
            () => {
                call.timer = undefined;
                this.#finish(id, call, {
                    ok: false,
                    fault: `took longer than ${this.#timeout / 1000}s`,
                    durationMs: Date.now() - call.started,
                });
                // The only way to stop a synchronous loop is to stop its thread.
                const worker = this.#worker;
                this.#worker = undefined;
                this.#failAll(
                    'was interrupted: another handler timed out and the worker restarted',
                );
                void worker?.terminate();
            },
            Math.max(1, call.left),
        );
    }

    #pause(call: Call): void {
        if (call.timer) {
            clearTimeout(call.timer);
            call.timer = undefined;
            call.left -= Date.now() - (call.since ?? Date.now());
        }
    }

    #finish(id: number, call: Call, outcome: Outcome): void {
        if (call.timer) {
            clearTimeout(call.timer);
            call.timer = undefined;
        }
        this.#calls.delete(id);
        call.settle(outcome);
    }

    #lost(worker: Worker, why: string, stderr?: string): void {
        if (this.#worker === worker) {
            this.#worker = undefined;
            this.#failAll(why, stderr);
        }
    }

    #failAll(fault: string, stderr?: string): void {
        for (const [id, call] of [...this.#calls]) {
            this.#finish(id, call, {
                ok: false,
                fault,
                stderr,
                durationMs: Date.now() - call.started,
            });
        }
    }

    #version(key: string): string {
        try {
            return hash(readFileSync(this.sourceOf(key), 'utf8'));
        } catch {
            return 'missing';
        }
    }
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);
