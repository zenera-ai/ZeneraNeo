import { Box, render, Text, useInput, useWindowSize } from 'ink';
import { spawn } from 'node:child_process';
import React, { useEffect, useState } from 'react';
import type { EventLine, Theme } from '../host.ts';
import { resolveTheme } from '../host.ts';
import type { NowRow, Snapshot } from './live.ts';
import { since } from './report.ts';
import type { Tuning } from './tuning.ts';
import { short } from './usage.ts';

// ---------------------------------------------------------------------------
// zen meta finetune start, in a terminal
//
// Only what is happening: the steps under way and what their agent is doing,
// the tokens spent per stage and model, and the steps that ended. Nothing idle
// gets a row and nothing is boxed. Enter follows one step's agent as it works.
// Drawn on stderr from the snapshots `live.ts` publishes every second.
// ---------------------------------------------------------------------------

export interface Part {
    text: string;
    color?: string;
    bold?: boolean;
}
export type Line = Part[];

const BAR = 20;

const fit = (text: string, width: number): string =>
    text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);

const clock = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '        ' : d.toTimeString().slice(0, 8);
};

const seconds = (ms: number | undefined): string =>
    ms === undefined
        ? ''
        : ms < 60_000
          ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
          : since(ms);

function footer(width: number, keys: string, theme: Theme): Line[] {
    return [
        [{ text: '─'.repeat(Math.max(0, width)), color: theme.chrome.color }],
        [{ text: keys, color: theme.chrome.color }],
    ];
}

function keysFor(s: Snapshot, following: boolean, url: string | undefined): string {
    if (s.state === 'stopping') {
        return 'stopping: the steps under way finish first · ctrl-c again kills them';
    }
    if (s.state !== 'running') {
        return s.state;
    }
    const open = url ? 'o open in browser · ' : '';
    return following
        ? `esc back · ${open}s stop · ctrl-c stop, twice kills`
        : `up/down choose · enter follow · ${open}s stop · ctrl-c stop, twice kills`;
}

/** The platform opener, without a shell, so the address stays one argument. */
function openInBrowser(url: string): void {
    const command =
        process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer'
              : 'xdg-open';
    spawn(command, [url], { stdio: 'ignore', detached: true })
        .on('error', () => {})
        .unref();
}

function header(s: Snapshot, theme: Theme): Line[] {
    const c = s.counts;
    const n = (k: string): number => c[k] ?? 0;
    const done = n('completed') + n('difficult');
    const filled = s.total ? Math.round((done / s.total) * BAR) : 0;
    const quiet = theme.chrome.color;
    const tally: Line = [
        { text: '█'.repeat(filled), color: theme.accent },
        { text: '░'.repeat(BAR - filled), color: quiet },
        { text: ` ${done} of ${s.total} done` },
    ];
    const add = (text: string, color?: string): void => {
        tally.push({ text: ` · ${text}`, color });
    };
    if (n('completed')) {
        add(`${n('completed')} completed`);
    }
    if (n('difficult')) {
        add(`${n('difficult')} difficult`, theme.warn);
    }
    if (n('failed')) {
        add(`${n('failed')} failed`, theme.line.error.color);
    }
    if (s.parked) {
        add(`${s.parked} parked, apply at ${s.applyAt}`);
    }
    return [
        [
            { text: `Fine-tuning ${s.project}`, bold: true },
            {
                text: ` · ${s.state} · ${since(s.elapsedMs)} · system v${s.system} · ${s.workers.busy} of ${s.workers.all} workers busy`,
                color: quiet,
            },
        ],
        tally,
    ];
}

const STAGE_HUE: Record<Theme['appearance'], Record<'run' | 'analyze' | 'apply', string>> = {
    dark: { run: 'green', analyze: 'magentaBright', apply: 'blueBright' },
    light: { run: 'green', analyze: 'magenta', apply: 'blue' },
};

/** One hue per stage in every section: run/ran, analyze/analyzed, apply/applied. */
function hue(word: string, theme: Theme): string | undefined {
    const stage = /^(run|ran)\b/.test(word)
        ? 'run'
        : word.startsWith('analy')
          ? 'analyze'
          : word.startsWith('appl')
            ? 'apply'
            : undefined;
    return stage && STAGE_HUE[theme.appearance][stage];
}

/** worker, task, action, elapsed, tokens, model, latest - split around the action cell. */
function nowCells(cells: string[], width: number): [string, string, string] {
    const [who = '', what = '', step = '', elapsed = '', tokens = '', model = '', last = ''] =
        cells;
    return [
        `${fit(who, 9)} ${fit(what, 26)} `,
        fit(step, 8),
        ` ${fit(elapsed, 7)} ${fit(tokens, 6)} ${fit(model, width >= 110 ? 22 : 16)} ${last}`,
    ];
}

const nowRow = (r: NowRow): string[] => [
    r.who,
    r.what,
    r.step,
    since(r.sinceMs),
    r.act?.calls ? short(r.act.input + r.act.output) : '',
    r.act?.model ?? '',
    r.act?.last ?? '',
];

/** case, result, took, tokens after the action: the result takes what the others leave. */
const logCells = (cells: [string, string, string, string], width: number): string => {
    const [where, result, took, tokens] = cells;
    return `${fit(where, 31)} ${fit(result, Math.max(10, width - 75))} ${fit(took, 7)} ${tokens}`;
};

/** The overview: under way, tokens, log - as many log rows as the height leaves. */
export function mainLines(
    s: Snapshot,
    selected: number,
    width: number,
    height: number,
    theme: Theme,
    url?: string,
): Line[] {
    const quiet = theme.chrome.color;
    const out: Line[] = [...header(s, theme)];
    if (s.now.length > 0) {
        out.push([], [{ text: 'In progress', bold: true }]);
        out.push([
            {
                text: `  ${nowCells(['worker', 'task', 'action', 'elapsed', 'tokens', 'model', 'latest'], width).join('')}`,
                color: quiet,
            },
        ]);
        s.now.forEach((r, i) => {
            const [before, step, after] = nowCells(nowRow(r), width);
            out.push([
                i === selected ? { text: '> ', color: theme.accent, bold: true } : { text: '  ' },
                { text: before },
                { text: step, color: hue(r.step, theme) },
                { text: after },
            ]);
        });
    }
    if (s.tokens.length > 0) {
        out.push([], [{ text: 'Tokens so far', bold: true }]);
        out.push([
            {
                text: `${fit('stage', 8)} ${fit('model', 26)} ${'calls'.padStart(6)} ${'in'.padStart(7)} ${'out'.padStart(7)}`,
                color: quiet,
            },
        ]);
        for (const r of s.tokens) {
            out.push([
                { text: fit(r.stage, 8), color: hue(r.stage, theme) },
                {
                    text: ` ${fit(r.model, 26)} ${String(r.calls).padStart(6)} ${short(r.input).padStart(7)} ${short(r.output).padStart(7)}`,
                },
            ]);
        }
    }
    if (s.errors.length > 0) {
        const red = theme.line.error.color;
        out.push([], [{ text: 'Errors', bold: true, color: red }]);
        for (const e of s.errors) {
            out.push([
                { text: `${clock(e.at)} `, color: quiet },
                { text: `${fit(e.where, 28)} ` },
                { text: e.message, color: red },
            ]);
            if (e.log) {
                out.push([{ text: `${' '.repeat(9)}log ${e.log}`, color: quiet }]);
            }
        }
    }
    const room = height - out.length - 2 - 3;
    if (s.log.length > 0 && room > 0) {
        out.push([], [{ text: 'Log', bold: true }]);
        out.push([
            {
                text: `${fit('time', 8)} ${fit('action', 18)} ${logCells(['case', 'result', 'took', 'tokens'], width)}`,
                color: quiet,
            },
        ]);
        for (const r of s.log.slice(0, room)) {
            out.push([
                { text: `${clock(r.at)} `, color: quiet },
                { text: fit(r.action, 18), color: hue(r.action, theme) },
                {
                    text: ` ${logCells(
                        [r.case, r.result, seconds(r.took), r.tokens ? short(r.tokens) : ''],
                        width,
                    )}`,
                },
            ]);
        }
    }
    return [...out, ...footer(width, keysFor(s, false, url), theme)];
}

function activity(e: EventLine, theme: Theme): Line {
    const at: Part = { text: `${clock(e.t)}  `, color: theme.chrome.color };
    switch (e.type) {
        case 'llm':
            return [
                at,
                {
                    text: `model  ${e.model}  ${short(e.in)} in, ${short(e.out)} out${e.ms ? `, ${seconds(e.ms)}` : ''}`,
                    color: theme.chrome.color,
                },
            ];
        case 'tool':
            return e.phase === 'start'
                ? [at, { text: `tool   ${e.name}  `, color: theme.accent }, { text: e.subject }]
                : [
                      at,
                      {
                          text: `       ${e.ok ? 'done' : 'failed'} ${e.name}${e.ms ? ` ${seconds(e.ms)}` : ''}`,
                          color: e.ok ? theme.chrome.color : theme.line.error.color,
                      },
                  ];
        case 'say':
            return [at, { text: 'says   ', color: theme.accent }, { text: e.text }];
        case 'think':
            return [
                at,
                { text: 'thinks ', color: theme.accent },
                { text: e.text, color: theme.chrome.color },
            ];
    }
}

/** One step's agent, line by line as it works. */
export function followLines(
    s: Snapshot,
    key: string,
    width: number,
    height: number,
    theme: Theme,
    url?: string,
): Line[] {
    const r = s.now.find((x) => x.key === key);
    const out: Line[] = [];
    if (!r) {
        out.push([{ text: 'Nothing is under way there now.', bold: true }]);
    } else {
        out.push([
            { text: `Following ${r.who}`, bold: true },
            {
                text: ` · ${r.what} · ${r.step} · ${since(r.sinceMs)}${r.act?.model ? ` · ${r.act.model}` : ''}${r.act?.calls ? ` · ${short(r.act.input + r.act.output)} tokens in ${r.act.calls} calls` : ''}`,
                color: theme.chrome.color,
            },
        ]);
        out.push([]);
        const lines = r.act?.lines ?? [];
        if (lines.length === 0) {
            out.push([{ text: 'nothing yet', color: theme.chrome.color }]);
        }
        for (const e of lines.slice(-Math.max(1, height - out.length - 3))) {
            out.push(activity(e, theme));
        }
    }
    return [...out, ...footer(width, keysFor(s, true, url), theme)];
}

function Live({
    t,
    theme,
    interrupt,
    url,
}: {
    t: Tuning;
    theme: Theme;
    interrupt: () => void;
    url: string | undefined;
}): React.JSX.Element {
    const [snap, setSnap] = useState<Snapshot | undefined>();
    const [selected, setSelected] = useState(0);
    const [follow, setFollow] = useState<string | undefined>();
    const { columns, rows } = useWindowSize();
    useEffect(() => {
        t.watchers.add(setSnap);
        return () => {
            t.watchers.delete(setSnap);
        };
    }, [t]);
    const count = snap?.now.length ?? 0;
    const at = Math.min(selected, Math.max(0, count - 1));
    useInput((input, key) => {
        if ((key.ctrl && input === 'c') || input === 's') {
            interrupt();
            return;
        }
        if (input === 'o') {
            if (url) {
                openInBrowser(url);
            }
            return;
        }
        if (follow) {
            if (key.escape) {
                setFollow(undefined);
            }
            return;
        }
        if (key.upArrow) {
            setSelected(Math.max(0, at - 1));
        } else if (key.downArrow) {
            setSelected(Math.min(count - 1, at + 1));
        } else if (key.return && snap?.now[at]) {
            setFollow(snap.now[at].key);
        }
    });
    if (!snap) {
        return <Text color={theme.chrome.color}>starting</Text>;
    }
    const height = Math.max(8, rows - 1);
    const all = follow
        ? followLines(snap, follow, columns, height, theme, url)
        : mainLines(snap, at, columns, height, theme, url);
    // Too short a terminal loses rows from the middle, never the keys at the bottom.
    const lines = all.length > height ? [...all.slice(0, height - 2), ...all.slice(-2)] : all;
    return (
        <Box flexDirection="column">
            {lines.map((parts, i) => (
                <Text key={i} wrap="truncate-end">
                    {parts.length === 0
                        ? ' '
                        : parts.map((p, j) => (
                              <Text key={j} color={p.color} bold={p.bold}>
                                  {p.text}
                              </Text>
                          ))}
                </Text>
            ))}
        </Box>
    );
}

/** Draws the tuning until the returned function is called. */
export async function watch(t: Tuning, interrupt: () => void, url?: string): Promise<() => void> {
    const theme = await resolveTheme();
    const instance = render(<Live t={t} theme={theme} interrupt={interrupt} url={url} />, {
        stdout: process.stderr,
        exitOnCtrlC: false,
    });
    return () => instance.unmount();
}
