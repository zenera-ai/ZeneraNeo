import type { Input, InputPart } from '@zenera/neo';
import {
    addUsage,
    isCheckpoint,
    mergeModelUsage,
    zeroUsage,
    type AgentEvent,
    type ModelUsage,
    type TokenUsage,
} from '@zenera/neo';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { duration, format } from './narrate.ts';
import type { BatchItem } from './request.ts';

/**
 * What a batch looks like while it is still running.
 *
 * A hundred interleaved event streams on one terminal is not progress, it is
 * noise — but the same events, folded per item and written to one file, are a
 * dashboard. So the batch directory keeps a `README.md` that is rewritten once
 * a second: open it in any editor with a preview and it is a live view of
 * every run, and when the batch ends the last write leaves the same file as
 * the report of what happened.
 *
 * Nothing here is load-bearing. Every number is derived from events that are
 * also recorded properly elsewhere, and a failed write is swallowed: a batch
 * must not die because its dashboard could not be refreshed.
 */

const TICK_MS = 1000;
/** How much of the model's last words to keep. Enough to recognise, not to read. */
const TAIL = 220;
const BAR_WIDTH = 28;
/** A line no wider than this is one line in the panel, on any screen. */
const PANEL_WIDTH = 116;

export type ItemStatus = 'queued' | 'running' | 'ok' | 'failed';

interface ItemProgress {
    id: string;
    index: number;
    question: string;
    status: ItemStatus;
    /** what it is doing right now, in two or three words */
    stage: string;
    agent?: string;
    branch?: string;
    startedAt?: number;
    finishedAt?: number;
    /** model calls finished */
    turns: number;
    tools: number;
    lastTool?: string;
    lastToolFailed?: boolean;
    thinking?: string;
    text?: string;
    usage: TokenUsage;
    /** the same tokens, split by the model that spent them */
    models: readonly ModelUsage[];
    error?: string;
}

export interface ProgressOptions {
    dir: string;
    project: string;
    projectDir: string;
    /** the batch file this came from */
    input: string;
    concurrency: number;
    memory: string;
    items: readonly BatchItem[];
}

export class BatchProgress {
    readonly #opts: ProgressOptions;
    readonly #items: ItemProgress[];
    readonly #startedAt = Date.now();
    #timer?: ReturnType<typeof setInterval>;
    #writing?: Promise<void>;
    #again = false;
    #finishedAt?: number;

    constructor(opts: ProgressOptions) {
        this.#opts = opts;
        this.#items = opts.items.map((item) => ({
            id: item.id,
            index: item.index,
            question: question(item.input),
            status: 'queued',
            stage: 'queued',
            turns: 0,
            tools: 0,
            usage: zeroUsage(),
            models: [],
        }));
    }

    get file(): string {
        return join(this.#opts.dir, 'README.md');
    }

    /** Starts the ticking. Unref'd: the dashboard never holds the process open. */
    begin(): void {
        this.#timer ??= setInterval(() => void this.#flush(), TICK_MS);
        this.#timer.unref?.();
        void this.#flush();
    }

    /** The event sink for one item, ready to hand to `Engine.run`. */
    watch(id: string): (event: AgentEvent) => void {
        const item = this.#find(id);
        item.status = 'running';
        item.stage = 'starting';
        item.startedAt = Date.now();
        return (event) => this.#on(item, event);
    }

    finish(
        id: string,
        outcome: {
            ok: boolean;
            error?: string;
            usage?: TokenUsage;
            models?: readonly ModelUsage[];
        },
    ): void {
        const item = this.#find(id);
        item.status = outcome.ok ? 'ok' : 'failed';
        item.stage = outcome.ok ? 'done' : 'failed';
        item.finishedAt = Date.now();
        item.error = outcome.error;
        // The result's own accounting is the authority; the running total is
        // only what the events happened to carry.
        if (outcome.usage) {
            item.usage = outcome.usage;
        }
        if (outcome.models) {
            item.models = outcome.models;
        }
    }

    /** Stops the clock and leaves the file as the record of the finished batch. */
    async close(): Promise<void> {
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = undefined;
        }
        this.#finishedAt = Date.now();
        for (const item of this.#items) {
            if (item.status === 'running') {
                item.status = 'failed';
                item.stage = 'interrupted';
                item.error = 'interrupted before it finished';
                item.finishedAt = this.#finishedAt;
            }
        }
        await this.#flush();
    }

    #find(id: string): ItemProgress {
        const item = this.#items.find((i) => i.id === id);
        if (!item) {
            throw new Error(`no such batch item: ${id}`);
        }
        return item;
    }

    #on(item: ItemProgress, event: AgentEvent): void {
        item.branch = event.branch?.name;
        if (!isCheckpoint(event)) {
            switch (event.type) {
                case 'thinking_delta':
                    item.stage = 'thinking';
                    item.thinking = tail(item.thinking, event.delta);
                    break;
                case 'text_delta':
                    item.stage = 'writing';
                    item.text = tail(item.text, event.delta);
                    break;
                case 'tool_call_detected':
                    item.stage = `calling ${event.name}`;
                    break;
                case 'model_retry':
                    item.stage = `model failing, retry ${event.attempt + 1} at ${event.retryAt.slice(11, 19)}Z`;
                    break;
                default:
                    break;
            }
            return;
        }
        switch (event.type) {
            case 'run_created':
                item.agent = event.agent;
                item.stage = 'starting';
                break;
            case 'before_llm_call':
                item.agent = event.agent;
                item.stage = 'waiting on the model';
                // A new turn's reasoning is not the last turn's.
                item.thinking = undefined;
                item.text = undefined;
                break;
            case 'after_llm_call':
                item.turns += 1;
                item.usage = addUsage(item.usage, event.node.usage);
                item.models = mergeModelUsage(item.models, [
                    { model: event.node.model, calls: 1, usage: event.node.usage },
                ]);
                break;
            case 'before_tool_call':
                item.tools += 1;
                item.lastTool = event.call.name;
                item.lastToolFailed = undefined;
                item.stage = `running ${event.call.name}`;
                break;
            case 'after_tool_call':
                item.lastTool = event.node.name;
                item.lastToolFailed = event.node.isError;
                item.stage = 'working';
                break;
            case 'handoff':
                item.agent = event.to;
                item.stage = `handed to ${event.to}`;
                break;
            case 'before_fork':
                item.stage = `forked into ${event.node.branches.map((b) => b.name).join(', ')}`;
                break;
            case 'branch_finished':
                item.stage = `branch ${event.child.name} ${event.status}`;
                break;
            case 'run_finished':
                if (!event.branch) {
                    item.stage = 'finishing';
                }
                break;
            default:
                break;
        }
    }

    /**
     * One write at a time, and never a stale last write: a tick that lands
     * mid-write is remembered and repeated afterwards, so the file always ends
     * up holding the newest render rather than whichever call returned last.
     */
    #flush(): Promise<void> {
        if (this.#writing) {
            this.#again = true;
            return this.#writing;
        }
        this.#writing = (async () => {
            try {
                await writeFile(this.file, this.render(), 'utf8');
            } catch {
                // A dashboard nobody can write is not a reason to lose a batch.
            }
            this.#writing = undefined;
            if (this.#again) {
                this.#again = false;
                await this.#flush();
            }
        })();
        return this.#writing;
    }

    /** Exported for the tests: the whole file, from the state in hand. */
    render(): string {
        const now = this.#finishedAt ?? Date.now();
        const done = this.#items.filter((i) => i.status === 'ok' || i.status === 'failed');
        const failed = done.filter((i) => i.status === 'failed');
        const running = this.#items.filter((i) => i.status === 'running');
        const queued = this.#items.filter((i) => i.status === 'queued');
        const total = this.#items.reduce((sum, i) => addUsage(sum, i.usage), zeroUsage());

        const out: string[] = [];
        out.push(`# ${this.#opts.project} — batch`);
        out.push('');
        out.push(
            this.#finishedAt
                ? `**Finished** ${stampOf(now)} · ${duration(now - this.#startedAt)}`
                : `**Running** · updated ${stampOf(now)} · ${duration(now - this.#startedAt)} elapsed`,
        );
        out.push('');
        out.push(
            `\`${bar(done.length, this.#items.length)}\` **${done.length}/${this.#items.length}**` +
                ` · ${done.length - failed.length} ok · ${failed.length} failed` +
                ` · ${running.length} running · ${queued.length} queued`,
        );
        out.push('');
        out.push(...this.#facts(total, done, now));
        const slots = Math.min(this.#opts.concurrency, running.length + queued.length);
        if (slots > 0) {
            out.push('', '## Running now', '');
            out.push(...panel(running, slots, now));
        }
        const models = mergeModelUsage(...this.#items.map((i) => i.models));
        if (models.length > 0) {
            // Below the panel on purpose: this table gains a row whenever a new
            // model is first used, and anything above the panel that grows
            // moves the panel down between ticks.
            out.push('', '## Tokens by model', '');
            out.push(...byModel(models));
        }
        if (done.length > 0) {
            out.push('', '## Finished', '');
            out.push(...table(done));
        }
        if (failed.length > 0) {
            out.push('', '## What went wrong', '');
            for (const item of failed) {
                out.push(`- **${item.id}** — ${oneLine(item.error ?? 'failed')}`);
            }
        }
        if (queued.length > 0) {
            out.push('', '## Waiting', '');
            out.push(queued.map((i) => `\`${i.id}\``).join(' · '));
        }
        out.push('', '---', '');
        out.push(
            this.#finishedAt
                ? `Every answer is in \`batch.json\`, and each item's own \`output.json\`.`
                : `This file is rewritten every second while the batch runs.`,
        );
        out.push('');
        return out.join('\n');
    }

    #facts(total: TokenUsage, done: readonly ItemProgress[], now: number): string[] {
        const spent = done
            .map((i) => (i.finishedAt ?? now) - (i.startedAt ?? now))
            .reduce((a, b) => a + b, 0);
        const rows: [string, string][] = [
            ['Batch', `\`${this.#opts.dir}\``],
            ['Project', `\`${this.#opts.projectDir}\``],
            ['Input', `\`${this.#opts.input}\``],
            ['Memory', this.#opts.memory],
            ['Concurrency', `${this.#opts.concurrency} at a time`],
            ['Tokens', tokens(total)],
            // Always present, even before the first item lands: a row that
            // appears later pushes everything below it down a line.
            ['Average run', done.length === 0 ? '—' : duration(Math.round(spent / done.length))],
        ];
        return [
            '| | |',
            '| :-- | :-- |',
            ...rows.map(([name, value]) => `| **${name}** | ${value} |`),
        ];
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * The live part of the dashboard, and the only part that is redrawn rather
 * than appended to — so it is drawn at a **fixed height**. A preformatted
 * block never wraps, every item gets the same four lines whether or not it has
 * anything to say, and a free slot is drawn as a free slot rather than left
 * out. What is being read therefore stays where it was a second ago.
 */
function panel(running: readonly ItemProgress[], slots: number, now: number): string[] {
    const out = ['```text'];
    for (let slot = 0; slot < slots; slot += 1) {
        if (slot > 0) {
            out.push('');
        }
        const item = running[slot];
        out.push(...(item ? lines(item, now) : IDLE));
    }
    out.push('```');
    return out;
}

const IDLE = ['· idle', '  waiting for a free slot', '  —', '  ↳ —'];

function lines(item: ItemProgress, now: number): string[] {
    const words = item.text ?? item.thinking;
    const doing = words
        ? oneLine(words)
        : item.lastTool
          ? `${item.lastTool}${item.lastToolFailed === true ? ' (failed)' : ''}`
          : '—';
    return [
        `▶ #${item.index} ${item.id}`,
        `  ${oneLine(item.question)}`,
        `  ${[
            item.agent,
            item.branch ? `${item.stage} ⑂ ${item.branch}` : item.stage,
            `${duration(now - (item.startedAt ?? now))} in`,
            `turn ${item.turns + 1}`,
            `${item.tools} ${item.tools === 1 ? 'tool' : 'tools'}`,
            tokens(item.usage),
        ]
            .filter(Boolean)
            .join(' · ')}`,
        `  ↳ ${doing}`,
    ].map((line) => clip(line, PANEL_WIDTH));
}

/**
 * Which model spent what. A batch can route agents — and forks — to different
 * models, so one total belongs to none of them; these rows add back up to the
 * `Tokens` fact above.
 */
function byModel(models: readonly ModelUsage[]): string[] {
    return [
        '| model | calls | in | cached | out | thinking |',
        '| :-- | --: | --: | --: | --: | --: |',
        ...models.map(
            (m) =>
                `| ${[
                    `\`${m.model}\``,
                    String(m.calls),
                    format(m.usage.inputTokens),
                    format(m.usage.cachedInputTokens),
                    format(m.usage.outputTokens),
                    format(m.usage.reasoningTokens),
                ].join(' | ')} |`,
        ),
    ];
}

function table(done: readonly ItemProgress[]): string[] {
    const rows = [...done].sort((a, b) => a.index - b.index);
    return [
        '| # | item | status | took | turns | tools | tokens | question |',
        '| --: | :-- | :-- | --: | --: | --: | :-- | :-- |',
        ...rows.map(
            (i) =>
                `| ${[
                    String(i.index),
                    `\`${i.id}\``,
                    i.status === 'ok' ? '✓ ok' : '✗ failed',
                    duration((i.finishedAt ?? 0) - (i.startedAt ?? i.finishedAt ?? 0)),
                    String(i.turns),
                    String(i.tools),
                    tokens(i.usage),
                    clip(oneLine(i.question), 60),
                ].join(' | ')} |`,
        ),
    ];
}

function bar(done: number, total: number): string {
    const filled = total === 0 ? 0 : Math.round((done / total) * BAR_WIDTH);
    return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function tokens(usage: TokenUsage): string {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) {
        return '—';
    }
    const thinking = usage.reasoningTokens ? ` (${format(usage.reasoningTokens)} thinking)` : '';
    return `${format(usage.inputTokens)} in · ${format(usage.outputTokens)} out${thinking}`;
}

/** The question, as one line of a table cell rather than a document. */
function question(input: Input): string {
    if (typeof input === 'string') {
        return input;
    }
    return input.map(part).join(' ');
}

/** Media is named, not repeated: the whole point is one readable line. */
function part(one: InputPart): string {
    if (typeof one === 'string') {
        return one;
    }
    if ('text' in one) {
        return one.text;
    }
    for (const kind of ['image', 'audio', 'video', 'file'] as const) {
        if (kind in one) {
            return `[${kind}]`;
        }
    }
    return '[media]';
}

/** Markdown tables and blockquotes are line-oriented; the text is not. */
function oneLine(text: string): string {
    return clip(text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'), 400);
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tail(had: string | undefined, delta: string): string {
    const next = (had ?? '') + delta;
    return next.length > TAIL ? `…${next.slice(next.length - TAIL)}` : next;
}

function stampOf(ms: number): string {
    return new Date(ms).toTimeString().slice(0, 8);
}
