// Tests for suspending a run on a tool call and resuming it (runner.ts, kernel.ts, types.ts suspend):
// a run stops `suspended` with the call pending and saved in `state.suspended`; resume re-runs the
// call, hands it an answer, or cancels it; a new message cancels what is still suspended; a state
// survives JSON round-trips; fork branches cannot suspend. Also suspending at a model call through
// `onModelError` (`site: 'llm'`): resume makes the call again, cancel ends the run, a new message
// releases it, and nothing suspends once the answer started streaming or inside a fork branch.
import { describe, expect, it } from 'vitest';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { isOutOfCredits } from '../src/failure.ts';
import { AgentRunner, SUPERSEDED_MESSAGE } from '../src/runner.ts';
import { assertState, type AgentState } from '../src/state.ts';
import { suspend, tool, zeroUsage, type ToolCall } from '../src/types.ts';

type Rule = (req: ModelRequest) => ModelResponse | undefined;

class RuleModel implements Model {
    readonly id = 'scripted';
    calls = 0;
    readonly #rules: Rule[];
    constructor(...rules: Rule[]) {
        this.#rules = rules;
    }
    async generate(req: ModelRequest): Promise<ModelResponse> {
        this.calls++;
        for (const rule of this.#rules) {
            const res = rule(req);
            if (res) return { usage: zeroUsage(), ...res };
        }
        throw new Error('no rule matched');
    }
}

let seq = 0;
const call = (name: string, args: unknown = {}): ModelResponse => ({
    text: '',
    toolCalls: [{ id: `c${++seq}`, name, args: JSON.stringify(args) } satisfies ToolCall],
    stopReason: 'tool_calls',
});
const say = (text: string): ModelResponse => ({ text, toolCalls: [], stopReason: 'stop' });
const toolMessage = (req: ModelRequest, name: string) =>
    [...req.messages].reverse().find((m) => m.role === 'tool' && m.name === name);
const lastUser = (req: ModelRequest) =>
    [...req.messages]
        .reverse()
        .find((m) => m.role === 'user')
        ?.content.map((p) => (p.type === 'text' ? p.text : ''))
        .join('');

/** A tool that needs a person until `connected` is true. */
function setup() {
    const world = { connected: false, runs: 0 };
    const github = tool<Record<string, never>>({
        name: 'github',
        description: 'Reads GitHub',
        parameters: { type: 'object', properties: {} },
        execute: () => {
            world.runs++;
            return world.connected
                ? { login: 'octocat' }
                : suspend({
                      reason: 'mcp_auth',
                      message: 'Connect GitHub',
                      data: { server: 'github' },
                  });
        },
    });
    const model = new RuleModel(
        (req) => {
            const last = req.messages.at(-1);
            return last?.role === 'tool' && last.name === 'github'
                ? say(`tool said: ${last.content}`)
                : undefined;
        },
        (req) => (lastUser(req)?.includes('github') ? call('github') : undefined),
        (req) => say(`you said: ${lastUser(req)}`),
    );
    const runner = new AgentRunner({ model });
    runner.agent({ name: 'main', instructions: 'MAIN', tools: [github] });
    return { world, runner, model };
}

/** As a host persists and reloads it. */
const persist = (state: AgentState) => assertState(JSON.parse(JSON.stringify(state)));

describe('suspend and resume', () => {
    it('stops suspended with the call pending and the pause described', async () => {
        const { runner, world } = setup();
        const seen: string[] = [];
        const stream = runner.run('main', 'show my github');
        for await (const e of stream) seen.push(e.type);
        const res = await stream.final();

        expect(res.stopReason).toBe('suspended');
        expect(world.runs).toBe(1);
        expect(res.state.phase).toBe('awaiting_tools');
        expect(res.state.pendingToolCalls).toHaveLength(1);
        expect(res.state.suspended).toEqual([
            expect.objectContaining({
                callId: res.state.pendingToolCalls[0],
                name: 'github',
                reason: 'mcp_auth',
                message: 'Connect GitHub',
                data: { server: 'github' },
            }),
        ]);
        expect(typeof res.state.suspended![0].at).toBe('string');
        expect(seen).toContain('before_tool_call');
        expect(seen).not.toContain('after_tool_call');
        expect(seen.at(-1)).toBe('run_finished');
        expect(res.state.trajectory.some((n) => n.type === 'tool_result')).toBe(false);
    });

    it('resolved + rerun runs the call again, and the run finishes', async () => {
        const { runner, world } = setup();
        const paused = persist((await runner.run('main', 'show my github')).state);
        const callId = paused.suspended![0].callId;

        world.connected = true;
        const res = await runner.resume(paused, {
            answers: { [callId]: { status: 'resolved', rerun: true } },
        });
        expect(res.stopReason).toBe('final');
        expect(world.runs).toBe(2);
        expect(res.output).toBe('tool said: {"login":"octocat"}');
        expect(res.state.suspended).toBeUndefined();
        expect(res.state.pendingToolCalls).toEqual([]);
    });

    it('resolved + payload makes the answer the call’s result, without running it', async () => {
        const { runner, world } = setup();
        const paused = (await runner.run('main', 'show my github')).state;
        const callId = paused.suspended![0].callId;
        const res = await runner.resume(paused, {
            answers: { [callId]: { status: 'resolved', payload: { login: 'from-a-person' } } },
        });
        expect(world.runs).toBe(1);
        expect(res.output).toBe('tool said: {"login":"from-a-person"}');
    });

    it('cancelled gives the call an error result and the agent continues', async () => {
        const { runner, world } = setup();
        const paused = (await runner.run('main', 'show my github')).state;
        const callId = paused.suspended![0].callId;
        const res = await runner.resume(paused, {
            answers: {
                [callId]: { status: 'cancelled', message: 'the user chose not to connect' },
            },
        });
        expect(world.runs).toBe(1);
        expect(res.stopReason).toBe('final');
        expect(res.output).toBe('tool said: the user chose not to connect');
        const result = res.state.trajectory.find((n) => n.type === 'tool_result');
        expect(result && 'isError' in result && result.isError).toBe(true);
    });

    it('resume without an answer stops suspended again, running nothing', async () => {
        const { runner, world, model } = setup();
        const paused = (await runner.run('main', 'show my github')).state;
        const calls = model.calls;
        const res = await runner.resume(paused, { answers: { other: { status: 'cancelled' } } });
        expect(res.stopReason).toBe('suspended');
        expect(world.runs).toBe(1);
        expect(model.calls).toBe(calls);
    });

    it('rerun that still needs a person suspends again', async () => {
        const { runner, world } = setup();
        const paused = (await runner.run('main', 'show my github')).state;
        const callId = paused.suspended![0].callId;
        const res = await runner.resume(paused, {
            answers: { [callId]: { status: 'resolved', rerun: true } },
        });
        expect(world.runs).toBe(2);
        expect(res.stopReason).toBe('suspended');
        expect(res.state.suspended?.[0].callId).toBe(callId);
    });

    it('a new message cancels what is still suspended, then is answered', async () => {
        const { runner, world } = setup();
        const paused = (await runner.run('main', 'show my github')).state;
        const res = await runner.send(paused, 'never mind, hello');
        expect(world.runs).toBe(1);
        expect(res.stopReason).toBe('final');
        expect(res.output).toBe('you said: never mind, hello');
        expect(res.state.suspended).toBeUndefined();
        const result = res.state.trajectory.find((n) => n.type === 'tool_result');
        expect(result).toBeDefined();
        const text = await runner.services.payloads.get(
            (result as { result: Parameters<typeof runner.services.payloads.get>[0] }).result,
        );
        expect(text).toBe(SUPERSEDED_MESSAGE);
    });

    it('a fork branch cannot suspend: the call gets an error and the branch goes on', async () => {
        const world = { runs: 0 };
        const needsPerson = tool<Record<string, never>>({
            name: 'needs_person',
            description: 'Needs a person',
            parameters: { type: 'object', properties: {} },
            execute: () => {
                world.runs++;
                return suspend({ reason: 'input', message: 'who?' });
            },
        });
        const model = new RuleModel(
            (req) => {
                const m = toolMessage(req, 'needs_person');
                return m && m.role === 'tool' ? say(`branch saw: ${m.content}`) : undefined;
            },
            (req) => (lastUser(req) === 'do it' ? call('needs_person') : undefined),
            (req) => {
                const m = toolMessage(req, 'fork');
                return m && m.role === 'tool' ? say('joined') : undefined;
            },
            () =>
                call('fork', {
                    branches: [{ name: 'b1', instructions: 'do it' }],
                    context: 'none',
                }),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'main', instructions: 'MAIN', tools: [needsPerson], fork: {} });
        const res = await runner.run('main', 'go');
        expect(res.stopReason).toBe('final');
        expect(res.state.suspended).toBeUndefined();
        expect(world.runs).toBe(1);
    });
});

describe('suspending from a plugin with no dependencies', () => {
    it('a registered-symbol object suspends like suspend()', async () => {
        const plain = tool<Record<string, never>>({
            name: 'github',
            description: 'Reads GitHub',
            parameters: { type: 'object', properties: {} },
            execute: () => ({
                [Symbol.for('zenera.neo.toolSuspend')]: true,
                spec: { reason: 'mcp_auth', data: { interruptId: 'i-1' } },
            }),
        });
        const model = new RuleModel(() => call('github'));
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'main', instructions: 'MAIN', tools: [plain] });
        const res = await runner.run('main', 'go');
        expect(res.stopReason).toBe('suspended');
        expect(res.state.suspended?.[0]).toMatchObject({
            reason: 'mcp_auth',
            data: { interruptId: 'i-1' },
        });
    });
});

describe('suspending at a model call (onModelError)', () => {
    const OUT = 'Budget exceeded: customer acme budget exceeded: 1 >= 1 dollars';
    const outOfCredits = () => Object.assign(new Error(`402 ${OUT}`), { status: 402 });
    const WAIT = { reason: 'out_of_credits', data: { kind: 'billing' } };

    /** A model that is refused while `world.broke`, and otherwise echoes the user. */
    function setupBroke(opts: { onModelError?: boolean; streamFirst?: boolean } = {}) {
        const world = { broke: true, calls: 0, asked: 0 };
        const model: Model = {
            id: 'scripted',
            async generate(req: ModelRequest): Promise<ModelResponse> {
                world.calls++;
                if (world.broke) throw outOfCredits();
                return { usage: zeroUsage(), ...say(`you said: ${lastUser(req)}`) };
            },
            ...(opts.streamFirst
                ? {
                      async stream(_req: ModelRequest, onDelta: (d: never) => void) {
                          world.calls++;
                          onDelta({ type: 'text_delta', delta: 'Hel' } as never);
                          throw outOfCredits();
                      },
                  }
                : {}),
        };
        const runner = new AgentRunner({
            model,
            onModelError:
                opts.onModelError === false
                    ? undefined
                    : (err) => {
                          world.asked++;
                          return isOutOfCredits(err) ? WAIT : undefined;
                      },
        });
        runner.agent({ name: 'main', instructions: 'MAIN' });
        return { world, runner };
    }

    it('stops suspended at the model call, the call recorded with site llm', async () => {
        const { runner, world } = setupBroke();
        const res = await runner.run('main', 'hello');
        expect(res.stopReason).toBe('suspended');
        expect(res.state.suspended).toEqual([
            expect.objectContaining({
                callId: 'llm:0',
                name: 'scripted',
                site: 'llm',
                reason: 'out_of_credits',
                data: { kind: 'billing' },
            }),
        ]);
        expect(res.state.pendingToolCalls).toEqual([]);
        expect(world.calls).toBe(1);
        expect(res.state.trajectory.some((n) => n.type === 'llm_call')).toBe(false);
    });

    it('resolved makes the same call again, preparing nothing twice', async () => {
        const { runner, world } = setupBroke();
        const paused = persist((await runner.run('main', 'hello')).state);
        const prompts = paused.trajectory.filter((n) => n.type === 'system_prompt').length;

        world.broke = false;
        const res = await runner.resume(paused, {
            answers: { 'llm:0': { status: 'resolved', rerun: true } },
        });
        expect(res.stopReason).toBe('final');
        expect(res.output).toBe('you said: hello');
        expect(res.state.suspended).toBeUndefined();
        expect(world.calls).toBe(2);
        expect(res.state.trajectory.filter((n) => n.type === 'system_prompt')).toHaveLength(
            prompts,
        );
    });

    it('resume without an answer, or still refused, stops suspended again', async () => {
        const { runner, world } = setupBroke();
        const paused = (await runner.run('main', 'hello')).state;

        const unanswered = await runner.resume(paused, { answers: {} });
        expect(unanswered.stopReason).toBe('suspended');
        expect(world.calls).toBe(1);

        const again = await runner.resume(paused, {
            answers: { 'llm:0': { status: 'resolved', rerun: true } },
        });
        expect(again.stopReason).toBe('suspended');
        expect(again.state.suspended).toHaveLength(1);
        expect(world.calls).toBe(2);
    });

    it('cancelled ends the run without calling the model, and the chat can go on', async () => {
        const { runner, world } = setupBroke();
        const paused = (await runner.run('main', 'hello')).state;
        const stopped = await runner.resume(paused, {
            answers: { 'llm:0': { status: 'cancelled', message: 'stopped' } },
        });
        expect(stopped.stopReason).toBe('aborted');
        expect(stopped.state.suspended).toBeUndefined();
        expect(world.calls).toBe(1);

        world.broke = false;
        const next = await runner.send(stopped.state, 'again');
        expect(next.stopReason).toBe('final');
        expect(next.output).toBe('you said: again');
    });

    it('a new message releases the wait and is what the model answers', async () => {
        const { runner, world } = setupBroke();
        const paused = (await runner.run('main', 'hello')).state;
        world.broke = false;
        const res = await runner.send(paused, 'never mind');
        expect(res.stopReason).toBe('final');
        expect(res.output).toBe('you said: never mind');
        expect(res.state.suspended).toBeUndefined();
    });

    it('fails as before when no handler is set, or once the answer started streaming', async () => {
        const none = setupBroke({ onModelError: false });
        await expect(none.runner.run('main', 'hello')).rejects.toThrow(/Budget exceeded/);

        const streaming = setupBroke({ streamFirst: true });
        await expect(streaming.runner.run('main', 'hello')).rejects.toThrow(/Budget exceeded/);
        expect(streaming.world.asked).toBe(0);
    });

    it('a fork branch is never suspended: the branch fails and the trunk goes on', async () => {
        const world = { asked: 0 };
        const model = new RuleModel(
            (req) => {
                if (lastUser(req) === 'do it') throw outOfCredits();
                return undefined;
            },
            (req) => {
                const m = toolMessage(req, 'fork');
                return m && m.role === 'tool' ? say('joined') : undefined;
            },
            () =>
                call('fork', {
                    branches: [{ name: 'b1', instructions: 'do it' }],
                    context: 'none',
                }),
        );
        const runner = new AgentRunner({
            model,
            onModelError: () => {
                world.asked++;
                return WAIT;
            },
        });
        runner.agent({ name: 'main', instructions: 'MAIN', fork: {} });
        const res = await runner.run('main', 'go');
        expect(res.stopReason).toBe('final');
        expect(res.state.suspended).toBeUndefined();
        expect(world.asked).toBe(0);
    });
});
