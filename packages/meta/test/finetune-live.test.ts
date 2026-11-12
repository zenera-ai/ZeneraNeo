import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Snapshot, Tails } from '../src/meta/finetune/live.ts';
import { followLines, type Line, mainLines } from '../src/meta/finetune/tui.tsx';
import { THEMES } from '../src/tui/theme.ts';

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zen-live-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const line = (o: object): string => `${JSON.stringify({ t: '2026-10-08T10:00:00Z', ...o })}\n`;
const text = (lines: Line[]): string[] => lines.map((l) => l.map((p) => p.text).join(''));
const theme = THEMES.dark;

describe('the live view', () => {
    it('folds an events file as it grows, and starts over when a new step clears it', () => {
        const file = join(root, 'events.jsonl');
        const tails = new Tails();
        expect(tails.read(file).calls).toBe(0);

        writeFileSync(
            file,
            line({
                type: 'llm',
                model: 'vertex/gemini-a',
                in: 1000,
                cached: 0,
                out: 50,
                reasoning: 0,
            }) +
                line({
                    type: 'tool',
                    phase: 'start',
                    id: '1',
                    name: 'run_command',
                    subject: 'pytest -q',
                }),
        );
        let a = tails.read(file);
        expect(a).toMatchObject({ model: 'gemini-a', calls: 1, input: 1000, output: 50 });
        expect(a.last).toBe('run_command pytest -q');

        // Half a line is held back until the rest of it arrives.
        appendFileSync(file, '{"t":"2026-10-08T10:00:01Z","type":"say","te');
        expect(tails.read(file).lines).toHaveLength(2);
        appendFileSync(file, 'xt":"found it"}\n');
        a = tails.read(file);
        expect(a.last).toBe('found it');
        expect(a.lines).toHaveLength(3);

        // What was said stays on screen alongside the tool call it introduced.
        appendFileSync(
            file,
            line({ type: 'tool', phase: 'start', id: '2', name: 'view', subject: 'a.md' }) +
                line({ type: 'tool', phase: 'start', id: '3', name: 'view', subject: 'b.md' }),
        );
        a = tails.read(file);
        expect(a.last).toBe('view b.md');
        appendFileSync(
            file,
            line({ type: 'say', text: 'Reading c.' }) +
                line({ type: 'tool', phase: 'start', id: '4', name: 'view', subject: 'c.md' }),
        );
        expect(tails.read(file).last).toBe('Reading c. · view c.md');

        rmSync(file);
        writeFileSync(
            file,
            line({ type: 'llm', model: 'gemini-b', in: 10, cached: 0, out: 1, reasoning: 0 }),
        );
        expect(tails.read(file)).toMatchObject({ model: 'gemini-b', calls: 1, input: 10 });
    });

    it('says in one line what the agent is doing now, never what a command printed', () => {
        const file = join(root, 'events.jsonl');
        const tails = new Tails();
        writeFileSync(file, line({ type: 'think', text: 'Planning the search' }));
        expect(tails.read(file).now).toBe('thinks: Planning the search');
        appendFileSync(file, line({ type: 'say', text: 'Searching the docs.' }));
        expect(tails.read(file).now).toBe('says: Searching the docs.');
        appendFileSync(
            file,
            line({
                type: 'tool',
                phase: 'start',
                id: '1',
                name: 'bash',
                subject: 'zen rag docs search "tenant"',
            }),
        );
        expect(tails.read(file).now).toBe('runs: zen rag docs search "tenant"');
        appendFileSync(
            file,
            line({ type: 'tool', phase: 'end', id: '1', name: 'bash', ok: true }) +
                line({ type: 'llm', model: 'gemini-a', in: 1, cached: 0, out: 1, reasoning: 0 }),
        );
        expect(tails.read(file).now).toBe('runs: zen rag docs search "tenant"');
        appendFileSync(
            file,
            line({ type: 'tool', phase: 'start', id: '2', name: 'view', subject: 'a.md' }),
        );
        expect(tails.read(file).now).toBe('runs: view a.md');
        expect(tails.read(file).recent).toEqual([
            'thinks: Planning the search',
            'says: Searching the docs.',
            'runs: zen rag docs search "tenant"',
            'runs: view a.md',
        ]);
        appendFileSync(
            file,
            line({ type: 'say', text: 'Done.' }) +
                line({ type: 'think', text: 'Checking' }) +
                line({ type: 'say', text: 'All good.' }),
        );
        expect(tails.read(file).recent).toEqual([
            'says: Searching the docs.',
            'runs: zen rag docs search "tenant"',
            'runs: view a.md',
            'says: Done.',
            'thinks: Checking',
            'says: All good.',
        ]);
    });

    const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
        pid: 1,
        project: 'acme',
        state: 'running',
        at: '2026-10-08T10:00:00Z',
        elapsedMs: 65_000,
        system: 3,
        workers: { busy: 1, all: 2 },
        total: 10,
        counts: { completed: 4, difficult: 1, failed: 0 },
        parked: 0,
        applyAt: 2,
        now: [
            {
                key: 'w1',
                who: 'worker 1',
                step: 'run',
                what: 'a1 · no memory try 2',
                sinceMs: 12_000,
                stage: 'run',
                act: {
                    model: 'gemini-a',
                    calls: 2,
                    input: 2000,
                    output: 100,
                    byModel: {},
                    last: 'run_command pytest -q',
                    recent: [],
                    lines: [
                        {
                            t: '2026-10-08T10:00:00Z',
                            type: 'tool',
                            phase: 'start',
                            id: '1',
                            name: 'run_command',
                            subject: 'pytest -q',
                        },
                    ],
                },
            },
        ],
        tokens: [
            {
                stage: 'run',
                model: 'gemini-a',
                calls: 7,
                input: 12_000,
                cached: 0,
                output: 900,
                reasoning: 0,
            },
        ],
        log: Array.from({ length: 40 }, (_, i) => ({
            at: '2026-10-08T09:59:00Z',
            action: 'ran',
            case: `c${i} · no memory try 1`,
            result: '5 turns',
            took: 61_000,
            tokens: 4200,
        })),
        errors: [],
        ...over,
    });

    it('shows what runs now, the tokens and as much log as fits - nothing idle', () => {
        const lines = text(mainLines(snap(), 0, 120, 24, theme));
        expect(lines.length).toBeLessThanOrEqual(24);
        expect(lines[0]).toContain(
            'Fine-tuning acme · running · 1m 05s · system v3 · 1 of 2 workers busy',
        );
        expect(lines[1]).toContain('5 of 10 done · 4 completed · 1 difficult');
        expect(lines[1]).not.toContain('failed');
        expect(
            lines.some((l) => /^ {2}worker +task +action +elapsed +tokens +model +latest/.test(l)),
        ).toBe(true);
        expect(
            lines.some((l) =>
                /^> worker 1 +a1 · no memory try 2 +run +12s +2k +gemini-a +run_command pytest -q/.test(
                    l,
                ),
            ),
        ).toBe(true);
        expect(lines.some((l) => /^run +gemini-a +7 +12k +900/.test(l))).toBe(true);
        expect(lines.some((l) => / ran +c0 · no memory try 1 +5 turns +1m 01s +4k/.test(l))).toBe(
            true,
        );
        expect(lines.at(-1)).toContain('enter follow');
    });

    it('drops the In progress section when nothing runs, and says so while stopping', () => {
        const lines = text(mainLines(snap({ now: [], state: 'stopping' }), 0, 120, 30, theme));
        expect(lines).not.toContain('In progress');
        expect(lines.at(-1)).toContain('stopping');
    });

    it('lists what failed with its log, above the log, and only when something did', () => {
        expect(text(mainLines(snap(), 0, 120, 30, theme))).not.toContain('Errors');
        const lines = text(
            mainLines(
                snap({
                    errors: [
                        {
                            at: '2026-10-08T10:00:00Z',
                            where: 'merge-20 · no memory try 1',
                            message: "Model 'claude-x' not found (HTTP 404)",
                            log: '/p/.tmp/logs/meta.x.log',
                        },
                    ],
                }),
                0,
                160,
                30,
                theme,
            ),
        );
        const at = lines.indexOf('Errors');
        expect(at).toBeGreaterThan(-1);
        expect(lines[at + 1]).toMatch(
            /merge-20 · no memory try 1 +Model 'claude-x' not found \(HTTP 404\)/,
        );
        expect(lines[at + 2]).toContain('log /p/.tmp/logs/meta.x.log');
        expect(lines.indexOf('Log')).toBeGreaterThan(at);
        expect(lines.length).toBeLessThanOrEqual(30);
    });

    it('follows one step line by line, and says when it has ended', () => {
        const lines = text(followLines(snap(), 'w1', 120, 24, theme));
        expect(lines[0]).toContain('Following worker 1 · a1 · no memory try 2 · run');
        expect(lines.some((l) => l.includes('tool   run_command  pytest -q'))).toBe(true);
        expect(text(followLines(snap({ now: [] }), 'w1', 120, 24, theme))[0]).toContain(
            'Nothing is under way there now',
        );
    });
});
