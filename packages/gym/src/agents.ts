import {
    AgentRunner,
    buildRunReport,
    renderReportHtml,
    type AgentState,
    type RunResult,
    type AnyTool,
    type Model,
} from '@zenera/neo';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Running one of gym's agents
//
// Both of them — the one that writes handlers and the one that writes the
// world — are ordinary `@zenera/neo` agents with a handful of in-process tools.
// What they share is here: a budget on tool calls, because a mock answering an
// HTTP request cannot wait on an agent with no natural end, an early stop the
// moment the job is provably done, and an HTML report of every run, so "why did
// the mock say that" has an answer that is not a guess.
// ---------------------------------------------------------------------------

export interface AgentRunOptions {
    model: Model;
    name: string;
    instructions: string;
    tools: AnyTool[];
    input: string;
    /** the run is stopped after this many tool calls, finished or not */
    maxToolCalls: number;
    /** checked after every tool call; true ends the run there */
    done?: () => boolean;
    /** where the HTML report goes; no report when unset */
    reportDir?: string;
    /** a word for the report's file name */
    label: string;
    signal?: AbortSignal;
}

export interface AgentRun {
    state: AgentState;
    stopReason: RunResult['stopReason'];
    toolCalls: number;
    report?: string;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRun> {
    const runner = new AgentRunner({ model: opts.model, recordRequests: Boolean(opts.reportDir) });
    const agent = runner.agent({
        name: opts.name,
        instructions: opts.instructions,
        tools: opts.tools,
    });
    const stop = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
    const stream = runner.run<string>(agent, opts.input, { signal });

    let toolCalls = 0;
    for await (const event of stream) {
        if (event.type === 'after_tool_call') {
            toolCalls++;
            if (opts.done?.() || toolCalls >= opts.maxToolCalls) {
                stop.abort();
            }
        }
    }
    const result = await stream.final();
    const report = opts.reportDir
        ? await saveReport(runner, result.state, opts.reportDir, `${opts.name}-${opts.label}`)
        : undefined;
    if (result.stopReason === 'failed' && !opts.done?.()) {
        throw Object.assign(new Error(result.state.error ?? `the ${opts.name} agent failed`), {
            hint: report ? `report: ${report}` : undefined,
        });
    }
    return { state: result.state, stopReason: result.stopReason, toolCalls, report };
}

/** A report is a convenience; failing to write one must not fail the run. */
async function saveReport(
    runner: AgentRunner,
    state: AgentState,
    dir: string,
    label: string,
): Promise<string | undefined> {
    try {
        mkdirSync(dir, { recursive: true });
        const built = await buildRunReport(state, runner.services.payloads, {
            title: label,
            architecture: await runner.describe(),
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = join(dir, `${stamp}-${label.replace(/[^A-Za-z0-9_.-]+/g, '_')}.html`);
        await writeFile(path, renderReportHtml(built), 'utf8');
        return resolve(path);
    } catch {
        return undefined;
    }
}
