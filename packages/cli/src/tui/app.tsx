import { TextInput } from '@inkjs/ui';
import { display } from '@zenera/engine';
import {
    addUsage,
    isCheckpoint,
    turns,
    zeroUsage,
    type AgentEvent,
    type TokenUsage,
} from '@zenera/neo';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { pathToFileURL } from 'node:url';
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as Engine from '../engine.ts';
import { parseA2ui } from '../a2ui.ts';
import { History } from '../history.ts';
import { format } from '../narrate.ts';
import { CliError } from '../term.ts';
import { hostUrls, hyperlink, hyperlinks, linkBlock, mountsOf, type Mounts } from './links.ts';
import { resolveTheme, THEMES, type Kind, type Theme } from './theme.ts';
import {
    ACTIVITY_ROWS,
    answerWidth,
    blocksOf,
    BOX_CHROME,
    boxWidth,
    BRANCH_ROWS,
    branchRows,
    budgetOf,
    CHROME_ROWS,
    clip,
    describeCall,
    gistOf,
    gridOf,
    summarise,
    THINKING_ROWS,
    TIME_COL,
    unmarked,
    windowOf,
    type Block,
    type Span,
} from './wrap.ts';

// ---------------------------------------------------------------------------
// The drawing surface
//
// This is the CLI's one dependency, and it is behind a dynamic import in the
// `run` command: nothing else in the tool loads React, so `zen list` and
// `zen key ls` stay as fast as they would be without it.
//
// It is a *view*. Every turn goes through `Engine.run`, exactly as the one-shot
// path does, so a session started here is indistinguishable from one started in
// a script — nothing is recorded only when someone is watching.
//
// The shape of a turn on screen is the shape of the agent loop, in the order it
// happened: what the model said, then the calls that decision led to, then what
// it said next. Everything before the answer is history the moment it lands, so
// it goes into the scrollback and stays there; only what is still in flight
// repaints, at the bottom, above the footer. The earlier layout put the
// streaming answer *below* calls that had already finished, which read as two
// unrelated logs racing each other.
//
// Reasoning is the exception: it is drawn live, above the work it decided on,
// and replaced when the next model call opens. It never reaches the scrollback
// — a summary of how the model got somewhere is worth watching and is not worth
// re-reading, and the full chain is in the trajectory and the run's report.
// ---------------------------------------------------------------------------

interface Line {
    key: string;
    kind: Kind;
    /** Drawn ahead of `text`: the verb a call row is scanned by. */
    lead?: string;
    text: string;
    detail?: string;
    /** How long a call took, drawn in its own column ahead of everything. */
    time?: string;
    /** A blank row before this one, which is how a run of calls is bounded. */
    gap?: boolean;
}

/**
 * What `Static` prints. The banner is the first of them because it is printed
 * once, exactly like a finished turn: see the note on the frame below.
 */
type Item = Line | { key: 'banner' };

/** A live A2UI interface: the renderer, loaded on demand, and the surface it draws. */
interface Interface {
    View: typeof import('./a2ui.tsx').A2uiView;
    surface: import('./a2ui.tsx').Surface;
}

const BANNER: Item = { key: 'banner' };

const isBanner = (item: Item): item is { key: 'banner' } => item.key === 'banner';

const MARK: Record<Kind, string> = {
    you: '›',
    text: ' ',
    agent: ' ',
    tool: ' ',
    note: ' ',
    error: '!',
};

// ---------------------------------------------------------------------------
// What is happening right now
//
// A finished turn is a `Line` in the scrollback. These two are the other half:
// work that has started and not yet landed, which the transcript cannot show
// because it is not over. They live in refs rather than state — the activity
// region repaints on a timer anyway, because a spinner and a clock have to move
// whether or not an event arrived.
// ---------------------------------------------------------------------------

/** A tool call that has gone out and not come back. */
interface Running {
    callId: string;
    name: string;
    args: string;
    startedAt: number;
    /** the branch that called it; absent on the trunk */
    branch?: string;
}

/**
 * Something a branch has finished doing, kept while it runs.
 *
 * Prose and calls are one list rather than two because the order between them
 * is the whole story: a branch says what it is about to do and then does it,
 * and a box that kept only the calls threw away every sentence explaining
 * them the moment the tool went out.
 */
type Note =
    | { kind: 'call'; id: string; name: string; args: string; ms?: number; failed: boolean }
    | { kind: 'said'; id: string; text: string };

/** A branch of a fork, while it runs. */
interface Branch {
    name: string;
    agent: string;
    /** what history it started from, which is the fork's doing rather than its own */
    context: string;
    startedAt: number;
    /** model calls, which is what a branch's progress is measured in */
    steps: number;
    tools: number;
    /** what it is reasoning about now, cleared at each model call */
    thinking: string;
    /** prose arriving now, moved into the trail once the step moves on */
    said: string;
    /** whether a model call of its own is open, which is what the shimmer means */
    musing: boolean;
    /** the last few things it did and said, newest last; its box is their only home */
    trail: Note[];
}

/** Proof of life. Ten frames at 100ms is a turn of the wheel per second. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Redraw cadence for the activity region, independent of events. */
const FRAME_MS = 100;

// The theme is decided once, before the first frame, and never changes while
// the app is up — a terminal does not repaint its own scheme underneath us.
// A context rather than props only because every part of the view wants it.
const ThemeContext = React.createContext<Theme>(THEMES.dark);
const useTheme = (): Theme => useContext(ThemeContext);

interface Links {
    mounts: Mounts;
    /** the terminal draws OSC 8, so a path keeps its text and links to the host */
    osc8: boolean;
}

const LinksContext = React.createContext<Links | undefined>(undefined);

/** Without hyperlinks the only way to reach the file is to print where it is. */
const shownText = (text: string, links: Links | undefined): string =>
    links && !links.osc8 ? hostUrls(text, links.mounts) : text;

function Row({ line }: { line: Line }): React.ReactElement {
    const theme = useTheme();
    const style = theme.line[line.kind];
    if (line.kind === 'you') {
        return <Input text={line.text} />;
    }
    if (line.kind === 'tool') {
        return <Call line={line} />;
    }
    if (line.kind === 'text' || line.kind === 'agent') {
        return <Answer text={line.text} boxed={line.kind === 'agent'} />;
    }
    return (
        <Box flexDirection="row">
            <Text color={style.color}>{MARK[line.kind]} </Text>
            <Box flexDirection="column">
                <Text color={style.color}>{line.text}</Text>
                {line.detail ? <Text color={theme.chrome.color}>{line.detail}</Text> : null}
            </Box>
        </Box>
    );
}

/**
 * The question, framed and labelled.
 *
 * It is the one thing on screen the person wrote, and scrolled past it is what
 * everything below it is an answer to — so it gets a rule rather than a caret,
 * in the accent, with the text itself left in the terminal's own foreground.
 * The label is in the top rule because a frame with a name needs no legend.
 */
function Input({ text }: { text: string }): React.ReactElement {
    const theme = useTheme();
    const { stdout } = useStdout();
    const width = Math.max(INPUT_LABEL.length + 8, answerWidth(stdout?.columns ?? 80));
    return (
        <Box flexDirection="column" width={width} marginY={1}>
            <Text wrap="truncate-end">
                <Text color={theme.accent}>{'\u256d\u2500 '}</Text>
                <Text color={theme.accent} bold>
                    {INPUT_LABEL}
                </Text>
                <Text color={theme.accent}>
                    {` ${'\u2500'.repeat(width - INPUT_LABEL.length - 5)}\u256e`}
                </Text>
            </Text>
            {/* Ink owns the other three sides: it measures the text by display
                width, which padding it by hand does not. */}
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor={theme.accent}
                borderTop={false}
                paddingX={1}
            >
                <Text>{plain(text)}</Text>
            </Box>
        </Box>
    );
}

const INPUT_LABEL = '[input]';

/** C0 controls, which a paste carries and which move the cursor where it was not sent. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A pasted prompt, reduced to what a terminal can be trusted to draw in place. */
function plain(text: string): string {
    return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(CONTROL, '').trim();
}

/**
 * One finished call: how long it took, what it did, and what came back.
 *
 * Time first, because it is the one column that lines up down the page and the
 * one number worth scanning for. Nothing in the row is lifted out of the grey —
 * a call is read when it is looked for, not while the prose around it is.
 * The blank row is spent on the *first* call after something else, so a batch
 * of them reads as one block rather than a ladder.
 */
function Call({ line }: { line: Line }): React.ReactElement {
    const theme = useTheme();
    return (
        <Box marginTop={line.gap ? 1 : 0}>
            <Text wrap="truncate-end" color={theme.chrome.color}>
                <Text>{`  ${(line.time ?? '').padStart(TIME_COL)}  `}</Text>
                <Text>{line.lead}</Text>
                <Text>{line.text ? ` ${line.text}` : ''}</Text>
                <Text>{line.detail ? `  ${line.detail}` : ''}</Text>
            </Text>
        </Box>
    );
}

/**
 * A run of inline markup, drawn as nested children of an unstyled parent.
 *
 * Ink styles a whole `<Text>` or none of it, so the weights have to be
 * separate elements. They are still one text node to the layout, which is what
 * lets the parent wrap across a `**bold**` without it becoming its own line.
 */
function Spans({ spans }: { spans: readonly Span[] }): React.ReactElement {
    const theme = useTheme();
    const links = useContext(LinksContext);
    return (
        <>
            {spans.map((s, i) => (
                <Text
                    key={i}
                    bold={s.bold === true}
                    italic={s.italic === true}
                    underline={s.href !== undefined && s.href !== ''}
                    {...(s.code ? { color: theme.code.color } : {})}
                >
                    {links?.osc8 && s.href?.startsWith('file:')
                        ? hyperlink(s.href, s.text)
                        : s.text}
                </Text>
            ))}
        </>
    );
}

/**
 * One block of an answer.
 *
 * A fence is cut rather than wrapped, because its indentation is its meaning.
 * A table is laid out by `gridOf` and only ever styled a whole row at a time —
 * a span is measured by its text, so nothing here can move a column.
 */
function BlockView({
    block,
    gap,
    width,
}: {
    block: Block;
    gap: number;
    width: number;
}): React.ReactElement {
    const theme = useTheme();
    const spans = block.spans ?? [];
    switch (block.kind) {
        case 'code':
            return (
                <Box flexDirection="column" marginTop={gap}>
                    <Text
                        color={theme.chrome.color}
                    >{`\u250c\u2500${block.title ? ` ${block.title}` : ''}`}</Text>
                    {(block.lines ?? []).map((l, j) => (
                        <Box key={j} flexDirection="row">
                            <Text color={theme.chrome.color}>{'\u2502 '}</Text>
                            <Text wrap="truncate-end">{l || ' '}</Text>
                        </Box>
                    ))}
                    <Text color={theme.chrome.color}>{'\u2514\u2500'}</Text>
                </Box>
            );
        case 'table':
            return (
                <Box flexDirection="column" marginTop={gap}>
                    {gridOf(block).map((row, j) => (
                        <Text
                            key={j}
                            wrap="truncate-end"
                            bold={block.align !== undefined && j === 0}
                            {...(block.align !== undefined && j === 1
                                ? { color: theme.chrome.color }
                                : {})}
                        >
                            <Spans spans={row} />
                        </Text>
                    ))}
                </Box>
            );
        case 'heading':
            // One weight, not a ladder of them: a terminal has bold and it has
            // nothing else, so every level of heading is the same bold and the
            // nesting is carried by the words.
            return (
                <Box marginTop={gap}>
                    <Text bold>
                        <Spans spans={spans} />
                    </Text>
                </Box>
            );
        case 'item':
            return (
                <Box flexDirection="row" marginTop={gap} paddingLeft={(block.level ?? 0) * 2}>
                    <Text color={theme.chrome.color}>{`${block.marker ?? '\u2022'} `}</Text>
                    <Box flexGrow={1}>
                        <Text>
                            <Spans spans={spans} />
                        </Text>
                    </Box>
                </Box>
            );
        case 'quote':
            return (
                <Box flexDirection="row" marginTop={gap}>
                    <Text color={theme.chrome.color}>{'\u2502 '}</Text>
                    <Box flexGrow={1}>
                        <Text italic>
                            <Spans spans={spans} />
                        </Text>
                    </Box>
                </Box>
            );
        case 'rule':
            return (
                <Box marginTop={gap}>
                    <Text color={theme.chrome.color}>{'\u2500'.repeat(Math.max(3, width))}</Text>
                </Box>
            );
        default:
            return (
                <Box marginTop={gap}>
                    <Text>
                        <Spans spans={spans} />
                    </Text>
                </Box>
            );
    }
}

/**
 * Prose the agent wrote, at the width a paragraph is worth reading at.
 *
 * Only the last one is boxed. A turn says several things on its way to an
 * answer and boxing each of them turns the transcript into a stack of frames;
 * the box means *this is the answer*, and it only means that if it is rare.
 */
function Answer({ text: said, boxed }: { text: string; boxed: boolean }): React.ReactElement {
    const theme = useTheme();
    const links = useContext(LinksContext);
    const { stdout } = useStdout();
    const text = shownText(said, links);
    const width = boxWidth(text, stdout?.columns ?? 80);
    const blocks = blocksOf(text).map((b) => (links?.osc8 ? linkBlock(b, links.mounts) : b));
    const inner = width - (boxed ? 4 : GUTTER);
    const body = blocks.map((block, i) => (
        // Items of one list are one thing; a blank row between them is two
        // lists, and a list that reads as a list is most of why it was written.
        <BlockView
            key={i}
            block={block}
            width={inner}
            gap={i > 0 && !(block.kind === 'item' && blocks[i - 1]?.kind === 'item') ? 1 : 0}
        />
    ));
    // Bounded, like every answer in `examples/sdk/`: prose that runs the width of a
    // wide terminal is a worse read than prose that stops.
    return boxed ? (
        <Box
            flexDirection="column"
            width={width}
            borderStyle="round"
            borderColor={theme.chrome.color}
            paddingX={1}
            marginY={1}
        >
            {body}
        </Box>
    ) : (
        <Box flexDirection="column" width={width} paddingLeft={GUTTER} marginTop={1}>
            {body}
        </Box>
    );
}

// ---------------------------------------------------------------------------

export interface AppOptions {
    readOnly: boolean;
    /** `dark`, `light` or `auto`. Unset means `auto`. */
    theme?: string;
    /**
     * How this session was arrived at. The two questions before the first
     * frame can be answered with two keystrokes, so the header repeats which
     * way they went — a run that resumed when you meant to start over should
     * say so before the first turn, not after it.
     */
    started?: { created: boolean; freshWorkspace: boolean };
}

interface Props {
    engine: Engine.Engine;
    options: AppOptions;
    theme: Theme;
}

/**
 * What the footer knows.
 *
 * `session` is what the run state carries: the whole conversation, including
 * every turn taken before this process started. `turn` is the difference the
 * last turn made. Both are worth seeing and they are not remotely the same
 * number — with a warm cache a long session's total says almost nothing about
 * what the last question cost.
 */
interface Stats {
    session: TokenUsage;
    turn?: TokenUsage;
    /** model calls in the session, which is not the number of questions asked */
    calls: number;
    durationMs?: number;
}

function App({ engine, options, theme }: Props): React.ReactElement {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [links] = useState<Links>(() => ({
        mounts: mountsOf(engine.files),
        osc8: hyperlinks(),
    }));

    const [lines, setLines] = useState<Line[]>([]);
    const [live, setLive] = useState('');
    const [thinking, setThinking] = useState('');
    const [busy, setBusy] = useState(false);
    const [agent, setAgent] = useState(engine.state?.agentName ?? engine.project.entry);
    const [stats, setStats] = useState<Stats>({
        session: engine.state?.usage ?? zeroUsage(),
        calls: engine.state ? turns(engine.state) : 0,
    });
    /** Model calls in the turn now running, and what answered the last one. */
    const [step, setStep] = useState(0);
    const [model, setModel] = useState<string | undefined>(undefined);
    /** Whether a trunk model call is open, which is what the shimmer means. */
    const [musing, setMusing] = useState(false);

    // In flight, and therefore not in the transcript yet. Refs, because the
    // activity region below is redrawn by the frame timer regardless.
    const running = useRef(new Map<string, Running>());
    const branches = useRef(new Map<string, Branch>());
    /** The context mode of the fork now open; `branch_started` does not carry it. */
    const context = useRef('inherit');
    const lane = useLanes(theme);

    // What the turn now running has cost so far, summed per model call rather
    // than read off the state: it is wanted between calls, not after them. The
    // exact figure replaces it when the turn lands.
    const spent = useRef(zeroUsage());
    const startedAt = useRef(0);

    // The two streams, mirrored in refs.
    //
    // State is what draws them; the ref is what any other event can read. Both
    // are settled by something that happens *later* — prose is committed to the
    // scrollback when the turn moves on to a call, reasoning when the model
    // call it belongs to lands — and an event handler reading state would be
    // reading whatever the last render closed over.
    const said = useRef('');
    const mind = useRef('');
    /** The last prose committed, so the answer is not printed twice. */
    const told = useRef('');

    const stopping = useRef<AbortController | undefined>(undefined);
    const seq = useRef(0);
    /** The tallest the repainting region has been this turn, which is the height it keeps. */
    const grown = useRef(0);

    // The prompt, and how to get back into it what was asked before.
    //
    // `TextInput` is uncontrolled: it takes a starting value and owns it from
    // there. So recalling a line means handing it a new starting value and a
    // new `key`, which mounts a fresh input — that is also what puts the cursor
    // at the end of the recalled text, where it is wanted.
    const [history] = useState(() => History.open(engine.project.root));
    const [draft, setDraft] = useState('');
    const [generation, setGeneration] = useState(0);
    /**
     * An answer that is a user interface, while it is waiting to be used. It is
     * live, so it cannot be a `Line`: `Static` prints once and never repaints.
     */
    const [ui, setUi] = useState<Interface | undefined>(undefined);
    const submitRef = useRef<(value: string) => void>(() => undefined);
    /** Where in the history the prompt is; `entries.length` is the live line. */
    const at = useRef(history.entries.length);
    /** What the input holds right now, which nothing else can see. */
    const typed = useRef('');
    /** The half-written line browsing started from, returned to by walking back down. */
    const pending = useRef('');

    const remember = useCallback((value: string): void => {
        typed.current = value;
    }, []);

    const reset = useCallback((): void => {
        at.current = history.entries.length;
        pending.current = '';
        typed.current = '';
        setDraft('');
        setGeneration((g) => g + 1);
    }, [history]);

    const recall = useCallback(
        (delta: number): void => {
            const items = history.entries;
            const end = items.length;
            if (end === 0) {
                return;
            }
            if (at.current === end) {
                if (delta > 0) {
                    return;
                }
                pending.current = typed.current;
            }
            const next = Math.min(end, Math.max(0, at.current + delta));
            if (next === at.current) {
                return;
            }
            at.current = next;
            const value = next === end ? pending.current : (items[next] ?? '');
            typed.current = value;
            setDraft(value);
            setGeneration((g) => g + 1);
        },
        [history],
    );

    // A spinner and a clock have to move on their own, so the frame is driven
    // by a timer rather than by events — but only while there is something to
    // watch, so an idle prompt repaints exactly never.
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (!busy) {
            return;
        }
        const timer = setInterval(() => setFrame((n) => n + 1), FRAME_MS);
        return () => clearInterval(timer);
    }, [busy]);

    // Read during render so a resize, which re-renders the root, resizes the
    // windows below with it. The three repainting blocks share one budget: what
    // is left of the terminal once the chrome has had its rows.
    const rows = stdout?.rows ?? 24;
    const columns = stdout?.columns ?? 80;
    const spin = SPINNER[frame % SPINNER.length] as string;
    // Every branch box is the same height, so the share has to be settled
    // before the boxes are built: the rows come out of one allowance and a
    // fan-out is read across, not down.
    const allowance = Math.min(ACTIVITY_ROWS, Math.max(0, rows - CHROME_ROWS - 2));
    const boxes = busy
        ? branchBoxesOf(
              running.current,
              branches.current,
              Date.now(),
              columns - GUTTER,
              lane,
              spin,
              branchRows(branches.current.size, allowance),
          )
        : [];
    // What the trunk itself has in flight. A branch's call is the branch's
    // business — it has a box saying so — and the trunk, having forked, is
    // waiting at the join.
    const mine = busy ? trunkCallsOf(running.current, branches.current) : [];
    const trunkRows = busy ? trunkRowsOf(mine, Date.now(), columns - GUTTER - 2, spin) : [];
    // Priced as far as it has got. Read during render, so the frame timer is
    // what advances the clock.
    const inflight = busy
        ? { usage: spent.current, durationMs: Date.now() - startedAt.current }
        : undefined;
    // Up from the first reasoning token until the step arrives at prose or a
    // call, which is when what it was deciding stops being the news.
    const streaming = busy && thinking !== '';
    const budget = budgetOf(rows, activityHeight(boxes, trunkRows), streaming ? THINKING_ROWS : 0);
    const fitted = fitActivity(boxes, trunkRows, budget.activity);
    // How tall the region actually needs to be, mirroring what the three blocks
    // below draw. The answer keeps a blank row above it, so what it is separated
    // from is whatever the last call left on screen.
    const textRows = Math.max(1, budget.live - 1);
    const liveWidth = live ? boxWidth(live, columns) - 4 : 0;
    const liveRows = live ? windowOf(unmarked(live, liveWidth), liveWidth, textRows).length + 1 : 0;
    const wanted =
        activityHeight(fitted.boxes, fitted.trunk) +
        (fitted.hidden ? 1 : 0) +
        (streaming ? budget.thinking : 0) +
        liveRows;
    // A turn opens against the prompt and grows up from it, one row at a time,
    // the way anything else printed to a terminal does. Reserving the whole
    // region up front instead threw the question that started it at the ceiling
    // before a word of the answer existed. It only ever grows, so the footer
    // still never rides back up: what a block gives back is left as slack.
    grown.current = busy ? Math.min(budget.total, Math.max(grown.current, wanted)) : 0;

    const push = useCallback(
        (kind: Kind, text: string, detail?: string, lead?: string, time?: string): void => {
            setLines((prev) => [
                ...prev,
                {
                    key: `${seq.current++}`,
                    kind,
                    lead,
                    text,
                    detail,
                    time,
                    // Only the call that opens a run of them is worth a blank
                    // row: the gap says *the prose stopped here*, and repeating
                    // it between siblings says nothing.
                    gap: kind === 'tool' && prev[prev.length - 1]?.kind !== 'tool',
                },
            ]);
        },
        [],
    );

    /**
     * Commit whatever the model has said so far to the scrollback.
     *
     * Called when the turn moves on to something else — a call, a fork, a
     * handoff — because that is the moment the prose stops being *what is
     * arriving* and becomes *what was said before this*. Prose that is never
     * followed by a call is the answer, so it is still on screen when the turn
     * lands, and the boxed answer replaces it in place.
     */
    const settle = useCallback((): void => {
        const text = said.current.trim();
        said.current = '';
        setLive('');
        if (text) {
            told.current = text;
            push('text', text);
        }
    }, [push]);

    /**
     * The same, for a branch: its prose moves from *arriving* into its trail.
     *
     * The trail is where the box's rows come from, so prose committed here is
     * still on screen under the call it introduced — which is the whole reason
     * a branch says anything before calling something.
     */
    const keep = useCallback((b: Branch): void => {
        const text = b.said.trim();
        b.said = '';
        if (!text) {
            return;
        }
        b.trail.push({ kind: 'said', id: `${seq.current++}`, text });
        b.trail.splice(0, b.trail.length - BRANCH_ROWS);
    }, []);

    // Deltas arrive far faster than a terminal can usefully redraw, so text is
    // accumulated in one string and React coalesces the repaints. The finished
    // answer replaces it in one piece when the turn lands.
    //
    // Reasoning is accumulated the same way and dropped when its model call
    // lands: the whole chain is in the trajectory (`LlmCallNode.thinking`) and
    // the run's report, and a summary of how an answer was reached is worth
    // watching happen and not worth a row once it has.
    const onEvent = useCallback(
        (event: AgentEvent): void => {
            if (!isCheckpoint(event)) {
                // Only the trunk's answer is drawn. A fork has several running
                // at once, and appending them all to one string is not a
                // transcript of anything: it is several answers interleaved
                // token by token. Each branch's distilled result arrives at the
                // join, and the whole of it is in the report.
                //
                // Reasoning is different: it is a progress indicator, and each
                // branch has a box to put its own in.
                const owner = event.branch ? branches.current.get(event.branch.name) : undefined;
                if (event.type === 'thinking_delta') {
                    if (owner) {
                        owner.thinking += event.delta;
                        return;
                    }
                    if (!event.branch) {
                        mind.current += event.delta;
                        setThinking(mind.current);
                    }
                    return;
                }
                if (event.type === 'text_delta') {
                    if (owner) {
                        // Same rule the trunk follows: prose supersedes the
                        // reasoning that decided on it.
                        owner.thinking = '';
                        owner.said += event.delta;
                        return;
                    }
                    if (event.branch) {
                        return;
                    }
                    // Whichever of prose or a call the step arrives at first
                    // retires the gist; the content streaming under a heading
                    // does not, which is why the heading holds still.
                    if (mind.current) {
                        mind.current = '';
                        setThinking('');
                    }
                    said.current += event.delta;
                    setLive(said.current);
                }
                return;
            }
            const from = event.branch?.name;
            switch (event.type) {
                case 'before_llm_call':
                    if (from) {
                        const b = branches.current.get(from);
                        if (b) {
                            b.steps++;
                            b.thinking = '';
                            keep(b);
                            b.musing = true;
                        }
                    } else {
                        // A step that answered without calling anything leaves
                        // its gist up; this is where it goes.
                        mind.current = '';
                        setThinking('');
                        setMusing(true);
                        setStep((n) => n + 1);
                    }
                    break;
                case 'after_llm_call':
                    // Branches included: they are what this turn is spending on.
                    spent.current = addUsage(spent.current, event.node.usage);
                    if (from) {
                        // Its gist stays up until the call it decided on goes
                        // out; only the shimmer stops, as on the trunk.
                        const b = branches.current.get(from);
                        if (b) {
                            b.musing = false;
                        }
                        break;
                    }
                    setModel(event.node.model);
                    // The gist stays until the call it decided on goes out. Only
                    // the shimmer stops, because nothing is arriving any more.
                    setMusing(false);
                    break;
                case 'before_tool_call': {
                    // Everything the model said on the way to this call is now
                    // history, and history belongs above the call, not below it.
                    // The gist goes with it: the call is what it decided on, so
                    // the row saying so supersedes the row explaining it.
                    const b = from ? branches.current.get(from) : undefined;
                    if (b) {
                        keep(b);
                        b.thinking = '';
                    } else if (!from) {
                        settle();
                        mind.current = '';
                        setThinking('');
                    }
                    running.current.set(event.call.callId, {
                        callId: event.call.callId,
                        name: event.call.name,
                        args: event.call.args.preview ?? '',
                        startedAt: Date.now(),
                        branch: from,
                    });
                    break;
                }
                case 'after_tool_call': {
                    const { node } = event;
                    const call = running.current.get(node.callId);
                    running.current.delete(node.callId);
                    const b = from ? branches.current.get(from) : undefined;
                    if (b) {
                        b.tools++;
                        // A branch's calls belong to its box, not to the
                        // transcript: several branches finishing into one
                        // scrollback is a fan-out shuffled, and the box is
                        // the only place the shape of the fork survives.
                        // The join summarises it; the report has all of it.
                        b.trail.push({
                            kind: 'call',
                            id: node.callId,
                            name: node.name,
                            args: call?.args ?? '',
                            ms: node.durationMs,
                            failed: node.isError,
                        });
                        b.trail.splice(0, b.trail.length - BRANCH_ROWS);
                        break;
                    }
                    // What it was asked and what it answered, which is the
                    // difference between knowing a tool ran and knowing what
                    // the agent did. Both are previews already; a whole file
                    // read belongs in the report, not in the scrollback.
                    const view = describeCall(node.name, call?.args ?? '');
                    push(
                        'tool',
                        clip(
                            view.subject,
                            Math.max(20, columns - view.verb.length - TIME_COL - 10),
                        ),
                        detailOf(node, columns - 4),
                        view.verb,
                        durationOf(node.durationMs) ?? '',
                    );
                    break;
                }
                case 'handoff': {
                    // A handoff inside a branch renames that branch, not the
                    // session: the trunk is still whoever forked.
                    const b = from ? branches.current.get(from) : undefined;
                    if (b) {
                        b.agent = event.to;
                        break;
                    }
                    settle();
                    setAgent(event.to);
                    push('note', `→ ${event.to}`, `handed off from ${event.from}`);
                    break;
                }
                case 'before_fork':
                    // Naming the branches here said nothing a box below does
                    // not say better, under the work it is doing. The one
                    // thing a box cannot say for itself is what it started
                    // from, so the fork leaves it for the boxes to carry.
                    context.current = event.node.contextMode;
                    // A fork is what the trunk concluded, so whatever it was
                    // saying is finished as far as the screen is concerned.
                    if (from) {
                        break;
                    }
                    settle();
                    push(
                        'note',
                        `⑂ ${event.node.branches.length} ${
                            event.node.branches.length === 1 ? 'branch' : 'branches'
                        }`,
                    );
                    break;
                case 'branch_started':
                    branches.current.set(event.child.name, {
                        name: event.child.name,
                        agent: event.childState.agentName,
                        context: context.current,
                        startedAt: Date.now(),
                        steps: 0,
                        tools: 0,
                        thinking: '',
                        said: '',
                        musing: false,
                        trail: [],
                    });
                    break;
                case 'branch_finished': {
                    const b = branches.current.get(event.child.name);
                    branches.current.delete(event.child.name);
                    const did = b ? `${b.steps} steps · ${b.tools} tools` : '';
                    push(
                        'tool',
                        event.child.name,
                        [event.status, did].filter(Boolean).join(' · '),
                        '⑂ branch',
                        b ? (durationOf(Date.now() - b.startedAt) ?? '') : '',
                    );
                    break;
                }
                default:
                    break;
            }
        },
        [columns, keep, push, settle],
    );

    /** What the user did to an interface becomes the next thing the agent is told. */
    const answer = useCallback(
        (action: { name: string }): void => {
            setUi(undefined);
            push('note', 'submitted', action.name);
            submitRef.current(JSON.stringify({ a2uiAction: action }));
        },
        [push],
    );

    const submit = useCallback(
        (value: string): void => {
            const text = value.trim();
            if (busy) {
                return;
            }
            // Recorded before it is acted on, so a question that fails — or
            // one that quits — is still one arrow key away next time.
            history.add(text);
            reset();
            if (!text) {
                return;
            }
            if (text === '/exit' || text === '/quit') {
                exit();
                return;
            }
            if (text === '/help') {
                push('note', 'commands', '/help  /clear  /exit · ↑ recalls, esc stops a turn');
                push(
                    'note',
                    'the footer',
                    'in = what was sent · out = what came back · a number in brackets is part' +
                        ' of the one before it, not an extra',
                );
                return;
            }
            if (text === '/clear') {
                setLines([]);
                stdout?.write('\u001b[2J\u001b[H');
                return;
            }

            push('you', text);
            setBusy(true);
            setLive('');
            setThinking('');
            said.current = '';
            mind.current = '';
            told.current = '';
            setStep(0);
            setMusing(false);
            grown.current = 0;
            spent.current = zeroUsage();
            startedAt.current = Date.now();
            running.current.clear();
            branches.current.clear();
            const controller = new AbortController();
            stopping.current = controller;

            void (async () => {
                try {
                    const outcome = await Engine.run(engine, text, onEvent, controller.signal);
                    // An answer that is an A2UI interface is drawn live, below
                    // the transcript, instead of being filed into it as text.
                    // If the renderer will not take it, it is text after all.
                    const messages = parseA2ui(outcome.text);
                    let drawn = false;
                    if (messages) {
                        try {
                            const view = await import('./a2ui.tsx');
                            const surface = view.openSurface(messages, (action) => answer(action));
                            setUi({ View: view.A2uiView, surface });
                            drawn = true;
                        } catch (err) {
                            const reason = err instanceof Error ? err.message : String(err);
                            push(
                                'note',
                                'not drawn as an interface',
                                reason.replace(/\s+/g, ' ').slice(0, 300),
                            );
                        }
                    }
                    // The answer is what the turn ended on, and it is normally
                    // still on screen unboxed — nothing followed it, so nothing
                    // committed it. Boxing it here replaces it in place. It is
                    // only skipped when the last thing the model said was
                    // already filed as prose, which is what an aborted turn
                    // looks like: the text is above the call it was cut off at.
                    if (!drawn && outcome.text.trim() && outcome.text.trim() !== told.current) {
                        push('agent', outcome.text);
                    }
                    // The previous total is the only thing that can say what
                    // this turn cost, and reading it out of the updater is what
                    // makes that true regardless of when the turn lands.
                    setStats((prev) => ({
                        session: outcome.result.usage,
                        turn: since(prev.session, outcome.result.usage),
                        calls: turns(outcome.result.state),
                        durationMs: outcome.durationMs,
                    }));
                    setAgent(outcome.result.agent);
                    if (outcome.result.stopReason === 'aborted') {
                        push('note', 'stopped');
                    }
                    if (outcome.report) {
                        push('note', `↗ report ${pathToFileURL(outcome.report).href}`);
                    }
                } catch (err) {
                    const hint = err instanceof CliError ? err.hint : undefined;
                    push('error', err instanceof Error ? err.message : String(err), hint);
                } finally {
                    setBusy(false);
                    setLive('');
                    setThinking('');
                    setMusing(false);
                    said.current = '';
                    mind.current = '';
                    running.current.clear();
                    branches.current.clear();
                    stopping.current = undefined;
                }
            })();
        },
        [busy, engine, exit, history, onEvent, push, reset, stdout],
    );
    submitRef.current = submit;

    // Escape stops the turn; ctrl-c leaves. They are different things, and a
    // run that is asked to stop still writes its state, so the session survives
    // either one.
    //
    // The arrows are ours because `TextInput` explicitly ignores them; a turn
    // in flight owns the keyboard, so they only walk the history while idle.
    useInput((input, keys) => {
        if (keys.escape && stopping.current) {
            stopping.current.abort();
        }
        if (keys.ctrl && input === 'c') {
            stopping.current?.abort();
            exit();
            return;
        }
        if (busy) {
            return;
        }
        if (ui) {
            // The interface owns the keyboard: Tab, Enter and the arrows are
            // its, and only Escape — put the interface away — is ours.
            if (keys.escape) {
                setUi(undefined);
            }
            return;
        }
        if (keys.upArrow) {
            recall(-1);
        } else if (keys.downArrow) {
            recall(1);
        }
    });

    return (
        <ThemeContext.Provider value={theme}>
            <LinksContext.Provider value={links}>
                <Box flexDirection="column">
                    {/* `Static` prints once and never repaints, so the banner and
                    finished turns scroll away into real terminal scrollback
                    instead of being redrawn on every keystroke. */}
                    <Static items={[BANNER, ...lines]}>
                        {(item) =>
                            isBanner(item) ? (
                                <Header
                                    key={item.key}
                                    engine={engine}
                                    readOnly={options.readOnly}
                                    started={options.started}
                                />
                            ) : (
                                <Row key={item.key} line={item} />
                            )
                        }
                    </Static>

                    {/* One region, which grows and never shrinks while the turn
                    runs. What it holds changes every hundred milliseconds —
                    reasoning grows, settles to a line, a fork opens four boxes
                    — and every one of those used to move the footer. The high
                    mark is held instead, and the content sits at the bottom of
                    it, so the status line stays where it was put and the slack
                    falls between the transcript and the work. */}
                    <Box
                        flexDirection="column"
                        justifyContent="flex-end"
                        height={busy ? grown.current : undefined}
                        overflow="hidden"
                    >
                        <Branches
                            boxes={fitted.boxes}
                            spin={spin}
                            frame={frame}
                            columns={columns}
                        />

                        {/* Above the work it decided on, which is the order it
                        happened in. */}
                        {streaming && budget.thinking ? (
                            <Reasoning
                                text={thinking}
                                columns={columns}
                                frame={frame}
                                live={musing}
                            />
                        ) : null}

                        <Activity rows={fitted.trunk} hidden={fitted.hidden} frame={frame} />

                        {/* The answer as it arrives, in the terminal's own
                        foreground: it is the text, not a highlight on it. */}
                        {live ? <Streaming text={live} columns={columns} rows={textRows} /> : null}
                    </Box>

                    {ui ? (
                        <Box flexDirection="column" marginY={1}>
                            <ui.View surface={ui.surface} />
                            <Text color={theme.chrome.color}>
                                tab moves · enter selects · esc closes
                            </Text>
                        </Box>
                    ) : null}

                    <Footer
                        agent={agent}
                        busy={busy}
                        spin={spin}
                        frame={frame}
                        running={mine}
                        forked={branches.current.size}
                        step={step}
                        model={model}
                        stats={stats}
                        inflight={inflight}
                        reasoning={musing && streaming}
                    />

                    {busy || ui ? null : (
                        <Box>
                            <Text color={theme.accent}>› </Text>
                            <TextInput
                                key={generation}
                                defaultValue={draft}
                                placeholder="Ask something… (↑ for history, /help for commands)"
                                onChange={remember}
                                onSubmit={submit}
                            />
                        </Box>
                    )}
                </Box>
            </LinksContext.Provider>
        </ThemeContext.Provider>
    );
}

function Header({
    engine,
    readOnly,
    started,
}: {
    engine: Engine.Engine;
    readOnly: boolean;
    started?: AppOptions['started'];
}): React.ReactElement {
    const theme = useTheme();
    const model = engine.project.config.model;
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Text bold>{engine.name}</Text>
                {started ? (
                    <Text color={theme.accent}>
                        {started.created ? ' new session' : ' continuing'}
                    </Text>
                ) : null}
                <Text color={theme.chrome.color}> {engine.session.id}</Text>
                {readOnly ? <Text color={theme.warn}> read-only</Text> : null}
            </Box>
            <Text color={theme.chrome.color}>
                {started ? `${started.freshWorkspace ? 'new directory' : 'workspace'} ` : ''}
                {display(engine.workspace)}
                {model ? ` · ${model}` : ''}
            </Text>
        </Box>
    );
}

// ---------------------------------------------------------------------------
// The repainting frame
//
// Everything below `Static` is redrawn on every event, and it has one hard
// constraint: **it must never be taller than the terminal.** Ink erases the
// previous frame by moving the cursor up over it, which only works while that
// frame is still on screen. A frame that outgrows the viewport scrolls its own
// top away, the erase falls short, and every repaint strands another copy of
// its first line in the scrollback — the same line, over and over, with the
// text creeping sideways as the stream advances.
//
// The unit that matters here is the **row the terminal draws**, not the line
// the model wrote. A reasoning stream is one enormous paragraph with almost no
// newlines in it, so counting `\n` says "six lines" while the terminal draws
// sixty. So `windowOf` wraps the text itself, to a width it knows, and takes
// the last N wrapped rows — and then the same number is given again as an
// explicit `height` with `overflow="hidden"`, so a miscount clips instead of
// corrupting.
//
// Nothing is lost by any of it: the finished answer lands in `Static` whole,
// and the full reasoning chain is in the trajectory and the run's report.
//
// How the rows are divided between the three blocks is `budgetOf` in wrap.ts.
// ---------------------------------------------------------------------------

/** The gutter every streaming block is indented behind. */
const GUTTER = 2;

// ---------------------------------------------------------------------------
// The activity region
//
// The gap this fills: a turn that spends ninety seconds in one tool call used
// to draw a static word in the footer and nothing else, so the only honest
// reading of the screen was that the thing had hung. What is missing from a
// transcript is never the finished work — that scrolls past — it is the work
// that has started, which has no line yet because it has no outcome yet.
// ---------------------------------------------------------------------------

/**
 * One row of it: something in flight, and how long it has been.
 *
 * The columns are the committed transcript's columns — mark, elapsed, verb,
 * subject — so a call crossing from *running* to *ran* does not move sideways.
 * The mark is the two columns a finished row leaves blank, which is where the
 * spinner goes.
 */
interface ActivityRow {
    key: string;
    /** the spinner while it runs, a tick once it has returned */
    mark: string;
    /** elapsed or final, right-aligned into the time column */
    time: string;
    /** the verb, carrying what weight a dim row can give */
    lead: string;
    text: string;
    /** its branch's lane, absent on the trunk */
    color?: string;
    /** what the branch is reasoning about rather than something it called */
    thinking?: boolean;
    /** prose the branch wrote, drawn as the transcript draws the trunk's */
    said?: boolean;
    /** whether the text is still arriving, which is what the sweep says */
    shimmer?: boolean;
}

/** A branch of a fork, drawn as a box of its own. */
interface BranchBox {
    name: string;
    color?: string;
    title: string;
    /** what it started from, drawn beside the title */
    context: string;
    /** what it has done, drawn in the closing rule */
    stats: string;
    /** how long it has been at it, drawn in the closing rule */
    elapsed: string;
    rows: ActivityRow[];
}

/** The most rows of a branch's own prose a box will show. */
const SAY_ROWS = 2;

/**
 * A fan-out, demultiplexed into one box per branch. Interleaving eight
 * branches' calls into a single list is not a picture of parallel work, it is
 * eight pictures shuffled together; a box per branch is what `examples/sdk/board.ts`
 * gets right and what makes the shape of the fork legible at a glance.
 *
 * A box shows the last few calls the branch made and whatever it has in flight,
 * in that order: what it just did is why it is doing this. `share` is how many
 * rows it may spend on them, so the region is bounded however wide the fork is.
 *
 * A branch between calls is not idle, it is deciding what to call next, so its
 * box keeps a row saying so rather than collapsing and making the whole board
 * jump every time a tool returns.
 */
function branchBoxesOf(
    tools: ReadonlyMap<string, Running>,
    branches: ReadonlyMap<string, Branch>,
    now: number,
    width: number,
    lane: (name?: string) => string | undefined,
    spin: string,
    share: number,
): BranchBox[] {
    const boxes: BranchBox[] = [];
    const room = (w: number): number => Math.max(12, w - TIME_COL - 8);
    for (const b of branches.values()) {
        // What it has done and said, in the order it happened. A branch's prose
        // never reaches the scrollback — several of them landing in one
        // transcript is a fan-out shuffled — so the box is the only place it is
        // ever read, and it stays there once the call it introduced goes out.
        const trail: ActivityRow[] = [];
        for (const note of b.trail) {
            if (note.kind === 'said') {
                windowOf(note.text, width - 2, SAY_ROWS).forEach((line, i) =>
                    trail.push({
                        key: `s:${note.id}:${i}`,
                        mark: '',
                        time: '',
                        lead: '',
                        text: line,
                        said: true,
                    }),
                );
                continue;
            }
            const view = describeCall(note.name, note.args);
            trail.push({
                key: `d:${note.id}`,
                mark: note.failed ? '✗' : '✓',
                time: note.failed ? 'failed' : (durationOf(note.ms) ?? ''),
                lead: view.verb,
                text: clip(view.subject, room(width) - view.verb.length),
            });
        }
        // Prose arriving now, and failing that what it is reasoning about —
        // one supersedes the other exactly as on the trunk. Either way it sits
        // between what the branch did and what it is doing, because it is what
        // got it from one to the other.
        const say = b.said.trim() ? windowOf(b.said, width - 2, SAY_ROWS) : [];
        const gist =
            !say.length && b.thinking.trim() ? gistOf(b.thinking, width - TIME_COL - 6) : '';
        const narration: ActivityRow[] = say.length
            ? say.map((line, i) => ({
                  key: `s:${b.name}:${i}`,
                  mark: '',
                  time: '',
                  lead: '',
                  text: line,
                  said: true,
              }))
            : gist
              ? [
                    {
                        key: `g:${b.name}`,
                        mark: '',
                        time: '',
                        lead: '',
                        text: gist,
                        thinking: true,
                        shimmer: b.musing,
                    },
                ]
              : [];
        const live: ActivityRow[] = [];
        for (const t of tools.values()) {
            if (t.branch === b.name && live.length < share) {
                const view = describeCall(t.name, t.args);
                live.push({
                    key: `t:${t.callId}`,
                    mark: spin,
                    time: secs(now - t.startedAt),
                    lead: view.verb,
                    text: clip(view.subject, room(width) - view.verb.length),
                });
            }
        }
        // The tail, so the newest is always the row nearest the closing rule
        // and what is in flight is never the thing that got cut.
        const rows: ActivityRow[] = [...trail, ...narration, ...live];
        if (!rows.length) {
            rows.push({
                key: `w:${b.name}`,
                mark: '',
                time: '',
                lead: '',
                text: 'thinking…',
                thinking: true,
                shimmer: b.musing,
            });
        }
        boxes.push({
            name: b.name,
            color: lane(b.name),
            title: `${b.name}${b.agent ? ` · ${b.agent}` : ''}`,
            context: `context ${b.context}`,
            stats:
                `${b.steps} ${b.steps === 1 ? 'step' : 'steps'}` +
                (b.tools ? `  ${b.tools} ${b.tools === 1 ? 'tool' : 'tools'}` : ''),
            elapsed: secs(now - b.startedAt),
            rows: rows.slice(-share),
        });
    }
    return boxes;
}

/** What the trunk itself has in flight: everything no live branch owns. */
function trunkCallsOf(
    tools: ReadonlyMap<string, Running>,
    branches: ReadonlyMap<string, Branch>,
): Running[] {
    return [...tools.values()].filter((t) => t.branch === undefined || !branches.has(t.branch));
}

/** What the trunk itself has in flight. It is one thread, so it gets no box. */
function trunkRowsOf(
    calls: readonly Running[],
    now: number,
    width: number,
    spin: string,
): ActivityRow[] {
    return calls.map((t) => {
        const view = describeCall(t.name, t.args);
        return {
            key: `t:${t.callId}`,
            mark: spin,
            time: secs(now - t.startedAt),
            lead: view.verb,
            text: clip(view.subject, Math.max(12, width - TIME_COL - view.verb.length - 6)),
        };
    });
}

/** The rows the whole region wants before anything is cut. */
function activityHeight(boxes: readonly BranchBox[], trunk: readonly ActivityRow[]): number {
    return boxes.reduce((n, b) => n + BOX_CHROME + b.rows.length, 0) + trunk.length;
}

/**
 * Boxes first and whole: half a box is an opening rule with nothing to close
 * it, so a branch that does not fit is counted rather than clipped.
 */
function fitActivity(
    boxes: readonly BranchBox[],
    trunk: readonly ActivityRow[],
    allowance: number,
): { boxes: BranchBox[]; trunk: ActivityRow[]; hidden: number } {
    const kept: BranchBox[] = [];
    let used = 0;
    for (const b of boxes) {
        const h = BOX_CHROME + b.rows.length;
        if (used + h > allowance) {
            break;
        }
        kept.push(b);
        used += h;
    }
    let hidden = boxes.length - kept.length;
    // A branch that is neither drawn nor counted has simply vanished from the
    // fork. If the boxes filled the region exactly there is no row left to say
    // so, so the last of them gives one back.
    while (hidden && used + 1 > allowance && kept.length) {
        const last = kept.pop() as BranchBox;
        used -= BOX_CHROME + last.rows.length;
        hidden++;
    }
    return {
        boxes: kept,
        trunk: trunk.slice(0, Math.max(0, allowance - used - (hidden ? 1 : 0))),
        hidden,
    };
}

function Branches({
    boxes,
    spin,
    frame,
    columns,
}: {
    boxes: BranchBox[];
    spin: string;
    frame: number;
    columns: number;
}): React.ReactElement {
    const theme = useTheme();
    // What a row has between the two sides. Ink truncates rather than wraps, so
    // anything wider than this would eat the closing side rather than the box
    // costing itself a row it was not given.
    const inner = Math.max(1, columns - 4);
    return (
        <Box flexDirection="column">
            {boxes.map((b) => {
                const title = clip(b.title, Math.max(1, columns - 10));
                // The name is the branch's; the context is the fork's doing,
                // so it is set after the spinner in the chrome's own grey
                // rather than lifted into the lane with the name.
                const said = `${title} ${spin}  ${b.context}`;
                // Who it is heads the box; what it has done and how long it has
                // been doing it close it. A count belongs with the clock, and a
                // name reads better without two numbers after it.
                const foot = clip(`${b.stats} · ${b.elapsed}`, Math.max(1, columns - 8));
                // One hue for the whole frame. A rule in one colour meeting a
                // side in another is read as two things that failed to join.
                const edge = b.color ?? theme.chrome.color;
                return (
                    <Box key={b.name} flexDirection="column" height={BOX_CHROME + b.rows.length}>
                        <Text wrap="truncate-end" color={edge}>
                            <Text>{'╭─ '}</Text>
                            <Text bold>{title}</Text>
                            <Text>{` ${spin}`}</Text>
                            <Text color={theme.chrome.color}>{`  ${b.context} `}</Text>
                            <Text>
                                {'─'.repeat(Math.max(0, columns - said.length - 5))}
                                {'╮'}
                            </Text>
                        </Text>
                        {b.rows.map((r) => (
                            <Text key={r.key} wrap="truncate-end">
                                <Text color={edge}>{'│ '}</Text>
                                <Work row={r} frame={frame} />
                                <Text color={edge}>
                                    {`${' '.repeat(Math.max(0, inner - widthOf(r)))} │`}
                                </Text>
                            </Text>
                        ))}
                        <Text wrap="truncate-end" color={edge}>
                            <Text>{'╰─ '}</Text>
                            <Text color={theme.chrome.color}>{foot}</Text>
                            <Text>
                                {` ${'─'.repeat(Math.max(0, columns - foot.length - 5))}`}
                                {'╯'}
                            </Text>
                        </Text>
                    </Box>
                );
            })}
        </Box>
    );
}

/**
 * The columns `Work` draws `row` in. It lives here so the two stay in step:
 * a box closes on the right, and a side rule can only be put where the content
 * is known to have stopped.
 */
function widthOf(row: ActivityRow): number {
    if (row.thinking || row.said) {
        return row.text.length;
    }
    return (
        2 +
        Math.max(TIME_COL, row.time.length) +
        2 +
        row.lead.length +
        (row.text ? row.text.length + 1 : 0)
    );
}

/**
 * A row of work in the same shape the transcript will keep it in.
 *
 * `mark` occupies the two columns a committed row leaves blank, so the spinner
 * sits where nothing will be once the call returns and the time, verb and
 * subject never move.
 */
function Work({ row, frame }: { row: ActivityRow; frame: number }): React.ReactElement {
    const theme = useTheme();
    // Reasoning and prose are drawn in a branch's box exactly as they are drawn
    // on the trunk: no mark, at the trunk's own gutter, the sweep saying it is
    // still arriving. A branch is an agent, not a subsystem.
    if (row.thinking) {
        return row.shimmer ? (
            <Shimmer text={row.text} frame={frame} color={theme.thinking.color} />
        ) : (
            <Text color={theme.thinking.color}>{row.text}</Text>
        );
    }
    if (row.said) {
        return <Text>{row.text}</Text>;
    }
    return (
        <Text color={theme.chrome.color}>
            <Text color={row.color}>{`${row.mark} `}</Text>
            <Text>{`${row.time.padStart(TIME_COL)}  `}</Text>
            <Text color={row.color}>{row.lead}</Text>
            <Text>{row.text ? ` ${row.text}` : ''}</Text>
        </Text>
    );
}

function Activity({
    rows,
    hidden,
    frame,
}: {
    rows: ActivityRow[];
    hidden: number;
    frame: number;
}): React.ReactElement | null {
    const theme = useTheme();
    if (!rows.length && !hidden) {
        return null;
    }
    return (
        <Box flexDirection="column" height={rows.length + (hidden ? 1 : 0)} overflow="hidden">
            {rows.map((r) => (
                <Text key={r.key} wrap="truncate-end">
                    <Work row={r} frame={frame} />
                </Text>
            ))}
            {hidden ? (
                <Text color={theme.chrome.color}>
                    {`  + ${hidden} more ${hidden === 1 ? 'branch' : 'branches'}`}
                </Text>
            ) : null}
        </Box>
    );
}

/**
 * A stable colour per branch, handed out in order of first sight. Held in a ref
 * so a branch keeps its colour for the whole turn rather than being recoloured
 * every time the map is rebuilt.
 */
function useLanes(theme: Theme): (name?: string) => string | undefined {
    const assigned = useRef(new Map<string, string>());
    return useCallback(
        (name?: string): string | undefined => {
            if (!name) {
                return undefined;
            }
            const seen = assigned.current.get(name);
            if (seen !== undefined) {
                return seen;
            }
            const next = theme.lanes[assigned.current.size % theme.lanes.length] as string;
            assigned.current.set(name, next);
            return next;
        },
        [theme],
    );
}

interface StreamProps {
    text: string;
    /** Terminal width. */
    columns: number;
    /** The most rows this block may occupy. */
    rows: number;
}

/**
 * Where the model has got to, in one line.
 *
 * A reasoning summary is a heading, not a document. Six rows of it pushed the
 * answer down the screen and asked to be read at the same time as the text
 * arriving below it, and once the deltas stopped there was nothing to say the
 * paragraph had finished — a block that had quietly settled read as a hang.
 *
 * So the stream is drawn as its gist, and the shimmer is the proof it is
 * moving. The line outlives the call that wrote it — it is why the calls below
 * it are being made, and a gist that vanished with its own model call was on
 * screen for a fraction of the work it explains — but the shimmer stops, so a
 * settled thought is never mistaken for an arriving one.
 */
function Reasoning({
    text,
    columns,
    frame,
    live,
}: {
    text: string;
    columns: number;
    frame: number;
    live: boolean;
}): React.ReactElement {
    const theme = useTheme();
    const gist = gistOf(text, columns - GUTTER - 2);
    return (
        <Box height={1} paddingLeft={GUTTER} overflow="hidden">
            <Text wrap="truncate-end">
                {live ? (
                    <Shimmer text={gist} frame={frame} color={theme.thinking.color} />
                ) : (
                    <Text color={theme.thinking.color}>{gist}</Text>
                )}
            </Text>
        </Box>
    );
}

function Streaming({ text: said, columns, rows }: StreamProps): React.ReactElement {
    const text = shownText(said, useContext(LinksContext));
    // The same width the finished answer will take, so landing it reflows
    // nothing: what is on screen is what stays there.
    //
    // Markers are resolved but nothing is styled. This region repaints, and
    // everything that repaints is measured by `.length` — so the stream gets
    // the words the answer will have and the weights it will not, which is the
    // half of the change that can be made without lying about the height.
    const shown = windowOf(
        unmarked(text, boxWidth(text, columns) - 4),
        boxWidth(text, columns) - 4,
        rows,
    );
    return (
        <Box
            flexDirection="column"
            paddingLeft={GUTTER}
            marginTop={1}
            height={shown.length}
            overflow="hidden"
        >
            {shown.map((row, i) => (
                <Text key={i} wrap="truncate-end">
                    {row}
                </Text>
            ))}
        </Box>
    );
}

/** The label column the two number rows line up behind. */
const LABEL = 10;

/** Frames the crest spends past the end, so a sweep reads as a pass, not a loop. */
const SWEEP_GAP = 6;

/**
 * A crest of weight travelling through a word, left to right.
 *
 * The spinner is proof the process is alive, but it is chrome and the eye
 * reads the word beside it — a word that never moves is what a hung run looks
 * like. The wave is weight rather than hue because the theme has no ramp to
 * spend: a short bold crest travels through the word, and the word keeps
 * whatever colour its role gave it. The trough is the word's own weight, not
 * `dim` — a hue with `dim` over it is what Apple Terminal renders as nothing.
 */
function Shimmer({
    text,
    frame,
    color,
}: {
    text: string;
    frame: number;
    color?: string;
}): React.ReactElement {
    const chars = [...text];
    // A new word is a new thing to say, so the sweep starts over on it rather
    // than picking the crest up wherever the last word had got to.
    const begun = useRef(frame);
    const said = useRef(text);
    if (said.current !== text) {
        said.current = text;
        begun.current = frame;
    }
    const head = (frame - begun.current) % (chars.length + SWEEP_GAP);
    return (
        <Text>
            {chars.map((ch, i) => {
                // The crest sits on the head and the tail drags behind it.
                const behind = head - i;
                return (
                    <Text key={i} color={color} bold={behind >= 0 && behind <= 2}>
                        {ch}
                    </Text>
                );
            })}
        </Text>
    );
}

function Footer({
    agent,
    busy,
    spin,
    frame,
    running,
    forked,
    step,
    model,
    stats,
    inflight,
    reasoning,
}: {
    agent: string;
    busy: boolean;
    spin: string;
    frame: number;
    running: Running[];
    /** branches out on a fork, which is what the trunk is waiting on */
    forked: number;
    step: number;
    model?: string;
    stats: Stats;
    inflight?: { usage: TokenUsage; durationMs: number };
    /** Reasoning tokens are what is arriving right now. */
    reasoning: boolean;
}): React.ReactElement {
    const theme = useTheme();
    // Who before what. The agent is the subject of the sentence, and in a
    // handoff it is the thing that changed.
    const aside = [
        ...(step ? [`step ${step}`] : []),
        ...(model ? [model] : []),
        'esc to stop',
    ].join(' · ');
    // One word for what the turn is spending its time on, and the three are
    // different kinds of waiting: the model is composing, the model is
    // reasoning about what to compose, or the model is not running at all and
    // something else is. What the call actually is belongs to the row above,
    // which has the width to say it.
    const phase = running.length || forked ? 'waiting' : reasoning ? 'reasoning' : 'working';
    const what =
        phase !== 'waiting'
            ? phase
            : running.length > 1
              ? `waiting on ${running.length} tools`
              : forked && !running.length
                ? // Having forked, the trunk has nothing of its own to do. The
                  // boxes above say what the branches are doing.
                  `waiting on ${forked} ${forked === 1 ? 'branch' : 'branches'}`
                : 'waiting';
    const hue = theme.phase[phase];
    return (
        <Box flexDirection="column" marginTop={1}>
            <Box>
                <Text color={theme.accent}>{agent}</Text>
                {busy ? (
                    <Text color={hue}>
                        {'  '}
                        {spin} <Shimmer text={`${what}…`} frame={frame} color={hue} />
                    </Text>
                ) : null}
                {busy ? <Text color={theme.chrome.color}>{`  ${aside}`}</Text> : null}
            </Box>
            {inflight ? (
                <Text color={theme.chrome.color}>
                    {'this turn'.padEnd(LABEL)}
                    {tokens(inflight.usage)}
                    {` · ${secs(inflight.durationMs)}`}
                </Text>
            ) : (
                <>
                    {stats.turn ? (
                        <Text color={theme.chrome.color}>
                            {'last turn'.padEnd(LABEL)}
                            {tokens(stats.turn)}
                            {stats.durationMs === undefined
                                ? ''
                                : ` · ${durationOf(stats.durationMs) ?? ''}`}
                        </Text>
                    ) : null}
                    <Text color={theme.chrome.color}>
                        {'session'.padEnd(LABEL)}
                        {tokens(stats.session)}
                        {stats.calls
                            ? ` · ${stats.calls} ${stats.calls === 1 ? 'call' : 'calls'}`
                            : ''}
                    </Text>
                </>
            )}
        </Box>
    );
}

/**
 * Cache and reasoning are SUBSETS of the number beside them, so they are drawn
 * inside it. On one dotted line they read as four things to add up, which is
 * the single reading that is wrong. Both are skipped when the provider reports
 * nothing — most do not, and a row of zeroes teaches nobody anything.
 */
function tokens(usage: TokenUsage): string {
    const cached = usage.cachedInputTokens ? ` (${format(usage.cachedInputTokens)} cached)` : '';
    const think = usage.reasoningTokens ? ` (${format(usage.reasoningTokens)} thinking)` : '';
    return `${format(usage.inputTokens)} in${cached} · ${format(usage.outputTokens)} out${think}`;
}

/** What the last turn added. Usage only ever grows, so a subtraction is safe. */
function since(before: TokenUsage, after: TokenUsage): TokenUsage {
    return {
        inputTokens: after.inputTokens - before.inputTokens,
        cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
        outputTokens: after.outputTokens - before.outputTokens,
        reasoningTokens: after.reasoningTokens - before.reasoningTokens,
    };
}

function durationOf(ms?: number): string | undefined {
    return ms === undefined ? undefined : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A clock that is being watched. Always seconds, so the digits do not jump. */
function secs(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * What a finished tool call has to say for itself.
 *
 * The duration has its own column on the row now, and the branch has its own
 * box, so what is left is the outcome: `summarise` reads the fields that matter
 * for the tools the runtime ships and falls back to the raw preview for the
 * ones it does not know.
 */
function detailOf(
    node: { isError: boolean; name: string; result: { preview?: string } },
    width: number,
): string {
    const said = summarise(node.name, node.result.preview ?? '');
    const parts = [...(node.isError ? ['failed'] : []), ...(said ? [said] : [])];
    // One row. Two left a six-character orphan under most results, and a
    // preview is already a preview: the whole of it is a click away in the
    // report, and a wall of it here buries the next answer.
    return clip(parts.join(' · '), Math.max(40, width));
}

// ---------------------------------------------------------------------------

export async function start(engine: Engine.Engine, options: AppOptions): Promise<void> {
    // Asked before Ink takes the terminal: the query talks to stdin directly,
    // and there is exactly one moment when nothing else is holding it.
    const theme = await resolveTheme(options.theme);
    const { render } = await import('ink');
    // Ctrl-C is handled above so an in-flight turn can be aborted and recorded
    // rather than the process simply vanishing mid-write.
    const instance = render(<App engine={engine} options={options} theme={theme} />, {
        exitOnCtrlC: false,
    });
    await instance.waitUntilExit();
}
