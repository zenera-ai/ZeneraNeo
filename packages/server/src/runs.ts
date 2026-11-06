// Chat turns (runs). A run belongs to the process, not to the request that started it: it goes on
// when the browser leaves, writes every AG-UI event to its run log, and can be followed again at
// any time, also long after it ended. Only a cancel, the run time cap or the pod stopping end it early.
// The same code serves private chats (runtime) and Test-tab chats (manager): a ChatStore
// (sessions.ts) says where a thread's things are.
//   runsRouter(store)     - POST /:tid/runs (start a run and follow it; with AG-UI `resume`
//                           entries instead of a message: continue a run that stopped suspended,
//                           sent only by zenera-app's interrupt service), GET /:tid/runs/:runId/events
//                           (follow a run, or replay it once ended), POST /:tid/runs/:runId/cancel,
//                           DELETE /:tid (the thread, its session and its run logs)
//   runDebugRouter(store) - GET /:tid/runs, /:tid/runs/:runId, /:tid/runs/:runId/report: the
//                           recorded runs, for the Test tab's Debug panel
//   activeRuns   - how many runs are going; currentRun - the one on a thread, if any
//   stopAllRuns  - end every run as interrupted, for a process shutting down
import type { AGUIEvent, ResumeEntry, RunAgentInput } from '@ag-ui/core';
import * as engineLib from '@zenera/engine';
import { runEngine, type Engine, type RunIdentity } from '@zenera/engine';
import { turns, type AgentEvent } from '@zenera/neo';
import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AguiTranslator } from './agui.ts';
import { settings } from './config.ts';
import { HttpError } from './http.ts';
import { runUser } from './identity.ts';
import { readRunLog, RunLog, threadRunLogs } from './runLog.ts';
import {
    listRunRecords,
    recordedReport,
    recordOutcome,
    saveRecord,
    startRecord,
    type RunRecord,
} from './runRecords.ts';
import {
    asHttpError,
    errorMessage,
    openEngineFor,
    usesMemory,
    type ChatStore,
    type ChatThread,
} from './store.ts';

const MAX_INPUT_CHARS = 100_000;
const ID = /^[\w-]{1,80}$/;

// Why a run was stopped: a cancel ends it as cancelled, the others as a RUN_ERROR saying why.
class RunStop extends Error {
    readonly code: 'cancelled' | 'timeout' | 'interrupted';
    constructor(code: RunStop['code'], message: string) {
        super(message);
        this.code = code;
    }
}

interface ActiveRun {
    runId: string;
    owner: string;
    controller: AbortController;
    log: RunLog;
    done: Promise<void>;
    record: RunRecord;
}

// By thread id.
const runs = new Map<string, ActiveRun>();
// Set by stopAllRuns: a run started after it would be cut off mid-turn by the exit that follows.
let stopping = false;

export function activeRuns(): number {
    return runs.size;
}

export function currentRun(t: ChatThread): { runId: string } | null {
    const run = runs.get(t.id);
    return run && run.owner === t.owner ? { runId: run.runId } : null;
}

interface UserMessage {
    id: string;
    text: string;
}

// The newest user message of an AG-UI RunAgentInput; the thread's history is the runtime's own.
function inputOf(body: unknown): UserMessage {
    const messages = (body as { messages?: unknown })?.messages;
    const last = Array.isArray(messages) ? messages.at(-1) : undefined;
    if (!last || last.role !== 'user') {
        throw new HttpError(400, 'the last message must be the user message to answer');
    }
    const parts: unknown[] =
        typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    if (!Array.isArray(parts)) throw new HttpError(400, 'message content must be text');
    const text = parts
        .map((p) => {
            const part = p as { type?: unknown; text?: unknown };
            if (part?.type !== 'text' || typeof part.text !== 'string') {
                throw new HttpError(400, 'only text messages are supported');
            }
            return part.text;
        })
        .join('\n')
        .trim();
    if (!text) throw new HttpError(400, 'the message is empty');
    if (text.length > MAX_INPUT_CHARS) {
        throw new HttpError(413, `the message is longer than ${MAX_INPUT_CHARS} characters`);
    }
    return { id: typeof last.id === 'string' && ID.test(last.id) ? last.id : randomUUID(), text };
}

// The answers zenera-app sends to resume a suspended run (AG-UI ResumeEntry), checked.
function resumeOf(body: unknown): ResumeEntry[] | null {
    const resume = (body as { resume?: unknown })?.resume;
    if (resume === undefined) return null;
    if (!Array.isArray(resume) || !resume.length) {
        throw new HttpError(400, 'resume must be a non-empty list of answers');
    }
    return resume.map((r) => {
        const e = r as Partial<ResumeEntry>;
        if (
            typeof e?.interruptId !== 'string' ||
            (e.status !== 'resolved' && e.status !== 'cancelled')
        ) {
            throw new HttpError(400, 'each resume entry needs an interruptId and a status');
        }
        return { interruptId: e.interruptId, status: e.status, payload: e.payload };
    });
}

type ResumeAnswer =
    | { status: 'resolved'; rerun: true }
    | { status: 'resolved'; payload: unknown }
    | { status: 'cancelled'; message?: string };

// Resume entries name interrupts; the engine answers calls. A suspension's data carries the
// interrupt id zenera-app gave it. resolved without a payload: what was needed is done, run the
// call again; with one: the payload is the call's result.
function answersFor(state: Engine['state'], entries: ResumeEntry[]): Record<string, ResumeAnswer> {
    const suspended =
        (
            state as
                { suspended?: { callId: string; data?: { interruptId?: unknown } }[] } | undefined
        )?.suspended ?? [];
    const answers: Record<string, ResumeAnswer> = {};
    for (const e of entries) {
        const s = suspended.find((x) => (x.data?.interruptId ?? x.callId) === e.interruptId);
        if (!s) continue;
        const payload = e.payload as { message?: unknown } | undefined;
        answers[s.callId] =
            e.status === 'cancelled'
                ? {
                      status: 'cancelled',
                      message: typeof payload?.message === 'string' ? payload.message : undefined,
                  }
                : e.payload === undefined
                  ? { status: 'resolved', rerun: true }
                  : { status: 'resolved', payload: e.payload };
    }
    return answers;
}

// The interrupt ids a thread's saved state waits on; none when it is not suspended.
function waitingOn(store: ChatStore, t: ChatThread): Set<string> {
    const session = store.existingSession(t);
    if (!session || !existsSync(session.state)) return new Set();
    try {
        const state = JSON.parse(readFileSync(session.state, 'utf8')) as {
            suspended?: { callId: string; data?: { interruptId?: unknown } }[];
        };
        return new Set(
            (state.suspended ?? []).map((s) =>
                typeof s.data?.interruptId === 'string' ? s.data.interruptId : s.callId,
            ),
        );
    } catch {
        return new Set();
    }
}

type ResumeEngine = (
    engine: Engine,
    answers: Record<string, ResumeAnswer>,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
) => ReturnType<typeof runEngine>;

// Read at call time: an older @zenera/engine without it still loads, and says so on resume.
function resumeEngineFn(): ResumeEngine {
    const fn = (engineLib as unknown as { resumeEngine?: ResumeEngine }).resumeEngine;
    if (!fn) throw new Error('this zen version cannot resume a suspended run; update zen');
    return fn;
}

function startStream(res: Response): (events: AGUIEvent[]) => void {
    res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    return (events) => {
        for (const e of events) {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
    };
}

// Follows a run to its end, or until the browser leaves; leaving does not stop the run.
function follow(res: Response, log: RunLog): void {
    const send = startStream(res);
    const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    const unfollow = log.follow({
        events: send,
        end: () => {
            clearInterval(heartbeat);
            res.end();
        },
    });
    res.on('close', () => {
        clearInterval(heartbeat);
        unfollow();
    });
}

// Never throws: whatever ends the run is written to its log as the run's last event.
async function execute(
    store: ChatStore,
    t: ChatThread,
    run: ActiveRun,
    turn: { message: UserMessage } | { resume: ResumeEntry[] },
    memory: boolean,
    user: RunIdentity | null,
    mcpToken: string | null,
): Promise<void> {
    const { runId, log, controller } = run;
    let engine: Engine | undefined;
    const translator = new AguiTranslator({
        threadId: t.id,
        runId,
        resolve: async (p) => (engine ? engine.runner.services.payloads.get(p) : ''),
    });
    const input: RunAgentInput = {
        threadId: t.id,
        runId,
        messages:
            'message' in turn
                ? [{ id: turn.message.id, role: 'user', content: turn.message.text }]
                : [],
        ...('resume' in turn ? { resume: turn.resume } : {}),
        tools: [],
        context: [],
        forwardedProps: {},
    };
    log.append(translator.started(input));
    const maxMinutes = settings().maxRunMinutes;
    const timer = setTimeout(
        () =>
            controller.abort(
                new RunStop('timeout', `the run took longer than ${maxMinutes} minutes`),
            ),
        maxMinutes * 60_000,
    );
    const stopped = () =>
        controller.signal.reason instanceof RunStop ? controller.signal.reason : undefined;

    // runEngine calls back synchronously; translating may await payloads, so keep the order here.
    let chain = Promise.resolve();
    const onEvent = (ev: AgentEvent) => {
        chain = chain
            .then(async () => {
                const why = stopped();
                // Stopped for anything but a cancel: the run did not finish, say why instead.
                if (ev.type === 'run_finished' && !ev.branch && why && why.code !== 'cancelled') {
                    log.append(translator.fail(why, why.code));
                } else {
                    log.append(await translator.translate(ev));
                }
            })
            .catch((err) => console.error(`run ${runId}: translating ${ev.type}:`, err));
    };

    try {
        engine = await openEngineFor(
            store.sessionFor(t),
            memory ? store.engineMemoryDir(t) : undefined,
            user,
            mcpToken,
        );
        const before = {
            usage: engine.state?.usage,
            modelCalls: engine.state ? turns(engine.state) : 0,
            trajectoryLength: engine.state?.trajectory.length ?? 0,
        };
        const outcome =
            'message' in turn
                ? await runEngine(engine, turn.message.text, onEvent, controller.signal)
                : await resumeEngineFn()(
                      engine,
                      answersFor(engine.state, turn.resume),
                      onEvent,
                      controller.signal,
                  );
        recordOutcome(run.record, outcome, before);
        const why = stopped();
        if (why) {
            run.record.status = why.code;
            run.record.error = why.message;
        }
        saveRecord(store.runsDir(t), run.record);
    } catch (err) {
        await chain;
        const why = stopped();
        if (!why) console.error(`run ${runId}:`, err);
        run.record.status = why?.code ?? 'error';
        run.record.error = why?.message ?? errorMessage(err);
        log.append(translator.fail(why ?? new Error(errorMessage(err)), why?.code ?? 'error'));
    } finally {
        clearTimeout(timer);
        await chain;
        log.append(translator.fail(new Error('the run ended without a result')));
        await engine?.close().catch((err) => console.error(`run ${runId}: closing:`, err));
        run.record.finishedAt = new Date().toISOString();
        run.record.durationMs ??= Date.now() - Date.parse(run.record.startedAt);
        try {
            saveRecord(store.runsDir(t), run.record);
        } catch (err) {
            console.error(`run ${runId}: saving diagnostics:`, err);
        }
        await log.end().catch((err) => console.error(`run ${runId}: saving its log:`, err));
        runs.delete(t.id);
    }
}

/** Runs may start again: a new server in a process whose previous one stopped. */
export function acceptRuns(): void {
    stopping = false;
}

export async function stopAllRuns(timeoutMs: number): Promise<void> {
    stopping = true;
    const all = [...runs.values()];
    for (const run of all) {
        run.controller.abort(
            new RunStop('interrupted', 'the run was interrupted: the server is stopping'),
        );
    }
    await Promise.race([
        Promise.all(all.map((run) => run.done)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

export function runsRouter(store: ChatStore): Router {
    const router = Router();

    router.post('/:tid/runs', async (req, res) => {
        const t = store.thread(req);
        const resume = resumeOf(req.body);
        const turn = resume ? { resume } : { message: inputOf(req.body) };
        const runId = ID.test(req.body?.runId ?? '') ? String(req.body.runId) : randomUUID();

        if (stopping) {
            res.set('Retry-After', '5');
            throw new HttpError(503, 'the server is stopping, try again shortly');
        }
        const running = runs.get(t.id);
        // Answers to what the chat no longer waits on (a new message went first): nothing to run.
        if (!running && resume) {
            const waiting = waitingOn(store, t);
            if (!resume.some((e) => waiting.has(e.interruptId))) {
                res.status(409).json({
                    error: 'this chat is not waiting on those interrupts',
                    code: 'not_waiting',
                });
                return;
            }
        }
        if (running) {
            res.status(409).json({ error: 'this chat is still answering', runId: running.runId });
            return;
        }
        if (runs.size >= settings().maxRuns) {
            res.set('Retry-After', '10');
            throw new HttpError(
                429,
                'too many chats are answering in this project, try again shortly',
            );
        }
        // Whether the run gets the owner's memory; it no longer limits how many run at once.
        let memory: boolean;
        try {
            memory = usesMemory();
        } catch (err) {
            throw asHttpError(err);
        }
        const mine = [...runs.values()].filter((r) => r.owner === t.owner).length;
        if (mine >= store.maxOwnerRuns) throw new HttpError(409, store.ownerBusy);

        // Nothing awaited from the checks above to here: the thread's slot is taken at once.
        const dir = store.runsDir(t);
        const record = startRecord(dir, runId);
        const run: ActiveRun = {
            runId,
            owner: t.owner,
            controller: new AbortController(),
            log: RunLog.open(dir, runId, settings().runLogMaxBytes),
            done: Promise.resolve(),
            record,
        };
        runs.set(t.id, run);
        // The caller's token for this run's MCP tools (zenera-app's broker, mcp/broker.ts there);
        // whatever stands in front of the server decides who may send one.
        const mcpToken = req.get('x-zenera-mcp-token') || null;
        run.done = execute(store, t, run, turn, memory, runUser(), mcpToken);
        follow(res, run.log);
    });

    router.get('/:tid/runs/:runId/events', async (req, res) => {
        const t = store.thread(req);
        const runId = String(req.params.runId);
        const run = runs.get(t.id);
        if (run && run.runId === runId && run.owner === t.owner) {
            follow(res, run.log);
            return;
        }
        const ended = (await threadRunLogs(store.runsDir(t))).find((r) => r.runId === runId);
        if (!ended) throw new HttpError(404, 'no such run');
        const events = await readRunLog(ended.file);
        startStream(res)(events);
        res.end();
    });

    router.post('/:tid/runs/:runId/cancel', (req, res) => {
        const t = store.thread(req);
        const run = runs.get(t.id);
        if (!run || run.runId !== req.params.runId || run.owner !== t.owner) {
            throw new HttpError(404, 'no such run');
        }
        run.controller.abort(new RunStop('cancelled', 'cancelled'));
        res.status(202).json({ ok: true });
    });

    router.delete('/:tid', async (req, res) => {
        const t = store.thread(req);
        const run = runs.get(t.id);
        if (run && run.owner === t.owner) {
            run.controller.abort(new RunStop('cancelled', 'the chat was deleted'));
            await run.done;
        }
        await store.removeThread(t);
        res.status(204).end();
    });

    return router;
}

export function runDebugRouter(store: ChatStore): Router {
    const router = Router();

    const records = (t: ChatThread) =>
        listRunRecords(store.runsDir(t), store.existingSession(t), currentRun(t)?.runId);

    router.get('/:tid/runs', async (req, res) => {
        const t = store.thread(req);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ runs: await records(t) });
    });

    router.get('/:tid/runs/:runId', async (req, res) => {
        const t = store.thread(req);
        const run = (await records(t)).find((r) => r.runId === req.params.runId);
        if (!run) throw new HttpError(404, 'no such run');
        res.setHeader('Cache-Control', 'no-store');
        res.json({ run });
    });

    router.get('/:tid/runs/:runId/report', async (req, res) => {
        const t = store.thread(req);
        const html = await recordedReport(
            store.runsDir(t),
            store.existingSession(t),
            String(req.params.runId),
        );
        res.setHeader('Cache-Control', 'no-store');
        res.json({ html });
    });

    return router;
}
