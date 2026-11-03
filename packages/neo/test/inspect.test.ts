import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT } from '../src/inspect/client.ts';
import {
    buildRunReport,
    renderReportHtml,
    renderRunReport,
    type RunReport,
} from '../src/inspect/index.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import { InMemoryPayloadStore } from '../src/payload-stores/in-memory.ts';
import { PayloadResolver } from '../src/payload.ts';
import { AgentRunner } from '../src/runner.ts';
import type { AgentState } from '../src/state.ts';
import { tool, zeroUsage, type ToolCall } from '../src/types.ts';

// A model that calls a tool once, then answers.
class ScriptModel implements Model {
    readonly id = 'scripted';
    #calls = 0;

    async generate(_req: ModelRequest): Promise<ModelResponse> {
        this.#calls++;
        const usage = { ...zeroUsage(), inputTokens: 10, outputTokens: 4 };
        if (this.#calls === 1) {
            const call: ToolCall = { id: 'c1', name: 'echo', args: '{"value":"hi"}' };
            return { text: '', toolCalls: [call], stopReason: 'tool_calls', usage };
        }
        return { text: 'done', toolCalls: [], stopReason: 'stop', usage };
    }
}

const echo = tool<{ value: string }>({
    name: 'echo',
    description: 'echoes',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    execute: ({ value }) => value,
});

async function runOnce(recordRequests: boolean): Promise<AgentState> {
    const runner = new AgentRunner({ model: new ScriptModel(), recordRequests });
    runner.agent({ name: 'worker', instructions: 'WORKER', tools: [echo] });
    const stream = runner.run('worker', 'say hi');
    const res = await stream.final();
    return res.state;
}

describe('run inspector', () => {
    it('records the request behind the llm_call node when asked', async () => {
        const state = await runOnce(true);
        const calls = state.trajectory.filter((n) => n.type === 'llm_call');
        expect(calls.length).toBe(2);
        for (const call of calls) {
            expect(call.request).toBeDefined();
            expect(call.requestDigest).toMatch(/^[0-9a-f]{64}$/);
        }
        // The second request carries the first call's tool result, so it is larger.
        expect(calls[1].request!.size).toBeGreaterThan(calls[0].request!.size);
    });

    it('leaves the request out by default', async () => {
        const state = await runOnce(false);
        for (const n of state.trajectory) {
            if (n.type === 'llm_call') {
                expect(n.request).toBeUndefined();
            }
        }
    });

    it('renders a self-contained page whose payloads are all resolved', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore('blobs'));
        const runner = new AgentRunner({
            model: new ScriptModel(),
            payloads,
            recordRequests: true,
        });
        runner.agent({ name: 'worker', instructions: 'WORKER', tools: [echo] });
        const res = await runner.run('worker', 'say hi').final();

        const report = await buildRunReport(res.state, runner.services.payloads);
        expect(Object.keys(report.blobs).length).toBeGreaterThan(0);
        expect(report.truncated).toEqual([]);

        const html = await renderRunReport(res.state, runner.services.payloads, { title: 'T' });
        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('<title>T</title>');
        expect(html).toContain('flowchart TD');
    });

    it('carries the declared architecture when the runner is asked for it', async () => {
        const runner = new AgentRunner({ model: new ScriptModel() });
        runner.agent({
            name: 'worker',
            instructions: 'WORKER',
            tools: [echo],
            handoffs: ['other'],
        });
        runner.agent({ name: 'other', instructions: 'OTHER' });
        const res = await runner.run('worker', 'say hi').final();

        const report = await buildRunReport(res.state, runner.services.payloads, {
            architecture: await runner.describe(),
        });
        expect(report.architecture?.source).toBe('declared');
        // 'other' was never handed to, so only the snapshot knows it exists.
        expect(report.architecture?.agents.map((a) => a.name)).toEqual(['worker', 'other']);
        expect(res.state.trajectory.some((n) => n.agent === 'other')).toBe(false);

        const html = renderReportHtml(report);
        expect(html).toContain('data-view="agents"');
    });

    it('renders the agents tab with no architecture to work from', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const state = { runId: 'r', trajectory: [] } as unknown as AgentState;
        const html = await renderRunReport(state, payloads);
        expect(html).toContain('data-view="agents"');
        expect(html).toContain('observedArchitecture');
    });

    it('truncates an oversized payload instead of inlining it', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const big = 'x'.repeat(5000);
        const ref = await payloads.put(big);
        const state = { runId: 'r', trajectory: [{ blob: ref }] } as unknown as AgentState;

        const report = await buildRunReport(state, payloads, { maxBlobBytes: 100 });
        expect(report.truncated).toEqual([ref.sha256]);
        expect(report.blobs[ref.sha256].length).toBe(100);
    });

    it('inlines an image once, however many turns re-send it', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const photo = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(400);
        // The same picture as the run holds it, and as two requests replay it.
        const ref = await payloads.put(JSON.stringify({ url: photo, again: photo }));
        const state = {
            runId: 'r',
            trajectory: [
                { type: 'user_input', content: [{ type: 'image', url: photo }] },
                { request: ref },
            ],
        } as unknown as AgentState;

        const report = await buildRunReport(state, payloads, { maxBlobBytes: 2000 });
        expect(report.media).toEqual([photo]);
        expect(report.truncated).toEqual([]);
        expect(report.blobs[ref.sha256]).toBe('{"url":"media:0","again":"media:0"}');
        const input = report.state.trajectory[0] as unknown as {
            content: { url: string }[];
        };
        expect(input.content[0].url).toBe('media:0');
    });

    it('cannot be escaped by payload content', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const hostile = '</script><img src=x onerror=alert(1)>\u2028';
        const ref = await payloads.put(hostile);
        const state = { runId: 'r', trajectory: [{ blob: ref }] } as unknown as AgentState;

        const html = await renderRunReport(state, payloads);
        const embedded = html.slice(html.indexOf('id="run-data"'));
        expect(embedded).not.toContain('</script><img');
        expect(embedded).not.toContain('\u2028');
        expect(html).toContain('\\u003c/script\\u003e');
    });

    // The page's whole brain is a string, which no type checker reads. Parsing
    // it here is the difference between a typo and a blank report.
    it('embeds a client a browser can parse', () => {
        expect(() => new Function('MERMAID_URL', CLIENT)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Paths the agent named under a mount
// ---------------------------------------------------------------------------

describe('mounted paths in the report', () => {
    const mounts = [
        { at: '/workspace', href: 'file:///Users/me/my%20proj' },
        { at: '/assets', href: 'file:///Users/me/app/assets' },
        { at: '/skills/report', href: 'file:///Users/me/app/agents/skills/report' },
    ];

    // Described here because the test program has neither the DOM lib nor jsdom's types.
    interface Node {
        textContent: string | null;
        getAttribute(name: string): string | null;
        querySelectorAll(selector: string): Iterable<Node>;
    }
    const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
        JSDOM: new (html: string, opts: object) => { window: { eval(code: string): unknown } };
    };

    /** The client's own `linkedPre`, run in a DOM against a page carrying `mounts`. */
    function linkedPre(): (cls: string, text: string) => Node {
        const report = {
            title: 't',
            generatedAt: '',
            state: { runId: 'r', trajectory: [] },
            blobs: {},
            truncated: [],
            media: [],
            mounts,
        } as unknown as RunReport;
        const html = renderReportHtml(report).replace(
            /<script type="module">[\s\S]*?<\/script>/,
            '',
        );
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const load = dom.window.eval(`(function (MERMAID_URL) {${CLIENT}\nreturn linkedPre;})`) as (
            url: string,
        ) => (cls: string, text: string) => Node;
        return load('');
    }

    const links = (pre: Node): [string, string][] =>
        [...pre.querySelectorAll('a')].map((a) => [
            a.textContent ?? '',
            a.getAttribute('href') ?? '',
        ]);

    it('carries the mounts it was given', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const state = { runId: 'r', trajectory: [] } as unknown as AgentState;
        expect((await buildRunReport(state, payloads, { mounts })).mounts).toEqual(mounts);
        expect((await buildRunReport(state, payloads)).mounts).toBeUndefined();
    });

    it('links every spelling of a workspace path and keeps the text as written', () => {
        const text =
            'wrote /workspace/out/report.html. Open file:///workspace/a%20b.html#top, ' +
            'or (/workspace) itself';
        const pre = linkedPre()('text', text);
        expect(pre.textContent).toBe(text);
        expect(links(pre)).toEqual([
            ['/workspace/out/report.html', 'file:///Users/me/my%20proj/out/report.html'],
            ['file:///workspace/a%20b.html#top', 'file:///Users/me/my%20proj/a%20b.html#top'],
            ['/workspace', 'file:///Users/me/my%20proj'],
        ]);
    });

    it('links nothing that is not a path in the workspace', () => {
        const text =
            '/workspace/../etc/passwd /home/workspace/x /workspaces/y /workspace.bak x/workspace/z';
        const pre = linkedPre()('text', text);
        expect(pre.textContent).toBe(text);
        expect(links(pre)).toEqual([]);
    });

    it('links each tree to its own directory, in the order they appear', () => {
        const text = 'read /skills/report/SKILL.md and /assets/api.yaml, not /skills/reporter/x';
        const pre = linkedPre()('text', text);
        expect(pre.textContent).toBe(text);
        expect(links(pre)).toEqual([
            ['/skills/report/SKILL.md', 'file:///Users/me/app/agents/skills/report/SKILL.md'],
            ['/assets/api.yaml', 'file:///Users/me/app/assets/api.yaml'],
        ]);
    });
});

// ---------------------------------------------------------------------------
// The memory view
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
    }
});

const AT = '2026-01-01T00:00:00.000Z';

async function memory(noteText = 'written by this run'): Promise<MemoryStore> {
    const dir = mkdtempSync(join(tmpdir(), 'zn-runmem-'));
    dirs.push(dir);
    const store = await MemoryStore.open(dir);
    const all = ['*'];
    store.graph.add({ id: 'task', kind: 'task', text: 'reconcile the ledger', audience: all }, AT);
    store.graph.add({ id: 'plan', kind: 'plan', text: 'diff, then explain', audience: all }, AT);
    store.graph.add({ id: 'note', kind: 'fact', text: noteText, audience: all }, AT);
    store.graph.add({ id: 'other', kind: 'fact', text: 'not this run', audience: all }, AT);
    store.graph.link('task', 'plan', 'PRODUCED', AT);
    store.graph.link('plan', 'other', 'INFORMED', AT);
    return store;
}

/** A run that recalled two nodes and committed a third. */
function touched(): AgentState {
    return {
        runId: 'r',
        trajectory: [
            {
                type: 'memory_recall',
                id: 'n1',
                agent: 'worker',
                ts: AT,
                query: { text: 'ledger' },
                seeds: ['task'],
                nodes: [
                    { id: 'task', kind: 'task', score: 0.82 },
                    { id: 'plan', kind: 'plan', score: 0 },
                ],
                edges: [{ source: 'task', target: 'plan', relation: 'PRODUCED' }],
            },
            {
                type: 'memory_op',
                id: 'n2',
                agent: 'worker',
                ts: AT,
                op: 'commit',
                opId: 'o1',
                nodes: [{ id: 'note', kind: 'fact', revision: 1 }],
                edges: [],
                files: 0,
            },
        ],
    } as unknown as AgentState;
}

describe('the run report memory view', () => {
    it('carries the nodes the run touched, and no others', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const report = await buildRunReport(touched(), payloads, { memory: await memory() });

        expect(report.memory?.nodes.map((n) => n.id).sort()).toEqual(['note', 'plan', 'task']);
        expect(report.memory?.nodes.find((n) => n.id === 'task')?.text).toBe(
            'reconcile the ledger',
        );
        // An edge with one end outside the run is not an edge this page can draw.
        expect(report.memory?.edges).toEqual([
            { source: 'task', target: 'plan', relation: 'PRODUCED' },
        ]);
        // Degree is a fact about the memory, not about the cut.
        expect(report.memory?.nodes.find((n) => n.id === 'plan')?.degree).toBe(2);
    });

    it('finds the memory a branch touched too', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const state = {
            runId: 'r',
            trajectory: [
                {
                    type: 'join',
                    id: 'j',
                    agent: 'worker',
                    ts: AT,
                    branches: [{ name: 'b', agent: 'worker', nodes: touched().trajectory }],
                },
            ],
        } as unknown as AgentState;

        const report = await buildRunReport(state, payloads, { memory: await memory() });
        expect(report.memory?.nodes.map((n) => n.id).sort()).toEqual(['note', 'plan', 'task']);
    });

    it('says nothing when there is no memory to say it about', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const state = { runId: 'r', trajectory: [] } as unknown as AgentState;

        expect((await buildRunReport(touched(), payloads)).memory).toBeUndefined();
        expect(
            (await buildRunReport(state, payloads, { memory: await memory() })).memory,
        ).toBeUndefined();
    });

    it('renders the tab, and hides node text behind the same escaping', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const html = renderReportHtml(
            await buildRunReport(touched(), payloads, {
                memory: await memory('</script><img src=x>'),
            }),
        );

        expect(html).toContain('data-view="memory"');
        expect(html).toContain('id="mdetail"');
        expect(html).not.toContain('</script><img');
    });

    it('includes collapsible tagged section scripts and styles in the report', async () => {
        const payloads = new PayloadResolver(new InMemoryPayloadStore());
        const state = { runId: 'r', trajectory: [] } as unknown as AgentState;
        const html = await renderRunReport(state, payloads);

        expect(html).toContain('xtag-section');
        expect(html).toContain('xtag-body');
        expect(html).toContain('details.xtag-section');
        expect(html).toContain('details.xtag-section[open] > summary .preview');
    });
});
