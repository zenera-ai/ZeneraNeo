import { isCheckpoint, type AgentEvent, type TokenUsage } from '@zenera/neo';
import { cyan, dim, green, note, red, yellow } from './term.ts';

// ---------------------------------------------------------------------------
// Narration
//
// The one-shot view of a run. Every line goes to stderr, because the answer is
// what goes to stdout — `zen run "…" > answer.md` must produce a file with the
// answer in it and nothing else, whether or not anyone watched it happen.
//
// Deltas are not printed. A one-shot run is usually redirected, piped or in
// CI, and token-by-token output in a log file is noise; what is useful there is
// the shape of what happened, which is what the checkpoints describe.
// ---------------------------------------------------------------------------

export interface NarratorOptions {
    /** print nothing at all */
    quiet?: boolean;
    /** print text deltas as they arrive, for a terminal that is watching */
    live?: boolean;
}

export class Narrator {
    readonly #quiet: boolean;
    readonly #live: boolean;
    #streaming?: 'text' | 'thinking';
    #agent?: string;

    constructor(opts: NarratorOptions = {}) {
        this.#quiet = Boolean(opts.quiet);
        this.#live = Boolean(opts.live);
    }

    handle = (event: AgentEvent): void => {
        if (this.#quiet) {
            return;
        }
        // Said even when deltas are not: a run sitting silent for minutes looks hung.
        if (event.type === 'model_retry') {
            this.#break();
            const at = new Date(event.retryAt).toLocaleTimeString();
            note(
                `${yellow('⟳')} ${event.error} ${dim(`— attempt ${event.attempt}, again at ${at}`)}`,
            );
            return;
        }
        if (event.type === 'model_retry_recovered') {
            this.#break();
            note(`${green('✓')} ${dim(`the model answered after ${event.attempts} attempts`)}`);
            return;
        }
        if (!isCheckpoint(event)) {
            this.#delta(event);
            return;
        }
        this.#break();

        const where = event.branch ? dim(`[${event.branch.name}] `) : '';
        switch (event.type) {
            case 'run_created':
                this.#agent = event.agent;
                note(`${dim('·')} ${cyan(event.agent)}`);
                break;
            case 'before_tool_call':
                note(`${where}${dim('→')} ${event.call.name}`);
                break;
            case 'after_tool_call':
                if (event.node.isError) {
                    note(`${where}${red('  failed')} ${dim(event.node.name)}`);
                }
                break;
            case 'handoff':
                this.#agent = event.to;
                note(`${where}${dim('⇢')} ${cyan(event.to)} ${dim(`from ${event.from}`)}`);
                break;
            case 'before_fork':
                note(`${where}${dim('⑂')} ${event.node.branches.map((b) => b.name).join(', ')}`);
                break;
            case 'branch_finished':
                note(
                    `${dim('  ⑂')} ${event.child.name} ` +
                        (event.status === 'ok' ? green('ok') : red(event.status)),
                );
                break;
            case 'run_finished':
                if (event.branch) {
                    break;
                }
                note(`${dim('·')} ${summary(event.result.usage)}`);
                break;
            default:
                break;
        }
    };

    #delta(event: AgentEvent & { type: string }): void {
        if (!this.#live) {
            return;
        }
        const kind =
            event.type === 'text_delta'
                ? 'text'
                : event.type === 'thinking_delta'
                  ? 'thinking'
                  : undefined;
        if (!kind) {
            return;
        }
        const { delta } = event as { delta: string };
        if (!delta) {
            return;
        }
        // Reasoning and the answer are two different streams; run together they
        // read as one confused paragraph, so a switch between them breaks the
        // line first.
        if (this.#streaming && this.#streaming !== kind) {
            process.stderr.write('\n');
        }
        this.#streaming = kind;
        process.stderr.write(dim(delta));
    }

    /** Closes an open delta line before a checkpoint line lands on top of it. */
    #break(): void {
        if (this.#streaming) {
            process.stderr.write('\n');
            this.#streaming = undefined;
        }
    }

    done(): void {
        this.#break();
    }

    get agent(): string | undefined {
        return this.#agent;
    }
}

export function summary(usage: TokenUsage): string {
    const cached = usage.cachedInputTokens
        ? dim(` (${format(usage.cachedInputTokens)} cached)`)
        : '';
    const thinking = usage.reasoningTokens
        ? dim(` (${format(usage.reasoningTokens)} thinking)`)
        : '';
    return `${format(usage.inputTokens)} in${cached}  ${format(usage.outputTokens)} out${thinking}`;
}

export function format(n: number): string {
    if (n < 1000) {
        return String(n);
    }
    if (n < 1_000_000) {
        return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    }
    return `${(n / 1_000_000).toFixed(1)}M`;
}

export function duration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

export const stopMark = (reason: string): string =>
    reason === 'final' ? green('done') : reason === 'aborted' ? yellow('aborted') : red('failed');
