// Tests for the runner making a failing model call again (runner.ts `modelRetry`, kernel.ts
// applyStall/clearStall): a transient failure (5xx, 429, a dropped connection) is retried with a
// `model_retry` event before each wait and `model_retry_recovered` once it answers; a refusal (4xx),
// a stream that already started, and a run with retries off fail at once as before; Stop ends the
// wait; a call that keeps failing past the window stops the run `failed` with `state.stalled`, kept
// before the call, so resume makes it again and a new message is answered from there.
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/events.ts';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { AgentRunner, type ModelRetryPolicy } from '../src/runner.ts';
import type { AgentState } from '../src/state.ts';
import { zeroUsage } from '../src/types.ts';

const FAST: ModelRetryPolicy = { windowMs: 200, initialMs: 1, maxMs: 2 };

const lastUser = (req: ModelRequest) =>
    [...req.messages]
        .reverse()
        .find((m) => m.role === 'user')
        ?.content.map((p) => (p.type === 'text' ? p.text : ''))
        .join('');

const providerDown = () =>
    Object.assign(new Error('502 failed to execute HTTP request to provider API'), {
        status: 502,
    });

/** A model that fails with `fail()` the first `failures` calls, then echoes the user. */
function setup(opts: {
    failures: number;
    fail?: () => Error;
    retry?: ModelRetryPolicy;
    streamFirst?: boolean;
}) {
    const world = { calls: 0, failures: opts.failures };
    const answer = (req: ModelRequest): ModelResponse => {
        world.calls++;
        if (world.failures > 0) {
            world.failures--;
            throw (opts.fail ?? providerDown)();
        }
        return {
            usage: zeroUsage(),
            text: `you said: ${lastUser(req)}`,
            toolCalls: [],
            stopReason: 'stop',
        };
    };
    const model: Model = {
        id: 'scripted',
        generate: async (req) => answer(req),
        ...(opts.streamFirst
            ? {
                  async stream(req: ModelRequest, onDelta: (d: never) => void) {
                      onDelta({ type: 'text_delta', delta: 'Hel' } as never);
                      return answer(req);
                  },
              }
            : {}),
    };
    const runner = new AgentRunner({ model, modelRetry: opts.retry ?? FAST });
    runner.agent({ name: 'main', instructions: 'MAIN' });
    return { world, runner };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const e of stream) events.push(e);
    return events;
}

const persist = (s: AgentState): AgentState => JSON.parse(JSON.stringify(s)) as AgentState;

describe('making a failing model call again', () => {
    it('retries a transient failure, saying so before each wait and when it answered', async () => {
        const { runner, world } = setup({ failures: 2 });
        const stream = runner.run('main', 'hello');
        const events = await collect(stream);
        const res = await stream.final();

        expect(res.stopReason).toBe('final');
        expect(res.output).toBe('you said: hello');
        expect(world.calls).toBe(3);
        const retries = events.filter((e) => e.type === 'model_retry');
        expect(retries).toEqual([
            expect.objectContaining({ attempt: 1, status: 502, model: 'scripted' }),
            expect.objectContaining({ attempt: 2, status: 502 }),
        ]);
        expect(retries[0]).toMatchObject({ error: expect.stringMatching(/502/) });
        expect(Date.parse((retries[0] as { retryAt: string }).retryAt)).not.toBeNaN();
        expect(events.filter((e) => e.type === 'model_retry_recovered')).toEqual([
            expect.objectContaining({ attempts: 3 }),
        ]);
        expect(res.state.stalled).toBeUndefined();
        expect(res.state.trajectory.filter((n) => n.type === 'llm_call')).toHaveLength(1);
    });

    it('retries a rate limit and a dropped connection too', async () => {
        const limited = setup({
            failures: 1,
            fail: () => Object.assign(new Error('429 slow down'), { status: 429 }),
        });
        expect((await limited.runner.run('main', 'hi')).stopReason).toBe('final');
        expect(limited.world.calls).toBe(2);

        const dropped = setup({
            failures: 1,
            fail: () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        });
        expect((await dropped.runner.run('main', 'hi')).stopReason).toBe('final');
        expect(dropped.world.calls).toBe(2);
    });

    it('fails at once on a refusal, a started stream, or with retries off', async () => {
        const refused = setup({
            failures: 1,
            fail: () => Object.assign(new Error('400 bad request'), { status: 400 }),
        });
        await expect(refused.runner.run('main', 'hi')).rejects.toThrow(/400/);
        expect(refused.world.calls).toBe(1);

        const streaming = setup({ failures: 1, streamFirst: true });
        await expect(streaming.runner.run('main', 'hi')).rejects.toThrow(/502/);
        expect(streaming.world.calls).toBe(1);

        const off = setup({ failures: 1, retry: { windowMs: 0 } });
        await expect(off.runner.run('main', 'hi')).rejects.toThrow(/502/);
        expect(off.world.calls).toBe(1);
    });

    it('waits as long as Retry-After asks', async () => {
        const { runner } = setup({
            failures: 1,
            fail: () =>
                Object.assign(new Error('429 slow down'), {
                    status: 429,
                    headers: { 'retry-after-ms': '60' },
                }),
        });
        const started = Date.now();
        const events = await collect(runner.run('main', 'hi'));
        const retry = events.find((e) => e.type === 'model_retry') as { retryAt: string };
        expect(Date.parse(retry.retryAt) - started).toBeGreaterThanOrEqual(55);
        expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    });

    it('stopping during a wait ends the run as aborted, without another call', async () => {
        const { runner, world } = setup({
            failures: 5,
            retry: { windowMs: 60_000, initialMs: 30_000, maxMs: 30_000 },
        });
        const controller = new AbortController();
        const stream = runner.run('main', 'hi', { signal: controller.signal });
        const started = Date.now();
        for await (const e of stream) {
            if (e.type === 'model_retry') controller.abort();
        }
        const res = await stream.final();
        expect(res.stopReason).toBe('aborted');
        expect(world.calls).toBe(1);
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('past the window the run stops failed, stalled before the call, nothing lost', async () => {
        const { runner, world } = setup({
            failures: Infinity,
            retry: { windowMs: 30, initialMs: 5, maxMs: 5 },
        });
        const res = await runner.run('main', 'hello');

        expect(res.stopReason).toBe('failed');
        expect(res.state.phase).not.toBe('failed');
        expect(res.state.stalled).toMatchObject({
            callId: 'llm:0',
            model: 'scripted',
            attempts: world.calls,
            error: expect.stringMatching(/502 .*gave up after \d+ attempts? in/),
        });
        expect(res.state.error).toBe(res.state.stalled!.error);
        expect(res.state.trajectory.some((n) => n.type === 'user_input')).toBe(true);
        expect(res.state.trajectory.some((n) => n.type === 'llm_call')).toBe(false);
    });

    it('resuming a stalled run makes the call again and goes on', async () => {
        const { runner, world } = setup({
            failures: Infinity,
            retry: { windowMs: 20, initialMs: 5, maxMs: 5 },
        });
        const stalled = persist((await runner.run('main', 'hello')).state);
        const prompts = stalled.trajectory.filter((n) => n.type === 'system_prompt').length;

        world.failures = 0;
        const res = await runner.resume(stalled);
        expect(res.stopReason).toBe('final');
        expect(res.output).toBe('you said: hello');
        expect(res.state.stalled).toBeUndefined();
        expect(res.state.error).toBeUndefined();
        expect(res.state.trajectory.filter((n) => n.type === 'system_prompt')).toHaveLength(
            prompts,
        );
    });

    it('a new message after a stall is answered', async () => {
        const { runner, world } = setup({
            failures: Infinity,
            retry: { windowMs: 20, initialMs: 5, maxMs: 5 },
        });
        const stalled = (await runner.run('main', 'hello')).state;
        world.failures = 0;
        const res = await runner.send(stalled, 'are you there?');
        expect(res.stopReason).toBe('final');
        expect(res.output).toBe('you said: are you there?');
        expect(res.state.stalled).toBeUndefined();
    });
});
