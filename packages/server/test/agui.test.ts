import { EventType, type AGUIEvent } from '@ag-ui/core';
import type { AgentEvent, Payload } from '@zenera/neo';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AguiTranslator, clip } from '../src/agui.ts';

const blobs = new Map<string, string>();
const payload = (value: string): Payload => {
    const sha256 = `h${blobs.size}`;
    blobs.set(sha256, value);
    return { store: 'file', sha256, size: value.length };
};
const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 };
const ev = (e: Record<string, unknown>) =>
    ({ runId: 'r', agent: 'intake', ...e }) as unknown as AgentEvent;

function translator() {
    let n = 0;
    return new AguiTranslator({
        threadId: 't',
        runId: 'run1',
        resolve: async (p) => blobs.get(p.sha256) ?? '',
        newId: () => `id${++n}`,
    });
}

async function run(events: AgentEvent[]): Promise<AGUIEvent[]> {
    const t = translator();
    const out = t.started();
    for (const e of events) out.push(...(await t.translate(e)));
    return out;
}

const types = (out: AGUIEvent[]) => out.map((e) => e.type);
const finished = (stopReason: string, error?: string) =>
    ev({
        type: 'run_finished',
        state: { error },
        result: { stopReason, agent: 'intake', usage, state: { error } },
    });

test('streams text between a start and an end, with the call usage on the end', async () => {
    const out = await run([
        ev({ type: 'run_created', state: {} }),
        ev({ type: 'before_llm_call', state: {} }),
        ev({ type: 'text_delta', delta: 'Hel' }),
        ev({ type: 'text_delta', delta: 'lo' }),
        ev({
            type: 'after_llm_call',
            state: {},
            node: { model: 'm', text: payload('Hello'), toolCalls: [], usage },
        }),
        finished('final'),
    ]);
    assert.deepEqual(types(out), [
        EventType.RUN_STARTED,
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.STEP_FINISHED,
        EventType.RUN_FINISHED,
    ]);
    const end = out.find((e) => e.type === EventType.TEXT_MESSAGE_END);
    assert.equal(end?.metadata?.model, 'm');
    const done = out.at(-1) as { outcome?: { type: string } };
    assert.equal(done.outcome?.type, 'success');
});

test('closes reasoning before the answer starts', async () => {
    const out = await run([
        ev({ type: 'before_llm_call', state: {} }),
        ev({ type: 'thinking_delta', delta: 'hmm' }),
        ev({ type: 'text_delta', delta: 'ok' }),
    ]);
    assert.deepEqual(types(out).slice(2), [
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
    ]);
});

test('streams a tool call and reports its result', async () => {
    const out = await run([
        ev({ type: 'before_llm_call', state: {} }),
        ev({ type: 'tool_call_detected', callId: 'c1', name: 'run_command' }),
        ev({
            type: 'tool_args_delta',
            callId: 'c1',
            name: 'run_command',
            delta: '{"cmd":',
            argsSoFar: '',
        }),
        ev({
            type: 'after_llm_call',
            state: {},
            node: {
                model: 'm',
                text: payload(''),
                toolCalls: [{ callId: 'c1', name: 'run_command', args: payload('{"cmd":"ls"}') }],
                usage,
            },
        }),
        ev({
            type: 'after_tool_call',
            state: {},
            node: { callId: 'c1', result: payload('a\nb'), isError: false },
        }),
    ]);
    assert.deepEqual(types(out).slice(2), [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
    ]);
    assert.equal((out.at(-1) as { content: string }).content, 'a\nb');
});

test('sends a tool call the model did not stream whole, from the checkpoint', async () => {
    const out = await run([
        ev({ type: 'before_llm_call', state: {} }),
        ev({
            type: 'after_llm_call',
            state: {},
            node: {
                model: 'm',
                text: payload('Let me look.'),
                toolCalls: [{ callId: 'c2', name: 'read_file', args: payload('{"path":"a"}') }],
                usage,
            },
        }),
    ]);
    assert.deepEqual(types(out).slice(2), [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]);
    assert.equal((out[6] as { delta: string }).delta, '{"path":"a"}');
});

test('turns a hand-off into steps and a branch into a subagent', async () => {
    const branch = { forkId: 'f1', name: 'research', runId: 'child1', depth: 1 };
    const out = await run([
        ev({ type: 'handoff', state: {}, from: 'intake', to: 'adjuster' }),
        ev({ type: 'before_fork', state: {}, node: { id: 'f1', callId: 'c9' } }),
        ev({
            type: 'branch_started',
            state: {},
            child: branch,
            childState: { agentName: 'researcher' },
        }),
        ev({ type: 'text_delta', delta: 'found it', branch }),
        ev({ type: 'branch_finished', state: {}, child: branch, childState: {}, status: 'ok' }),
    ]);
    assert.deepEqual(types(out).slice(2), [
        EventType.STEP_FINISHED,
        EventType.STEP_STARTED,
        EventType.SUBAGENT_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.SUBAGENT_FINISHED,
    ]);
    const started = out[4] as { parentToolCallId?: string; name: string };
    assert.equal(started.parentToolCallId, 'c9');
    assert.equal((out[5] as { subagentRunId?: string }).subagentRunId, 'child1');
});

test('ends a failed run with RUN_ERROR, and nothing after', async () => {
    const t = translator();
    const out = await t.translate(finished('failed', 'model refused'));
    assert.equal(out.at(-1)?.type, EventType.RUN_ERROR);
    assert.equal((out.at(-1) as { message: string }).message, 'model refused');
    assert.deepEqual(t.fail(new Error('late')), []);
});

test('closes open streams when a run is cancelled', async () => {
    const t = translator();
    await t.translate(ev({ type: 'text_delta', delta: 'half' }));
    const out = t.fail(new Error('aborted'), 'cancelled');
    assert.deepEqual(types(out), [
        EventType.TEXT_MESSAGE_END,
        EventType.STEP_FINISHED,
        EventType.RUN_ERROR,
    ]);
});

test('ends a suspended run with an interrupt outcome, one per waiting call', async () => {
    const t = translator();
    const suspended = [
        {
            callId: 'c1',
            name: 'mcp_call',
            at: '2025-01-01T00:00:00.000Z',
            reason: 'mcp_auth',
            message: 'Connect GitHub to continue.',
            data: { interruptId: 'int-1', kind: 'oauth', server: 'GitHub_Remote' },
        },
        { callId: 'c2', name: 'ask', at: '2025-01-01T00:00:00.000Z', reason: 'input' },
    ];
    const out = await t.translate(
        ev({
            type: 'run_finished',
            state: {},
            result: { stopReason: 'suspended', agent: 'intake', usage, state: { suspended } },
        }),
    );
    const end = out.at(-1) as { type: EventType; outcome: unknown };
    assert.equal(end.type, EventType.RUN_FINISHED);
    assert.deepEqual(end.outcome, {
        type: 'interrupt',
        interrupts: [
            {
                id: 'int-1',
                reason: 'mcp_auth',
                message: 'Connect GitHub to continue.',
                toolCallId: 'c1',
                metadata: { interruptId: 'int-1', kind: 'oauth', server: 'GitHub_Remote' },
            },
            { id: 'c2', reason: 'input', toolCallId: 'c2' },
        ],
    });
});

test('clips long tool output', () => {
    assert.equal(clip('abcdef', 3), 'abc\n… 3 more characters');
    assert.equal(clip('abc', 3), 'abc');
});
