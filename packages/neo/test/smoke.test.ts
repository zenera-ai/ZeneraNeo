import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryIndex } from '../src/memory/index.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { InMemoryPayloadStore } from '../src/payload-stores/in-memory.ts';
import { exportRun, importRun, type Payload } from '../src/payload.ts';
import { promptFile } from '../src/prompt.ts';
import { AgentRunner } from '../src/runner.ts';
import { fileTools } from '../src/tools/files.ts';
import { StaticSkillProvider } from '../src/skill-providers/static.ts';
import { assertState, turns, type AgentState } from '../src/state.ts';
import {
    COMPACTION_MODEL,
    mergeModelUsage,
    projectMessages,
    totalUsage,
    usageByModel,
    type LlmCallNode,
    type TrajectoryNode,
} from '../src/trajectory.ts';
import { addUsage, tool, zeroUsage, type ToolCall } from '../src/types.ts';

// ---------------------------------------------------------------------------
// A scripted model: rules inspect the projected request, so the tests exercise
// the real loop (projection, tool dispatch, kernel transitions) end to end.
// ---------------------------------------------------------------------------

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
            if (res) {
                return { usage: { ...zeroUsage(), inputTokens: 10, outputTokens: 5 }, ...res };
            }
        }
        throw new Error(`no rule matched (last user: ${lastUser(req)})`);
    }
}

let callSeq = 0;

function say(text: string): ModelResponse {
    return { text, toolCalls: [], stopReason: 'stop' };
}

function callTool(name: string, args: unknown): ModelResponse {
    const call: ToolCall = { id: `c${++callSeq}`, name, args: JSON.stringify(args) };
    return { text: '', toolCalls: [call], stopReason: 'tool_calls' };
}

function lastUser(req: ModelRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
        const m = req.messages[i];
        if (m.role === 'user') {
            return m.content.map((p) => (p.type === 'text' ? p.text : p.url)).join('\n');
        }
    }
    return '';
}

function hasToolResult(req: ModelRequest, name: string): boolean {
    return req.messages.some((m) => m.role === 'tool' && m.name === name);
}

/** The tool message a request ends on, if it ends on one. */
function lastToolResult(req: ModelRequest, name: string): string {
    const last = req.messages.at(-1);
    return last?.role === 'tool' && last.name === name ? last.content : '';
}

function allText(req: ModelRequest): string {
    return JSON.stringify(req.messages) + (req.system ?? '');
}

function findNode<T extends TrajectoryNode['type']>(
    state: AgentState,
    type: T,
): Extract<TrajectoryNode, { type: T }> {
    const node = state.trajectory.find((n) => n.type === type);
    if (!node) {
        throw new Error(`no ${type} node in the trajectory`);
    }
    return node as Extract<TrajectoryNode, { type: T }>;
}

// ---------------------------------------------------------------------------

describe('smoke', () => {
    it('delivers view_image as replayable visual input after a parallel tool batch', async () => {
        const root = mkdtempSync(join(tmpdir(), 'zen-view-image-'));
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
            'base64',
        );
        writeFileSync(join(root, 'pixel.png'), png);
        writeFileSync(join(root, 'note.txt'), 'a note');
        const image = {
            type: 'image',
            url: `data:image/png;base64,${png.toString('base64')}`,
            mimeType: 'image/png',
        };
        const model = new RuleModel((req) => {
            if (hasToolResult(req, 'view_image')) {
                expect(req.messages.map((m) => m.role)).toEqual([
                    'user',
                    'assistant',
                    'tool',
                    'tool',
                    'user',
                ]);
                const attachment = req.messages.at(-1);
                expect(attachment?.role === 'user' && attachment.content).toContainEqual(image);
                const result = req.messages.find(
                    (m) => m.role === 'tool' && m.name === 'view_image',
                );
                expect(result?.content).not.toContain('base64');
                return say('image received');
            }
            return {
                text: '',
                stopReason: 'tool_calls',
                toolCalls: [
                    { id: 'image-call', name: 'view_image', args: '{"path":"pixel.png"}' },
                    { id: 'text-call', name: 'read_file', args: '{"path":"note.txt"}' },
                ],
            };
        });
        try {
            const runner = new AgentRunner({ model });
            runner.agent({ name: 'viewer', tools: fileTools({ root, readOnly: true }) });
            const result = await runner.run('viewer', 'Look at the image').final();
            expect(result.output).toBe('image received');
            const node = result.state.trajectory.find(
                (n) => n.type === 'tool_result' && n.name === 'view_image',
            );
            expect(node?.type === 'tool_result' && node.media).toEqual([image]);
            // JSON round-trip the trajectory; no workspace file is needed to replay it.
            const recorded: TrajectoryNode[] = JSON.parse(JSON.stringify(result.state.trajectory));
            const projection = await projectMessages(recorded, runner.services.payloads);
            expect(
                projection.messages.some(
                    (m) =>
                        m.role === 'user' &&
                        m.content.some((p) => p.type === 'image' && p.url === image.url),
                ),
            ).toBe(true);
            const withoutCall = recorded.filter((n) => n.type !== 'llm_call');
            const orphaned = await projectMessages(withoutCall, runner.services.payloads);
            expect(
                orphaned.messages.some(
                    (m) => m.role === 'user' && m.content.some((p) => p.type === 'image'),
                ),
            ).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('runs a handoff and a tool call end to end', async () => {
        const add = tool<{ a: number; b: number }>({
            name: 'add',
            description: 'adds',
            parameters: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b'],
            },
            execute: ({ a, b }) => a + b,
        });

        const model = new RuleModel(
            (req) =>
                req.system?.includes('ROUTER') ? callTool('transfer_to_worker', {}) : undefined,
            (req) => (hasToolResult(req, 'add') ? say('the answer is 5') : undefined),
            () => callTool('add', { a: 2, b: 3 }),
        );

        const runner = new AgentRunner({ model });
        runner.agent({ name: 'worker', instructions: 'WORKER', tools: [add] });
        runner.agent({ name: 'router', instructions: 'ROUTER', handoffs: ['worker'] });

        const seen: string[] = [];
        const stream = runner.run('router', 'add two and three');
        for await (const e of stream) {
            seen.push(e.type);
        }
        const res = await stream.final();

        expect(res.output).toBe('the answer is 5');
        expect(res.agent).toBe('worker');
        expect(res.stopReason).toBe('final');
        expect(turns(res.state)).toBe(3);
        expect(seen).toContain('handoff');
        expect(seen).toContain('before_tool_call');
        expect(seen).toContain('after_tool_call');
        expect(res.usage.inputTokens).toBe(30);
        // Two system prompts (one per agent) — the second one supersedes the first.
        const { system, messages } = await projectMessages(
            res.state.trajectory,
            runner.services.payloads,
        );
        expect(system).toBe('WORKER');
        expect(messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    });

    it('says a plain-text answer once, however many turns follow', async () => {
        const seen: ModelRequest[] = [];
        const model = new RuleModel((req) => {
            seen.push(req);
            return say(`answer ${seen.length}`);
        });
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'chat', instructions: 'CHAT' });

        const first = await runner.run('chat', 'hello');
        await runner.send(first.state, 'again');

        // An untyped run records its answer twice — as the `llm_call`'s text and
        // as the `final_output` node that ends it — so the projection has to
        // collapse them, or every later turn re-reads the same answer.
        const second = seen[1];
        expect(second.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
        expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    });

    it('repairs a typed output that violates the schema', async () => {
        const Plan = z.object({ steps: z.array(z.string()).min(1), cost: z.number() });

        const model = new RuleModel(
            (req) =>
                hasToolResult(req, 'final_output')
                    ? callTool('final_output', { steps: ['a', 'b'], cost: 42 })
                    : undefined,
            // First attempt violates the schema: cost is a string.
            () => callTool('final_output', { steps: ['a'], cost: 'free' }),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'planner', instructions: 'PLAN' });

        const res = await runner.run('planner', 'plan it', { output: Plan });
        expect(res.output).toEqual({ steps: ['a', 'b'], cost: 42 });
        expect(model.calls, 'the model repaired its own output').toBe(2);
        expect(res.state.phase).toBe('done');
    });

    it('forks branches and joins them in declared order', async () => {
        const model = new RuleModel(
            // An inheriting branch is handed its assignment as the result of the
            // `fork` call it can see itself making, so both roles now read a
            // fork tool message — the branch's names the branch it is.
            (req) => {
                const mine = /^You are branch "(\w+)"/.exec(lastToolResult(req, 'fork'));
                return mine ? say(`done branch: ${mine[1]}`) : undefined;
            },
            (req) => (hasToolResult(req, 'fork') ? say('combined answer') : undefined),
            () =>
                callTool('fork', {
                    branches: [
                        { name: 'left', instructions: 'branch: left' },
                        { name: 'right', instructions: 'branch: right' },
                    ],
                    context: 'compact',
                }),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'lead', instructions: 'LEAD', fork: { maxBranches: 3 } });

        const branchEvents: string[] = [];
        const stream = runner.run('lead', 'do both');
        for await (const e of stream) {
            if (e.branch) {
                branchEvents.push(`${e.branch.name}:${e.type}`);
            }
        }
        const res = await stream.final();

        expect(res.output).toBe('combined answer');
        const join = findNode(res.state, 'join');
        // Declared order, not completion order.
        expect(join.branches.map((b) => b.name)).toEqual(['left', 'right']);
        expect(join.branches.every((b) => b.status === 'ok')).toBe(true);
        // Branch tokens are folded into the parent's total.
        expect(res.usage.inputTokens).toBe(10 + join.usage.inputTokens + 10);
        expect(branchEvents.some((e) => e.startsWith('left:'))).toBe(true);
        // The parent sees the whole episode as one tool call + one tool result.
        const { messages } = await projectMessages(res.state.trajectory, runner.services.payloads);
        const forkResults = messages.filter((m) => m.role === 'tool' && m.name === 'fork');
        expect(forkResults).toHaveLength(1);
        const [forkResult] = forkResults;
        expect(forkResult.role === 'tool' && forkResult.content).toContain('done branch: left');

        // The branches' own history hangs off the join — there for audit, and
        // structurally out of the parent's scope.
        const raw = res.state.trajectory;
        expect(join.branches.map((b) => b.nodes.length).every((n) => n > 0)).toBe(true);
        // A branch opens on the answer to the fork call it inherited: its own
        // assignment, plus who else is running, so it does not redo their part.
        const seed = join.branches[0].nodes[0];
        const brief =
            seed.type === 'tool_result' ? await runner.services.payloads.get(seed.result) : '';
        expect(seed.type === 'tool_result' && seed.name).toBe('fork');
        expect(brief).toContain('branch: left');
        expect(brief).toContain('"right"');
        expect(
            raw.filter((n) => n.type === 'llm_call'),
            'parent calls only',
        ).toHaveLength(2);
        expect(turns(res.state), 'branch turns are not the parent\u2019s').toBe(2);
        // Accounting is the one thing that crosses the boundary, by recursion.
        expect(totalUsage(raw).inputTokens).toBe(40);
        // The split by model crosses it the same way, so it adds back up.
        const split = usageByModel(raw);
        expect(split.map((m) => [m.model, m.calls])).toEqual([['scripted', 4]]);
        expect(split[0].usage).toEqual(totalUsage(raw));

        // Export reaches branch payloads through the generic deep walk.
        const bundle = await exportRun(res.state, runner.services.payloads);
        expect(Object.values(bundle.blobs)).toContain('done branch: left');
    });

    it.each(['inherit', 'compact'] as const)(
        'keeps every call of the forking turn in a %s branch, signature included',
        async (context) => {
            const peek = tool({
                name: 'peek',
                description: 'looks something up',
                parameters: { type: 'object', properties: {} },
                execute: () => 'peeked',
            });
            const branchRequests: ModelRequest[] = [];
            const model = new RuleModel(
                (req) => {
                    if (!lastToolResult(req, 'fork').startsWith('You are branch')) {
                        return undefined;
                    }
                    branchRequests.push(req);
                    return say('branch done');
                },
                (req) => (hasToolResult(req, 'fork') ? say('merged') : undefined),
                // Gemini signs only the first call of a parallel turn.
                () => ({
                    text: '',
                    toolCalls: [
                        { id: 'p1', name: 'peek', args: '{}', signature: 'S' },
                        {
                            id: 'f1',
                            name: 'fork',
                            args: JSON.stringify({
                                branches: [
                                    { name: 'a', instructions: 'go a' },
                                    { name: 'b', instructions: 'go b' },
                                ],
                                context,
                            }),
                        },
                    ],
                    stopReason: 'tool_calls',
                }),
            );
            const runner = new AgentRunner({ model });
            runner.agent({
                name: 'lead',
                instructions: 'LEAD',
                tools: [peek],
                fork: { maxBranches: 2 },
            });

            const res = await runner.run('lead', 'look and split');
            expect(res.output).toBe('merged');
            expect(branchRequests).toHaveLength(2);
            for (const req of branchRequests) {
                const turn = req.messages.find(
                    (m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.name === 'fork'),
                );
                expect(
                    turn?.role === 'assistant' && turn.toolCalls?.map((c) => [c.name, c.signature]),
                ).toEqual([
                    ['peek', 'S'],
                    ['fork', undefined],
                ]);
                const results = req.messages.flatMap((m) => (m.role === 'tool' ? [m.name] : []));
                expect(results).toEqual(['peek', 'fork']);
            }
        },
    );

    it('delegates a single branch and keeps its steps out of the caller', async () => {
        const peek = tool({
            name: 'peek',
            description: 'looks something up',
            parameters: { type: 'object', properties: {} },
            execute: () => 'the register says 42',
        });

        const model = new RuleModel(
            (req) => (hasToolResult(req, 'peek') ? say('42, from the register') : undefined),
            (req) => (req.system?.startsWith('SPECIALIST') ? callTool('peek', {}) : undefined),
            (req) => (hasToolResult(req, 'fork') ? say('it is 42') : undefined),
            () =>
                callTool('fork', {
                    branches: [
                        { name: 'lookup', instructions: 'find the number', agent: 'specialist' },
                    ],
                    context: 'compact',
                }),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'specialist', instructions: 'SPECIALIST', tools: [peek] });
        runner.agent({ name: 'lead', instructions: 'LEAD', fork: { maxBranches: 1 } });

        const res = await runner.run('lead', 'what is the number');
        expect(res.output).toBe('it is 42');

        const join = findNode(res.state, 'join');
        expect(join.branches.map((b) => b.name)).toEqual(['lookup']);
        expect(join.branches[0].status).toBe('ok');

        // The caller gets the conclusion and none of the work behind it.
        const { messages } = await projectMessages(res.state.trajectory, runner.services.payloads);
        const forkResults = messages.filter((m) => m.role === 'tool' && m.name === 'fork');
        expect(forkResults).toHaveLength(1);
        expect(forkResults[0].role === 'tool' && forkResults[0].content).toContain(
            '42, from the register',
        );
        expect(messages.some((m) => m.role === 'tool' && m.name === 'peek')).toBe(false);
        expect(res.state.trajectory.some((n) => n.type === 'tool_call')).toBe(false);
        // … while the branch's own history is on record, one level down.
        expect(join.branches[0].nodes.some((n) => n.type === 'tool_call')).toBe(true);

        // A lone branch is told it has no siblings, not handed an empty list.
        const seed = join.branches[0].nodes[0];
        const brief =
            seed.type === 'tool_result' ? await runner.services.payloads.get(seed.result) : '';
        expect(brief).toContain('find the number');
        expect(brief).toContain('No other branch was opened');
        expect(brief).not.toContain('Running in parallel');
    });

    it('keeps a branch agent out of the parent after the join', async () => {
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'fork') ? say('merged') : undefined),
            (req) => (req.system === 'SCOUT' ? say('scouted') : undefined),
            () =>
                callTool('fork', {
                    branches: [
                        { name: 'a', instructions: 'go a', agent: 'scout' },
                        { name: 'b', instructions: 'go b', agent: 'scout' },
                    ],
                    context: 'none',
                }),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'scout', instructions: 'SCOUT' });
        runner.agent({
            name: 'lead',
            instructions: 'LEAD',
            fork: { agents: ['scout'], maxBranches: 4 },
        });

        const res = await runner.run('lead', 'delegate');
        expect(res.output).toBe('merged');
        expect(res.agent).toBe('lead');

        // The prompt in force after the join is the one from before the fork.
        const { system } = await projectMessages(res.state.trajectory, runner.services.payloads);
        expect(system?.startsWith('LEAD')).toBe(true);
        expect(system).not.toContain('SCOUT');
        expect(res.state.trajectory.some((n) => n.agent === 'scout')).toBe(false);
        // … while the branch's own prompt is still on record, one level down.
        const join = findNode(res.state, 'join');
        expect(
            join.branches.every((b) =>
                b.nodes.some((n) => n.type === 'system_prompt' && n.agent === 'scout'),
            ),
        ).toBe(true);
    });

    it('remembers a subgraph and recalls it on a later run', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'neo-smoke-mem-'));
        const memory = new MemoryIndex({ store: await MemoryStore.open(dir) });
        let recalled = '';
        let dropped = '';
        const model = new RuleModel(
            (req) =>
                hasToolResult(req, 'memory_forget') ? say('I remember you like trains') : undefined,
            (req) =>
                hasToolResult(req, 'memory_load')
                    ? callTool('memory_forget', { ids: [dropped] })
                    : undefined,
            (req) => (hasToolResult(req, 'memory_commit') ? say('noted') : undefined),
            // Messages only: the system prompt now names the tag when it
            // explains the format, so matching on the whole request would fire
            // before anything had been recalled.
            (req) =>
                JSON.stringify(req.messages).includes('memory-recollection')
                    ? callTool('memory_load', { ids: [recalled] })
                    : undefined,
            () =>
                callTool('memory_commit', {
                    nodes: [
                        { ref: 'pref', kind: 'fact', text: 'the user prefers trains over planes' },
                        { ref: 'why', kind: 'fact', text: 'trains have more legroom' },
                    ],
                    edges: [{ from: 'why', to: 'pref', relation: 'INFORMED' }],
                }),
        );
        const runner = new AgentRunner({ model, memory });
        runner.agent({
            name: 'assistant',
            instructions: 'ASSIST',
            memory: {
                access: 'full',
                autoRecall: { query: 'last_user_input', limit: 3 },
            },
        });

        try {
            const first = await runner.run('assistant', 'remember that I prefer trains');
            expect(first.output).toBe('noted');
            const op = findNode(first.state, 'memory_op');
            expect(op.op).toBe('commit');
            expect(op.nodes).toHaveLength(2);
            recalled = op.nodes[0]!.id;
            dropped = op.nodes[1]!.id;

            // The graph outlives the run, which is the whole point.
            expect(memory.graph.order).toBe(2);

            const second = await runner.run('assistant', 'how should I travel by trains?');
            const recall = findNode(second.state, 'memory_recall');
            expect(recall.seeds.length).toBeGreaterThan(0);
            // The link is pulled in even though only one node matched.
            expect(recall.nodes).toHaveLength(2);
            expect(second.output).toBe('I remember you like trains');

            // A recall shows a clipped line; only a load puts the whole text in
            // the context, and the report reads the difference off this node.
            const load = findNode(second.state, 'memory_op');
            expect(load.op).toBe('load');
            expect(load.nodes).toEqual([
                { id: recalled, kind: 'fact', revision: expect.any(Number) },
            ]);

            // Taken before the delete, or the report would draw the node it
            // dropped with nothing around it.
            const forget = second.state.trajectory.filter(
                (n) => n.type === 'memory_op' && n.op === 'forget',
            );
            expect(forget).toHaveLength(1);
            expect(forget[0]).toMatchObject({
                nodes: [{ id: dropped }],
                edges: [{ source: dropped, target: recalled, relation: 'INFORMED' }],
            });
        } finally {
            memory.store.release();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('puts standing preferences in the system prompt, not in the conversation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'neo-smoke-pref-'));
        const memory = new MemoryIndex({ store: await MemoryStore.open(dir) });
        memory.graph.add(
            {
                id: 'PREF1',
                kind: 'preference',
                text: 'always report findings as a table',
                audience: ['*'],
            },
            '2025-01-01T00:00:00.000Z',
        );
        const model = new RuleModel(() => say('ok'));
        const runner = new AgentRunner({ model, memory });
        runner.agent({
            name: 'assistant',
            instructions: 'ASSIST',
            memory: { access: 'read-write', autoRecall: { query: 'none', limit: 3 } },
        });

        try {
            const res = await runner.run('assistant', 'hello');
            const { system, messages } = await projectMessages(
                res.state.trajectory,
                runner.services.payloads,
            );
            expect(system).toContain('ASSIST');
            expect(system).toContain('always report findings as a table [PREF1]');
            // Author text stays first: the derived tail is what may move.
            expect(system!.indexOf('ASSIST')).toBeLessThan(system!.indexOf('memory-preferences'));
            expect(JSON.stringify(messages)).not.toContain('memory-preferences');
        } finally {
            memory.store.release();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('records one system prompt for an agent that only has memory', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'neo-smoke-pref2-'));
        const memory = new MemoryIndex({ store: await MemoryStore.open(dir) });
        memory.graph.add(
            {
                id: 'PREF1',
                kind: 'preference',
                text: 'always report findings as a table',
                audience: ['*'],
            },
            '2025-01-01T00:00:00.000Z',
        );
        const model = new RuleModel(() => say('ok'));
        const runner = new AgentRunner({ model, memory });
        runner.agent({
            name: 'assistant',
            memory: { access: 'read', autoRecall: { query: 'none', limit: 3 } },
        });

        try {
            const res = await runner.run('assistant', 'hello');
            const prompts = res.state.trajectory.filter((n) => n.type === 'system_prompt');
            expect(prompts).toHaveLength(1);
            const { system } = await projectMessages(
                res.state.trajectory,
                runner.services.payloads,
            );
            expect(system).toContain('memory-preferences');
            // How to use the graph is the project's house rules, not the
            // runtime's: an SDK agent with no such document gets the schemas.
            expect(system).not.toContain('memory-recollection');
            expect(system).not.toContain('memory_commit');
        } finally {
            memory.store.release();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports a missing required argument instead of running the tool', async () => {
        let ran = 0;
        const shout = tool<{ text: string }>({
            name: 'shout',
            description: 'upper-cases text',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
            },
            execute: ({ text }) => {
                ran++;
                return text.toUpperCase();
            },
        });
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'shout') ? say('done') : undefined),
            () => callTool('shout', {}),
        );
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'a', instructions: 'A', tools: [shout] });

        const res = await runner.run('a', 'go');
        const result = findNode(res.state, 'tool_result');
        expect(result.isError).toBe(true);
        const output = await runner.services.payloads.get(result.result);
        expect(output).toBe('error: shout is missing required arguments: text');
        expect(ran).toBe(0);
    });

    it('declares a skill tool up front and unlocks it on load', async () => {
        const cheapHotels = tool<Record<string, never>>({
            name: 'cheap_hotels',
            description: 'lists cheap hotels',
            parameters: { type: 'object', properties: {} },
            execute: () => ['hostel one', 'hostel two'],
        });
        const provider = new StaticSkillProvider([
            {
                name: 'budget_travel',
                description: 'plan on a budget',
                content: 'Prefer trains. Book outside the centre.',
                tools: [cheapHotels],
            },
        ]);

        const model = new RuleModel(
            (req) =>
                req.messages.some(
                    (m) =>
                        m.role === 'tool' &&
                        m.name === 'cheap_hotels' &&
                        m.content.includes('hostel'),
                )
                    ? say('stay at hostel one')
                    : undefined,
            (req) =>
                allText(req).includes('PREREQUISITE_MISSING') && !hasToolResult(req, 'skill_load')
                    ? callTool('skill_load', { names: ['budget_travel'] })
                    : undefined,
            // The tool is offered from turn 0, so the model reaches for it first
            // and is told which skill to load.
            () => callTool('cheap_hotels', {}),
        );
        const runner = new AgentRunner({ model, skills: [provider] });
        runner.agent({
            name: 'guide',
            instructions: 'GUIDE',
            skills: { provider: 'static', discovery: 'index' },
        });

        const res = await runner.run('guide', 'cheap trip please');
        const load = findNode(res.state, 'load_skills');
        expect(load.toolNames).toEqual(['cheap_hotels']);

        const results = res.state.trajectory.filter((n) => n.type === 'tool_result');
        expect(results.map((n) => `${n.name}:${n.isError}`)).toEqual([
            'cheap_hotels:true',
            'skill_load:false',
            'cheap_hotels:false',
        ]);
        expect(res.output).toBe('stay at hostel one');
        // The instructions reached the model through the node, not the tool result.
        const { messages } = await projectMessages(res.state.trajectory, runner.services.payloads);
        expect(JSON.stringify(messages)).toContain('Prefer trains');
        expect(JSON.stringify(messages)).toContain('PREREQUISITE_MISSING');
    });

    it('resumes from a checkpoint and exports the run', async () => {
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'ping') ? say('pong received') : undefined),
            () => callTool('ping', {}),
        );
        const ping = tool<Record<string, never>>({
            name: 'ping',
            description: 'ping',
            parameters: { type: 'object', properties: {} },
            execute: () => 'pong',
        });
        const blobs = new InMemoryPayloadStore();
        const runner = new AgentRunner({ model, payloads: blobs });
        runner.agent({ name: 'echo', instructions: 'ECHO', tools: [ping] });

        // Stop at the checkpoint taken *before* the tool executes, persist it, and
        // continue from the snapshot alone.
        let snapshot: AgentState | undefined;
        const stream = runner.run('echo', 'ping please');
        for await (const e of stream) {
            if (e.type === 'before_tool_call') {
                snapshot = assertState(JSON.parse(JSON.stringify(e.state)));
                break;
            }
        }
        if (!snapshot) {
            throw new Error('no checkpoint captured');
        }
        expect(snapshot.phase).toBe('awaiting_tools');
        expect(snapshot.pendingToolCalls).toHaveLength(1);

        const resumed = await runner.resume(snapshot);
        expect(resumed.output).toBe('pong received');

        // Portability: state + blobs travel as one artifact.
        const bundle = await exportRun(resumed.state, runner.services.payloads);
        const restored = await importRun<AgentState>(bundle, new InMemoryPayloadStore('mem'));
        expect(restored.runId).toBe(resumed.state.runId);
        expect(Object.keys(bundle.blobs).length).toBeGreaterThan(3);
    });

    it('hides a compacted node without deleting it', async () => {
        const model = new RuleModel(
            (req) => (hasToolResult(req, 'noisy') ? say('final') : undefined),
            () => callTool('noisy', {}),
        );
        const noisy = tool<Record<string, never>>({
            name: 'noisy',
            description: 'noisy',
            parameters: { type: 'object', properties: {} },
            execute: () => 'x'.repeat(500),
        });
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'a', instructions: 'A', tools: [noisy] });

        const res = await runner.run('a', 'go');
        const toolResult = findNode(res.state, 'tool_result');

        const { Kernel } = await import('../src/index.ts');
        const env = { services: runner.services };
        const compacted = await Kernel.applyCompaction(
            res.state,
            {
                covers: [toolResult.id],
                summary: 'the tool returned a long blob',
                reason: 'token_budget',
            },
            env,
        );
        const { messages } = await projectMessages(compacted.trajectory, runner.services.payloads);
        const text = JSON.stringify(messages);
        expect(text, 'covered node is hidden from the projection').not.toContain('xxxxx');
        expect(text).toContain('the tool returned a long blob');
        // The orphaned tool call was dropped, so the request stays provider-valid.
        expect(!text.includes('"noisy"') || !text.includes('tool_call')).toBe(true);
        // The original node is still there for audit — the log is append-only.
        expect(compacted.trajectory.some((n) => n.id === toolResult.id)).toBe(true);
        expect(compacted.trajectory.length).toBe(res.state.trajectory.length + 1);

        // A second compaction covering the first must not resurrect what the
        // first one hid: the covered set is a union, so compaction is monotone.
        const first = compacted.trajectory[compacted.trajectory.length - 1];
        const twice = await Kernel.applyCompaction(
            compacted,
            { covers: [first.id], summary: 'even shorter', reason: 'token_budget' },
            env,
        );
        const again = JSON.stringify(
            (await projectMessages(twice.trajectory, runner.services.payloads)).messages,
        );
        expect(again).toContain('even shorter');
        expect(again).not.toContain('the tool returned a long blob');
        expect(again, 'a covered node stays covered').not.toContain('xxxxx');
    });

    it('compacts a hand-off through a policy and an async summarizer', async () => {
        const model = new RuleModel(
            (req) => (req.system === 'B' ? say('done by b') : undefined),
            () => callTool('transfer_to_b', {}),
        );
        const runner = new AgentRunner({
            model,
            handoffPolicy: {
                // Everything the outgoing agent produced, by node identity.
                select: (state) =>
                    state.trajectory.filter((n) => n.agent === 'a' && n.type !== 'user_input'),
            },
            summarizer: {
                summarize: (nodes, reason) =>
                    Promise.resolve(`[${reason}] a did ${nodes.length} things`),
            },
        });
        runner.agent({ name: 'b', instructions: 'B' });
        runner.agent({ name: 'a', instructions: 'A', handoffs: ['b'] });

        const res = await runner.run('a', 'start');
        expect(res.output).toBe('done by b');
        const compaction = findNode(res.state, 'compaction');
        expect(compaction.reason).toBe('handoff_noise');
        expect(compaction.covers.length).toBeGreaterThan(0);

        const { system, messages } = await projectMessages(
            res.state.trajectory,
            runner.services.payloads,
        );
        expect(system).toBe('B');
        // The summary reaches the model as a tool result, not as a user turn.
        const summary = messages.find((m) => m.role === 'tool' && m.name === 'compact');
        expect(summary && summary.role === 'tool' && summary.content).toContain('handoff_noise');
        expect(messages.some((m) => m.role === 'user' && JSON.stringify(m).includes('a did'))).toBe(
            false,
        );
    });
});

// ---------------------------------------------------------------------------

describe('system prompt composition', () => {
    /** A real file, because `promptFile` reads one — there is nothing to fake. */
    function writePrompt(name: string, body: string): string {
        const path = join(dir, name);
        writeFileSync(path, body);
        return path;
    }

    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'zn-prompt-'));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('composes files and text, and records which files to edit', async () => {
        const house = writePrompt('AGENT.md', 'HOUSE RULES');
        const intent = writePrompt('triage.md', 'TRIAGE');

        const model = new RuleModel(() => say('ok'));
        const runner = new AgentRunner({ model });
        runner.agent({
            name: 'triage',
            instructions: [
                promptFile(house),
                "Answer in the user's language.",
                promptFile(intent, 'intent'),
            ],
        });

        const res = await runner.run('triage', 'hi');
        const { system } = await projectMessages(res.state.trajectory, runner.services.payloads);
        expect(system).toBe(
            "HOUSE RULES\n\nAnswer in the user's language.\n\n<intent>\nTRIAGE\n</intent>",
        );

        // The point of the whole exercise: which file do I edit?
        const node = findNode(res.state, 'system_prompt');
        const sources = node.sources ?? [];
        expect(sources.map((s) => s.path)).toEqual([house, intent]);
        // …and the bytes that file contributed, so a later edit is detectable.
        expect(
            await Promise.all(sources.map((s) => runner.services.payloads.get(s.content))),
        ).toEqual(['HOUSE RULES', 'TRIAGE']);
    });

    it('fails at construction, not on the first llm call, when a file is missing', () => {
        // Setup-time I/O buys a stack trace pointing at the agent instead of a
        // run that dies in production on its first turn.
        expect(() => promptFile(join(dir, 'gone.md'))).toThrow('gone.md');
    });

    it('appends one node for a prompt that does not change', async () => {
        const model = new RuleModel(() => say('ok'));
        const runner = new AgentRunner({ model });
        runner.agent({ name: 'a', instructions: [promptFile(writePrompt('p.md', 'V1'))] });

        const first = await runner.run('a', 'one');
        const second = await runner.send(first.state, 'two');
        expect(
            second.state.trajectory.filter((n) => n.type === 'system_prompt'),
            'identical bytes append nothing',
        ).toHaveLength(1);
    });

    it('puts the skill index and the final_output instruction in the node', async () => {
        const skills = new StaticSkillProvider(
            [{ name: 'refunds', description: 'how to refund', content: 'REFUND STEPS' }],
            'kb',
        );
        const model = new RuleModel(() => callTool('final_output', { ok: true }));
        const runner = new AgentRunner({ model, skills: [skills] });
        runner.agent({
            name: 'a',
            instructions: 'BASE',
            skills: { provider: 'kb', discovery: 'index' },
        });

        const res = await runner.run('a', 'go', { output: z.object({ ok: z.boolean() }) });

        // Both used to be appended after projection, so part of the prompt lived
        // in no node at all. The invariant now: what the model saw *is* the node.
        const node = findNode(res.state, 'system_prompt');
        const recorded = await runner.services.payloads.get(node.prompt);
        expect(recorded).toContain('BASE');
        expect(recorded).toContain('refunds');
        expect(recorded).toContain('final_output');
        expect(node.sources, 'neither is a file anyone edits').toBeUndefined();

        const { system } = await projectMessages(res.state.trajectory, runner.services.payloads);
        expect(system).toBe(recorded);
    });
});

/**
 * One total belongs to none of the models a run actually used. The split has to
 * name each of them and still add back up to what `totalUsage` reports — if it
 * did not, the report would be inviting an argument nobody can settle.
 */
describe('usage split by model', () => {
    const ref: Payload = { store: 'mem', sha256: 'x', size: 1 };
    const used = (model: string, inputTokens: number): LlmCallNode => ({
        id: `n${inputTokens}`,
        ts: '2026-01-01T00:00:00.000Z',
        agent: 'a',
        type: 'llm_call',
        model,
        requestDigest: 'x',
        text: ref,
        toolCalls: [],
        usage: { ...zeroUsage(), inputTokens, outputTokens: 1 },
        stopReason: 'stop',
    });

    it('names every model, counts its calls, and reaches inside a fork', () => {
        const nodes: TrajectoryNode[] = [
            used('fast', 10),
            used('deep', 100),
            used('fast', 20),
            {
                id: 'j',
                ts: '2026-01-01T00:00:00.000Z',
                agent: 'a',
                type: 'join',
                callId: 'c1',
                branches: [
                    {
                        name: 'left',
                        agent: 'a',
                        status: 'ok',
                        output: ref,
                        usage: { ...zeroUsage(), inputTokens: 5, outputTokens: 1 },
                        nodes: [used('deep', 5)],
                    },
                ],
                usage: { ...zeroUsage(), inputTokens: 5, outputTokens: 1 },
            },
        ];

        // Heaviest first: the row being looked for is the expensive one.
        expect(usageByModel(nodes).map((m) => [m.model, m.calls, m.usage.inputTokens])).toEqual([
            ['deep', 2, 105],
            ['fast', 2, 30],
        ]);
        expect(
            usageByModel(nodes).reduce((sum, m) => addUsage(sum, m.usage), zeroUsage()),
            'the rows are the total, rearranged',
        ).toEqual(totalUsage(nodes));
    });

    it('keeps the summarizer accounted for, though no node names its model', () => {
        const nodes: TrajectoryNode[] = [
            used('fast', 10),
            {
                id: 'c',
                ts: '2026-01-01T00:00:00.000Z',
                agent: 'a',
                type: 'compaction',
                callId: 'c1',
                covers: ['n10'],
                summary: ref,
                reason: 'handoff_noise',
                usage: { ...zeroUsage(), inputTokens: 3, outputTokens: 1 },
            },
        ];

        expect(usageByModel(nodes).map((m) => m.model)).toEqual(['fast', COMPACTION_MODEL]);
        expect(usageByModel(nodes).reduce((sum, m) => addUsage(sum, m.usage), zeroUsage())).toEqual(
            totalUsage(nodes),
        );
    });

    it('folds many runs into one split', () => {
        const a = usageByModel([used('fast', 10)]);
        const b = usageByModel([used('fast', 20), used('deep', 1)]);
        expect(mergeModelUsage(a, b).map((m) => [m.model, m.calls, m.usage.inputTokens])).toEqual([
            ['fast', 2, 30],
            ['deep', 1, 1],
        ]);
    });
});
