import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Tokens per stage and model
//
// A run is summed from its own trajectory, so every agent's model is counted
// apart; an analysis and an apply carry `model` and `tokens` in the envelope
// `zen meta run --json` printed, kept beside them.
// ---------------------------------------------------------------------------

export interface Tokens {
    calls: number;
    input: number;
    cached: number;
    output: number;
    reasoning: number;
}

export type ByModel = Record<string, Tokens>;
export type Stage = 'run' | 'analyze' | 'apply';
export const STAGES: Stage[] = ['run', 'analyze', 'apply'];
export type ByStage = Partial<Record<Stage, ByModel>>;

const zero = (): Tokens => ({ calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });

function addTo(into: ByModel, model: string, t: Tokens): void {
    const m = (into[model] ??= zero());
    m.calls += t.calls;
    m.input += t.input;
    m.cached += t.cached;
    m.output += t.output;
    m.reasoning += t.reasoning;
}

export function mergeModels(...all: (ByModel | undefined)[]): ByModel {
    const out: ByModel = {};
    for (const by of all) {
        for (const [model, t] of Object.entries(by ?? {})) {
            addTo(out, model, t);
        }
    }
    return out;
}

export function mergeStages(...all: (ByStage | undefined)[]): ByStage {
    const out: ByStage = {};
    for (const stage of STAGES) {
        const parts = all.map((s) => s?.[stage]).filter((p): p is ByModel => !!p);
        if (parts.length > 0) {
            out[stage] = mergeModels(...parts);
        }
    }
    return out;
}

export function total(by: ByModel | undefined): Tokens {
    const sum: ByModel = {};
    for (const t of Object.values(by ?? {})) {
        addTo(sum, 'all', t);
    }
    return sum.all ?? zero();
}

/** Input plus output, the input counting cached tokens. */
export function spent(by: ByModel | undefined): number {
    const s = total(by);
    return s.input + s.output;
}

interface Usage {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
}

const fromUsage = (u: Usage, calls: number): Tokens => ({
    calls,
    input: u.inputTokens ?? 0,
    cached: u.cachedInputTokens ?? 0,
    output: u.outputTokens ?? 0,
    reasoning: u.reasoningTokens ?? 0,
});

/** `vertex/gemini-3.8-flash` and `gemini-3.8-flash` are one model in a table. */
export const modelName = (m: string | undefined): string =>
    m ? m.replace(/^[^/:]+[/:]/, '') : '?';

// ---------------------------------------------------------------------------
// What one run did, from its trajectory
// ---------------------------------------------------------------------------

export interface ModelMetrics extends Tokens {
    /** the largest input of a single call */
    peak: number;
    /** time spent waiting on this model */
    ms: number;
}

export interface RunMetrics {
    models: Record<string, ModelMetrics>;
    /** summed over every lane, so parallel branches can exceed the wall clock */
    llmMs: number;
    toolMs: number;
    toolCalls: number;
    toolErrors: number;
    memory: { recall: number; load: number; grep: number; commit: number; forget: number };
    forks: number;
    branches: number;
    compactions: number;
    handoffs: number;
    /** skills loaded, preloads included, in the order first loaded */
    skills: string[];
    /** the first error a sandbox tool got from the container engine, not from a command */
    sandbox?: string;
}

/** `SandboxError`s the engine causes; a path outside the workspace is the model's own doing. */
const SANDBOX_DOWN =
    /could not (create|start) container|the sandbox container \S+ stopped|could not (write|start) the job|is not installed, or not on PATH|exceeded num_locks|cannot connect to podman/i;

const cache = new Map<string, { key: string; metrics: RunMetrics }>();

/**
 * One walk of a run's `state.json`, branches included. Nested records repeat a
 * node, so nodes are counted by id. A node is stamped when the work behind it
 * finished, so the gap to the node before it in the same lane is that work -
 * the same timing as the Stats tab of report.html.
 */
export function runMetrics(runDir: string): RunMetrics | undefined {
    const file = join(runDir, 'state.json');
    if (!existsSync(file)) {
        return undefined;
    }
    const st = statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit?.key === key) {
        return hit.metrics;
    }
    let root: unknown;
    try {
        root = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
    const m: RunMetrics = {
        models: {},
        llmMs: 0,
        toolMs: 0,
        toolCalls: 0,
        toolErrors: 0,
        memory: { recall: 0, load: 0, grep: 0, commit: 0, forget: 0 },
        forks: 0,
        branches: 0,
        compactions: 0,
        handoffs: 0,
        skills: [],
    };
    const seen = new Set<string>();
    const count = (o: Record<string, unknown>, ms: number): void => {
        switch (o.type) {
            case 'llm_call':
            case 'compaction': {
                if (!o.usage) {
                    return;
                }
                const model = o.type === 'compaction' ? 'summarizer' : modelName(o.model as string);
                const t = fromUsage(o.usage as Usage, 1);
                const into = (m.models[model] ??= { ...zero(), peak: 0, ms: 0 });
                into.calls += 1;
                into.input += t.input;
                into.cached += t.cached;
                into.output += t.output;
                into.reasoning += t.reasoning;
                into.peak = Math.max(into.peak, t.input);
                into.ms += ms;
                m.llmMs += ms;
                if (o.type === 'compaction') {
                    m.compactions++;
                }
                return;
            }
            case 'tool_result': {
                m.toolCalls++;
                m.toolErrors += o.isError ? 1 : 0;
                m.toolMs += typeof o.durationMs === 'number' ? o.durationMs : ms;
                const said = (o.result as { preview?: unknown } | undefined)?.preview;
                if (!m.sandbox && typeof said === 'string' && SANDBOX_DOWN.test(said)) {
                    m.sandbox = /"error":\s*"([^"]+)/.exec(said)?.[1] ?? said;
                }
                return;
            }
            case 'memory_recall':
                m.memory.recall++;
                return;
            case 'memory_op': {
                const op = o.op as keyof RunMetrics['memory'];
                if (op in m.memory) {
                    m.memory[op]++;
                }
                return;
            }
            case 'fork':
                m.forks++;
                m.branches += Array.isArray(o.branches) ? o.branches.length : 0;
                return;
            case 'handoff':
                m.handoffs++;
                return;
            case 'load_skills':
                for (const s of Array.isArray(o.skills) ? o.skills : []) {
                    const name = (s as { name?: unknown } | null)?.name;
                    if (typeof name === 'string' && !m.skills.includes(name)) {
                        m.skills.push(name);
                    }
                }
                return;
        }
    };
    // A branch lane starts where its parent lane was when the fork began.
    const walk = (v: unknown, lanePrev: number | undefined): void => {
        if (Array.isArray(v)) {
            let prev = lanePrev;
            for (const item of v) {
                const o = item as Record<string, unknown> | null;
                const ts = o && typeof o.ts === 'string' ? Date.parse(o.ts) : NaN;
                if (
                    o &&
                    typeof o.type === 'string' &&
                    typeof o.id === 'string' &&
                    !seen.has(o.id)
                ) {
                    seen.add(o.id);
                    count(o, prev !== undefined && !Number.isNaN(ts) ? Math.max(0, ts - prev) : 0);
                }
                walk(item, prev);
                if (!Number.isNaN(ts)) {
                    prev = ts;
                }
            }
        } else if (v && typeof v === 'object') {
            for (const x of Object.values(v)) {
                walk(x, lanePrev);
            }
        }
    };
    walk(root, undefined);
    cache.set(file, { key, metrics: m });
    return m;
}

/** The token part of a run's metrics, per model. */
export function tokensOf(m: RunMetrics): ByModel {
    return Object.fromEntries(
        Object.entries(m.models).map(([model, { calls, input, cached, output, reasoning }]) => [
            model,
            { calls, input, cached, output, reasoning },
        ]),
    );
}

export function runTokens(runDir: string): ByModel | undefined {
    const m = runMetrics(runDir);
    return m ? tokensOf(m) : undefined;
}

/** One `zen meta run --json` envelope: `{ model, tokens: { calls, inputTokens, … } }`. */
export function envelopeTokens(file: string): ByModel | undefined {
    if (!existsSync(file)) {
        return undefined;
    }
    let env: { model?: string; tokens?: Usage & { calls?: number } };
    try {
        env = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
    if (!env.tokens) {
        return undefined;
    }
    return { [modelName(env.model)]: fromUsage(env.tokens, env.tokens.calls ?? 0) };
}

/** Every envelope in `dir` named `<stem>.json` or `<stem>-<n>.json` - retries keep their own. */
export function envelopesIn(dir: string, stem: string): ByModel | undefined {
    let names: string[] = [];
    try {
        names = readdirSync(dir).filter((n) => new RegExp(`^${stem}(-\\d+)?\\.json$`).test(n));
    } catch {
        return undefined;
    }
    const parts = names.map((n) => envelopeTokens(join(dir, n))).filter((p) => !!p);
    return parts.length > 0 ? mergeModels(...parts) : undefined;
}

/** An apply's own envelopes, and - for applies from before rechecks - its guard's runs: `guard/<attempt>/<case>/<try>/`. */
export function applyTokens(dir: string): ByModel | undefined {
    const parts: (ByModel | undefined)[] = [envelopesIn(dir, 'apply')];
    const under = (d: string): string[] => {
        try {
            return readdirSync(d, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => join(d, e.name));
        } catch {
            return [];
        }
    };
    for (const tryDir of under(join(dir, 'guard')).flatMap(under).flatMap(under)) {
        parts.push(envelopesIn(tryDir, 'analyze'));
        try {
            const run = JSON.parse(readFileSync(join(tryDir, 'run.json'), 'utf8')) as {
                tokens?: ByModel;
            };
            parts.push(run.tokens);
        } catch {
            // A void run wrote none.
        }
    }
    const found = parts.filter((p) => !!p);
    return found.length > 0 ? mergeModels(...found) : undefined;
}

/** 1234 → 1.2k, 2184341 → 2.2M. */
export function short(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1000) {
        return `${Math.round(n / 1000)}k`;
    }
    return String(n);
}
