// A run's AG-UI events, kept on disk with the user's chats, so whoever comes back to a thread -
// after a reload, a lost connection or hours later with the pod restarted - sees the whole run.
// One file per run: /data/users/<user>/runs/<thread>/<started ms>-<run id>.ndjson, one event a line.
//   RunLog          - a run being written: append, follow (all so far, then live), end
//   compact         - the deltas of each message merged into one event, which is what a replay sends
//   threadRunLogs   - a thread's run files, oldest first
//   readRunLog      - one file's events, ended as interrupted if the run never finished
import { EventType, type AGUIEvent } from '@ag-ui/core';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = /^(\d+)-([\w-]+)\.ndjson$/;

function deltaKey(e: AGUIEvent): string | undefined {
    switch (e.type) {
        case EventType.TEXT_MESSAGE_CONTENT:
            return `t:${e.messageId}`;
        case EventType.REASONING_MESSAGE_CONTENT:
            return `r:${e.messageId}`;
        case EventType.TOOL_CALL_ARGS:
            return `a:${e.toolCallId}`;
        default:
            return undefined;
    }
}

// Each stream's deltas only ever concatenate, so they can all sit at the first one's place.
export function compact(events: AGUIEvent[]): AGUIEvent[] {
    const out: AGUIEvent[] = [];
    const at = new Map<string, number>();
    for (const e of events) {
        const key = deltaKey(e);
        if (key) {
            const i = at.get(key);
            if (i !== undefined) {
                const first = out[i] as AGUIEvent & { delta: string };
                out[i] = {
                    ...first,
                    delta: first.delta + (e as { delta: string }).delta,
                } as AGUIEvent;
                continue;
            }
            at.set(key, out.length);
        }
        out.push(e);
    }
    return out;
}

export function isEnd(e: AGUIEvent | undefined): boolean {
    return e?.type === EventType.RUN_FINISHED || e?.type === EventType.RUN_ERROR;
}

export interface Follower {
    events(batch: AGUIEvent[]): void;
    end(): void;
}

export class RunLog {
    readonly runId: string;
    readonly file: string;
    readonly #maxBytes: number;
    readonly #out: WriteStream;
    readonly #events: AGUIEvent[] = [];
    readonly #followers = new Set<Follower>();
    #bytes = 0;
    #ended = false;

    private constructor(file: string, runId: string, maxBytes: number) {
        this.file = file;
        this.runId = runId;
        this.#maxBytes = maxBytes;
        this.#out = createWriteStream(file, { flags: 'a' });
        this.#out.on('error', (err) => console.error(`run log ${file}:`, err));
    }

    static open(dir: string, runId: string, maxBytes: number): RunLog {
        mkdirSync(dir, { recursive: true });
        return new RunLog(join(dir, `${Date.now()}-${runId}.ndjson`), runId, maxBytes);
    }

    get ended(): boolean {
        return this.#ended;
    }

    append(events: AGUIEvent[]): void {
        if (this.#ended || events.length === 0) return;
        for (const e of events) {
            const line = `${JSON.stringify(e)}\n`;
            // Past the cap a runaway run keeps its structure and loses its deltas.
            if (this.#bytes + line.length > this.#maxBytes && deltaKey(e)) continue;
            this.#bytes += line.length;
            this.#events.push(e);
            this.#out.write(line);
        }
        for (const f of this.#followers) f.events(events);
    }

    /** Everything so far at once, then each batch as it comes; returns the unfollow. */
    follow(f: Follower): () => void {
        f.events(compact(this.#events));
        if (this.#ended) {
            f.end();
            return () => {};
        }
        this.#followers.add(f);
        return () => this.#followers.delete(f);
    }

    /** Lets the followers go, then rewrites the file compacted. */
    async end(): Promise<void> {
        if (this.#ended) return;
        this.#ended = true;
        for (const f of this.#followers) f.end();
        this.#followers.clear();
        await new Promise<void>((resolve) => this.#out.end(resolve));
        const tmp = `${this.file}.tmp`;
        await writeFile(
            tmp,
            compact(this.#events)
                .map((e) => `${JSON.stringify(e)}\n`)
                .join(''),
        );
        await rename(tmp, this.file);
    }
}

export async function threadRunLogs(dir: string): Promise<{ runId: string; file: string }[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
    }
    return names
        .map((name) => FILE.exec(name))
        .filter((m): m is RegExpExecArray => m !== null)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((m) => ({ runId: m[2], file: join(dir, m[0]) }));
}

/** Only for a run no longer going: one without an end was cut off by a restart. */
export async function readRunLog(file: string): Promise<AGUIEvent[]> {
    const events: AGUIEvent[] = [];
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (!line) continue;
        try {
            events.push(JSON.parse(line) as AGUIEvent);
        } catch {
            // the torn last line of a run cut off mid-write
        }
    }
    const out = compact(events);
    if (!isEnd(out.at(-1))) {
        out.push({
            type: EventType.RUN_ERROR,
            message: 'the run was interrupted: the project restarted',
            code: 'interrupted',
        });
    }
    return out;
}
