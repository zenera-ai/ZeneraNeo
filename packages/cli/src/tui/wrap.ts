import stringWidth from 'string-width';

// ---------------------------------------------------------------------------
// Measuring in rows
//
// The unit that matters in a repainting terminal frame is the **row the
// terminal draws**, not the line the model wrote. A reasoning stream is one
// enormous paragraph with almost no newlines in it, so counting `\n` says
// "six lines" while the terminal draws sixty — and a frame that outgrows the
// viewport is the one thing Ink cannot erase (see tui/app.tsx).
//
// So the text is wrapped here, to a width we know, and measured in what comes
// out. Plain text only: nothing that reaches these functions has style codes
// in it, so there is no need to carry the machinery for counting around them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Measuring in columns
//
// A row is as wide as the cells the terminal fills, and `.length` is not that:
// `日` is one code unit and two cells, `é` written as a letter and an accent is
// two code units and one cell, and `😀` is two code units that must never be
// separated. Measured by `.length`, a row of CJK is drawn twice as wide as it
// was counted, and Ink — which truncates what does not fit — shows the first
// half of every row and drops the second.
//
// Two rulers have to be satisfied at once, and they disagree:
//
//   - Ink's, which is `string-width` over the whole string. A row that is
//     wider than its box by THIS ruler gets truncated.
//   - The terminal's, which nobody here can ask. One that does not join a
//     sequence draws `👨‍👩‍👧‍👦` as four people, eight cells, where `string-width`
//     says two. And the second half of Thai `กำ` is a vowel with a cell of
//     its own, so the pair is two cells where `string-width` says one. A row
//     that is wider than the WINDOW by this ruler is wrapped by the terminal,
//     the frame becomes taller than Ink counted, and the erase falls short.
//
// So a cluster is charged the larger of the two: what `string-width` says of
// it whole, and what its code points come to apart. Over-charging costs a few
// cells of ragged right edge on some terminals; under-charging costs text or a
// corrupted frame, so every doubt is settled upward.
//
// Text is only ever cut between grapheme clusters, for the same reason: half a
// surrogate pair is a replacement character, and an accent that opens a row
// lands on whatever is drawn before it.
// ---------------------------------------------------------------------------

/** All of ASCII, which is one column a code unit, exactly as `.length` had it. */
const ASCII = /^[\x00-\x7f]*$/;

const CLUSTERS = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * What clusters have already been found to take.
 *
 * `string-width` is thorough rather than quick, and the streaming block
 * measures its whole window again on every repaint: uncached, a window of CJK
 * cost tens of milliseconds a frame. A language's text is a few thousand
 * distinct clusters said over and over, so remembering them is nearly all of
 * the work. The table is emptied when it is full rather than aged — it refills
 * in one frame — and a cluster too long to be a word's worth of anything
 * (stacked accents) is not kept at all.
 */
const MEASURED = new Map<string, number>();
const MEASURED_MAX = 8192;
const MEASURED_KEY = 16;

/** The columns one grapheme cluster may take: see the note above. */
function clusterColumns(cluster: string): number {
    const known = MEASURED.get(cluster);
    if (known !== undefined) {
        return known;
    }
    let apart = 0;
    let points = 0;
    for (const point of cluster) {
        const code = point.codePointAt(0) as number;
        // A control character keeps the one column `.length` gave it, and a
        // lone surrogate is drawn as a replacement character.
        apart += code < 0x80 || (code >= 0xd800 && code <= 0xdfff) ? 1 : stringWidth(point);
        points += 1;
    }
    const columns = points === 1 ? apart : Math.max(apart, stringWidth(cluster));
    if (cluster.length <= MEASURED_KEY) {
        if (MEASURED.size >= MEASURED_MAX) {
            MEASURED.clear();
        }
        MEASURED.set(cluster, columns);
    }
    return columns;
}

/** `text` as the pieces it may be cut between, each with the columns it takes. */
function* clustersOf(text: string): Generator<readonly [cluster: string, columns: number]> {
    for (const { segment } of CLUSTERS.segment(text)) {
        yield [segment, clusterColumns(segment)];
    }
}

/**
 * The columns `text` may take on a terminal: never fewer than Ink will count
 * for it, and never fewer than a terminal that joins nothing will draw.
 *
 * Plain text, one row: style codes and newlines are not looked for.
 */
export function columnsOf(text: string): number {
    if (ASCII.test(text)) {
        return text.length;
    }
    let total = 0;
    for (const [, columns] of clustersOf(text)) {
        total += columns;
    }
    return total;
}

/** The longest run of whole clusters from the start of `text` that fits `width` columns. */
function headOf(text: string, width: number): string {
    if (ASCII.test(text)) {
        return text.slice(0, Math.max(0, width));
    }
    let used = 0;
    let end = 0;
    for (const [cluster, columns] of clustersOf(text)) {
        if (used + columns > width) {
            break;
        }
        used += columns;
        end += cluster.length;
    }
    return text.slice(0, end);
}

/** A row, and the columns it was found to take while it was being cut. */
type Piece = readonly [row: string, columns: number];

/**
 * `word` as rows of at most `width` columns, cut between clusters.
 *
 * A cluster that is wider than `width` on its own — a CJK character in a
 * one-column box — still gets a row, because the alternative is to never get
 * past it. That is the one case in which a row here is wider than was asked.
 */
function chunksOf(word: string, width: number): Piece[] {
    const out: Piece[] = [];
    if (ASCII.test(word)) {
        for (let at = 0; at < word.length; at += width) {
            const row = word.slice(at, at + width);
            out.push([row, row.length]);
        }
        return out;
    }
    let row = '';
    let used = 0;
    for (const [cluster, columns] of clustersOf(word)) {
        // A wide character does not straddle the edge: it moves down whole and
        // the row it left is a column short.
        if (row && used + columns > width) {
            out.push([row, used]);
            row = '';
            used = 0;
        }
        row += cluster;
        used += columns;
    }
    if (row) {
        out.push([row, used]);
    }
    return out;
}

/** Whether `text` takes at least `columns`, reading no more of it than settles that. */
function reaches(text: string, columns: number): boolean {
    if (ASCII.test(text)) {
        return text.length >= columns;
    }
    let total = 0;
    for (const [, each] of clustersOf(text)) {
        total += each;
        if (total >= columns) {
            return true;
        }
    }
    return total >= columns;
}

/** How far back `windowOf` will look for enough text, as a multiple of the usual. */
const TAIL_REACH = 16;

/**
 * The last `rows` rows of `text` once wrapped to `width`, each one short enough
 * that the terminal will not wrap it again.
 *
 * Only the tail is ever wanted, so only the tail is wrapped: `width * rows * 2`
 * COLUMNS of it is more than enough to fill the window whatever the wrapping
 * does, and bounds the work per keystroke on a stream that never stops growing.
 *
 * The tail is taken in code units, because that is what a string can be cut by
 * without reading all of it, and then checked in columns: text that spends
 * several code units a column — accents written apart, emoji sequences — would
 * otherwise fill fewer rows than the window has while there was more to show.
 * The reach is bounded, so text made of nothing but stacked accents is shown
 * short rather than read whole on every frame.
 */
export function windowOf(text: string, width: number, rows: number): string[] {
    const w = Math.max(8, width);
    const n = Math.max(1, rows);
    const wanted = w * n * 2;
    let tail = '';
    for (let reach = 1; reach <= TAIL_REACH; reach *= 2) {
        tail = whole(text.slice(-wanted * reach));
        if (wanted * reach >= text.length || reaches(tail, wanted)) {
            break;
        }
    }
    // Trailing blank rows are never information, and a stream that ends on a
    // paragraph break would spend one of the few rows it has on nothing.
    return wrap(tail.replace(/\n{2,}/g, '\n').trimEnd(), w).slice(-n);
}

/** `tail` without the half of a surrogate pair that cutting it may have left in front. */
function whole(tail: string): string {
    const first = tail.charCodeAt(0);
    return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/**
 * `text` flattened onto one row of at most `width` columns, ellipsized when it
 * did not fit. Newlines and runs of space collapse: a row is a row, and a tool
 * argument or a result preview arrives with whatever shape it happened to have.
 */
export function clip(text: string, width: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    const w = Math.max(1, width);
    return columnsOf(flat) <= w ? flat : `${headOf(flat, w - 1)}…`;
}

/**
 * Word wrap. Every returned row is at most `width` columns wide, by
 * `columnsOf`, unless a single character is wider than that by itself.
 */
export function wrap(text: string, width: number): string[] {
    const w = Math.max(1, width);
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        let used = 0;
        for (const word of paragraph.split(' ')) {
            // A word wider than the terminal has to be broken somewhere, and
            // anywhere between two characters is as good as anywhere else.
            // Cutting is also how a word is measured, so it is read once.
            const pieces = chunksOf(word, w);
            const [rest, size] = pieces.pop() ?? ['', 0];
            if (pieces.length) {
                if (line) {
                    out.push(line);
                    line = '';
                    used = 0;
                }
                for (const [row] of pieces) {
                    out.push(row);
                }
            }
            if (!line) {
                line = rest;
                used = size;
            } else if (used + 1 + size <= w) {
                line += ` ${rest}`;
                used += 1 + size;
            } else {
                out.push(line);
                line = rest;
                used = size;
            }
        }
        out.push(line);
    }
    return out;
}

/**
 * The first row of a scrolled list, moved as little as possible so that row
 * `selected` is inside a window of `height` rows over `count` of them.
 */
export function scrollTop(selected: number, top: number, height: number, count: number): number {
    const h = Math.max(1, height);
    let first = Math.min(top, selected);
    if (selected >= first + h) {
        first = selected - h + 1;
    }
    return Math.max(0, Math.min(first, count - h));
}

// ---------------------------------------------------------------------------
// Dividing the frame
//
// The same invariant, stated as arithmetic: every repainting block gets its
// rows from here, and the sum is never more than the viewport has to give.
// ---------------------------------------------------------------------------

/** The three footer rows, its margin, the prompt, and a row in hand. */
export const CHROME_ROWS = 7;

/**
 * How much of the reasoning stream is worth showing.
 *
 * One row. A reasoning summary is not a document to be read while it arrives —
 * it is the model saying what it is about to do, and the sentence that says so
 * is the heading it writes for itself. Six rows of it pushed the answer and the
 * work down the screen to make room for a paragraph nobody finishes reading,
 * and the whole chain is in the trajectory either way.
 */
export const THINKING_ROWS = 1;

/** How much of the frame the work in flight may take. A branch is a box now,
 *  not a row, so a fan-out of two costs twenty-two of these. */
export const ACTIVITY_ROWS = 24;

/** The width of the elapsed-time column every call row is drawn behind. */
export const TIME_COL = 5;

export interface Budget {
    /** rows for the list of what is in flight */
    activity: number;
    /** rows for the gist of what the model is reasoning about */
    thinking: number;
    /** rows for the answer as it arrives */
    live: number;
    /**
     * What the three of them occupy together — a constant for a given terminal,
     * whatever is happening inside it. The region grows to this and stops, and
     * never shrinks back while the turn runs, which is what keeps the footer on
     * one row instead of riding up and down on the work.
     */
    total: number;
}

/**
 * How many rows each repainting block may draw in a terminal `rows` tall.
 *
 * Activity is capped first and never takes the last two rows: the answer as it
 * arrives matters more than the machinery producing it. Reasoning yields to it
 * in turn, because it is a progress indicator and the answer is the point.
 *
 * `thinking` is how many rows of reasoning are wanted — one while the model is
 * reasoning, none otherwise — and it never takes the answer's last row.
 */
export function budgetOf(rows: number, activity: number, thinking: number): Budget {
    const total = Math.max(2, rows - CHROME_ROWS);
    const shown = Math.min(Math.max(0, activity), ACTIVITY_ROWS, Math.max(0, total - 2));
    const rest = total - shown;
    const tail = Math.min(Math.max(0, thinking), THINKING_ROWS, Math.max(0, rest - 1));
    return { activity: shown, thinking: tail, live: rest - tail, total };
}

/** The rows a branch box may spend on its own calls, prose and reasoning. */
export const BRANCH_ROWS = 9;

/**
 * The fewest a box is worth drawing at.
 *
 * One row per branch fit more of them on screen and said nothing about any of
 * them: a box holding a single call is a label, and the reason it is a box at
 * all is that what a branch just did and said is why it is doing this. Below
 * six rows there is no *what it just did* — so a fork too wide to give every
 * branch six is cut to the ones that fit and counted, which is `fitActivity`.
 */
export const BRANCH_MIN = 6;

/** Rows a branch box spends on chrome: the title rule and the closing one. */
export const BOX_CHROME = 2;

/**
 * How many call rows each of `count` branch boxes may draw, given the rows the
 * activity region has to divide between them.
 *
 * Every branch gets the same number, because they are the same kind of thing
 * and a fan-out is read across, not down.
 */
export function branchRows(count: number, allowance: number): number {
    if (count <= 0) {
        return 0;
    }
    const each = Math.floor(Math.max(0, allowance) / count) - BOX_CHROME;
    return Math.max(BRANCH_MIN, Math.min(BRANCH_ROWS, each));
}

/**
 * How wide *prose* is drawn. A line spanning a 200-column terminal is
 * measurably harder to read than one that stops, which is why every demo in
 * `examples/sdk/` puts its answer in a box of bounded width — the terminal is the
 * page, not the paragraph.
 *
 * `boxWidth` is what a whole answer is drawn at; this is the floor it starts from.
 */
export function answerWidth(columns: number): number {
    return Math.max(24, Math.min(columns - 4, 96));
}

/**
 * How wide the box holding `text` has to be.
 *
 * Prose stops at the comfort width, but a fence and a table cannot be
 * reflowed — fold a table row and the columns stop lining up, which is the one
 * thing the table was for — so the box grows to hold the widest of them, as far
 * as the terminal allows and no further.
 */
export function boxWidth(text: string, columns: number): number {
    let rigid = 0;
    for (const block of blocksOf(text)) {
        // A fence is drawn behind a `│ ` gutter; a table row is not.
        const lines =
            block.kind === 'code'
                ? (block.lines ?? []).map((l) => columnsOf(l) + 6)
                : block.kind === 'table'
                  ? textOf(block)
                        .split('\n')
                        .map((l) => columnsOf(l) + 4)
                  : [];
        for (const width of lines) {
            rigid = Math.max(rigid, width);
        }
    }
    return Math.max(answerWidth(columns), Math.min(Math.max(24, columns - 4), rigid));
}

// ---------------------------------------------------------------------------
// Reading a payload
// ---------------------------------------------------------------------------

/** One field of a preview: a JSON string, or a bare token when it was cut. */
const FIELD = /"([A-Za-z_][\w-]*)"\s*:\s*("(?:[^"\\]|\\.)*"?|[^,}\s]+)/g;

/**
 * A tool payload as a person would read it, rather than as it was serialised.
 *
 * A lone field is printed as its bare value, because the name of a generic tool
 * says almost nothing on its own — `run_command` is every shell command there
 * is, and the argument is the part that identifies THIS call.
 *
 * It scans rather than parses: previews are cut to a length, so the JSON very
 * often does not close, and precisely the calls worth reading are the long ones
 * that got cut.
 */
export function readable(preview: string): string {
    const found = [...preview.matchAll(FIELD)];
    if (!found.length) {
        return preview.trim();
    }
    const fields = found.map((m) => [m[1] as string, unquote(m[2] as string)] as const);
    const one = fields.length === 1 ? fields[0] : undefined;
    return one ? one[1] : fields.map(([k, v]) => `${k}=${v}`).join(' ');
}

function unquote(raw: string): string {
    if (!raw.startsWith('"')) {
        return raw;
    }
    const body = raw.length > 1 && raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
    return body.replace(/\\[nrt]/g, ' ').replace(/\\(["\\/])/g, '$1');
}

/** Every field of a preview, first mention winning. */
export function fieldsOf(preview: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of preview.matchAll(FIELD)) {
        const key = m[1] as string;
        if (!out.has(key)) {
            out.set(key, unquote(m[2] as string));
        }
    }
    return out;
}

/** The text between `"key":[` and the first `]`, or nothing if there is no such array. */
function arrayBody(preview: string, key: string): string | undefined {
    const at = preview.indexOf(`"${key}"`);
    if (at < 0) {
        return undefined;
    }
    const open = preview.indexOf('[', at);
    if (open < 0) {
        return undefined;
    }
    const close = preview.indexOf(']', open);
    return preview.slice(open + 1, close < 0 ? undefined : close);
}

/**
 * An array argument, as the two things worth knowing about it: what is in it,
 * when its items say their own names, and how many there are either way.
 */
function itemsOf(preview: string, key: string): { names: string[]; total: number } {
    const body = arrayBody(preview, key);
    if (body === undefined || !body.trim()) {
        return { names: [], total: 0 };
    }
    if (/^\s*\{/.test(body)) {
        const names = [...body.matchAll(/"name"\s*:\s*"([^"]*)"/g)].map((m) => m[1] as string);
        return { names, total: Math.max(names.length, (body.match(/\{/g) ?? []).length) };
    }
    const names = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string).filter(Boolean);
    return { names, total: names.length };
}

/** A few things are worth naming; more than a few are worth counting. */
function named(items: { names: string[]; total: number }, unit: string): string {
    if (!items.total) {
        return '';
    }
    if (items.names.length && items.names.length <= 2) {
        return items.names.join(', ');
    }
    return `${items.total} ${items.total === 1 ? unit : `${unit}s`}`;
}

// ---------------------------------------------------------------------------
// Reading a call
//
// A transcript row has one line in which to say what the agent just did, and
// the tool's own name next to its serialised arguments is the least readable
// way to spend it. `run_command` is every shell command there is; a
// `memory_commit` carrying three nodes and two links is a paragraph of JSON for
// something that fits in three words; `apply_patch` is an entire diff.
//
// The built-in tools are known quantities, so each one gets a verb and the one
// argument that identifies this call. Anything else \u2014 a skill's own tool, a
// sibling package's \u2014 falls back to the name and `readable`, which is what the
// rows looked like before.
// ---------------------------------------------------------------------------

/** What a call is doing, and what it is doing it to. */
export interface CallView {
    /** The verb, drawn first: what kind of thing this is. */
    verb: string;
    /** What identifies this call: a path, a command, a query. May be empty. */
    subject: string;
}

interface Shape {
    verb: string;
    /** argument names to try in order; the first one present is the subject */
    of?: readonly string[];
    /** two argument names, drawn as `from → to` */
    pair?: readonly [string, string];
    /** an array argument, named while it is short and counted once it is not */
    count?: readonly [key: string, unit: string];
}

const CALLS: Record<string, Shape> = {
    read_file: { verb: 'read', of: ['path'] },
    view_image: { verb: 'view image', of: ['path'] },
    list_dir: { verb: 'list', of: ['path'] },
    find_files: { verb: 'find', of: ['pattern'] },
    write_file: { verb: 'write', of: ['path'] },
    apply_patch: { verb: 'patch' },
    move_file: { verb: 'move', pair: ['from', 'to'] },
    delete_file: { verb: 'delete', of: ['path'] },
    run_command: { verb: 'run', of: ['command'] },
    run_command_background: { verb: 'start', of: ['command'] },
    read_command_output: { verb: 'output', of: ['job_id'] },
    stop_command: { verb: 'stop', of: ['job_id'] },
    memory_search: { verb: 'recall', of: ['query'] },
    memory_load: { verb: 'read memory', count: ['ids', 'node'] },
    memory_commit: { verb: 'remember', count: ['nodes', 'node'] },
    memory_forget: { verb: 'forget', count: ['ids', 'node'] },
    skill_search: { verb: 'find skill', of: ['query'] },
    skill_load: { verb: 'load skill', count: ['names', 'skill'] },
    fork: { verb: 'fork', count: ['branches', 'branch'] },
    final_output: { verb: 'answer' },
    search_api: { verb: 'search api', of: ['query'] },
    list_api: { verb: 'list api', of: ['name', 'kind'] },
    grep_api: { verb: 'grep api', of: ['pattern'] },
    trace_api: { verb: 'trace api', of: ['pattern'] },
};

/** The handoff tools are minted per agent, so they are matched by prefix. */
const TRANSFER = 'transfer_to_';

/** A patch names its own files, and that is the only part of it worth a row. */
const PATCHED = /\*\*\* (?:Add|Update|Delete) File:\s*(.*?)(?:\\[nr]|"|$)/g;

export function describeCall(name: string, preview: string): CallView {
    if (name.startsWith(TRANSFER)) {
        return { verb: 'hand off to', subject: name.slice(TRANSFER.length) };
    }
    const shape = CALLS[name];
    if (!shape) {
        return { verb: name, subject: readable(preview) };
    }
    if (name === 'apply_patch') {
        const files = [...preview.matchAll(PATCHED)].map((m) => (m[1] as string).trim());
        return { verb: shape.verb, subject: named({ names: files, total: files.length }, 'file') };
    }
    if (shape.pair) {
        const fields = fieldsOf(preview);
        const [from, to] = shape.pair;
        return { verb: shape.verb, subject: `${fields.get(from) ?? ''} → ${fields.get(to) ?? ''}` };
    }
    if (shape.count) {
        const [key, unit] = shape.count;
        return { verb: shape.verb, subject: named(itemsOf(preview, key), unit) };
    }
    const fields = fieldsOf(preview);
    for (const key of shape.of ?? []) {
        const value = fields.get(key);
        if (value) {
            return { verb: shape.verb, subject: value };
        }
    }
    return { verb: shape.verb, subject: '' };
}

/**
 * What a finished call has to say for itself, in the few words a row has left.
 *
 * A `[]` suffix means "count it": the interesting thing about a listing is how
 * much came back, and printing the first two of forty entries says less than
 * the number does.
 */
const RESULTS: Record<string, readonly string[]> = {
    read_file: ['lines'],
    list_dir: ['entries[]'],
    find_files: ['matches[]'],
    write_file: ['bytes'],
    apply_patch: ['files[]'],
    move_file: ['to'],
    delete_file: ['path'],
    run_command: ['exit_code'],
    run_command_background: ['job_id'],
};

export function summarise(name: string, preview: string): string {
    const fields = fieldsOf(preview);
    // An error is the whole of what happened, and it is what the next turn
    // will be about. Nothing else on the row competes with it.
    const failed = fields.get('error');
    if (failed) {
        return failed;
    }
    const parts: string[] = [];
    for (const key of RESULTS[name] ?? []) {
        if (key.endsWith('[]')) {
            const of = key.slice(0, -2);
            const { total } = itemsOf(preview, of);
            if (total) {
                parts.push(`${total} ${of}`);
            }
            continue;
        }
        const value = fields.get(key);
        if (value !== undefined && value !== '') {
            parts.push(`${key.replace(/_/g, ' ')} ${value}`);
        }
    }
    return parts.length ? parts.join(' · ') : readable(preview);
}

// ---------------------------------------------------------------------------
// The gist of a reasoning stream
// ---------------------------------------------------------------------------

/** How much of a stream is looked at for a heading. Its end is where it got to. */
const GIST_TAIL = 4000;

/** A reasoning summary writes its own headings, in bold. */
const BOLD = /\*\*([^*\n]{2,}?)\*\*/g;

/**
 * One line saying where the model has got to.
 *
 * Reasoning summaries arrive as markdown and are structured by their own bold
 * headings — Gemini emits one every few sentences, and they are the shortest
 * true account of the step. The last one is where the model is now. Failing
 * that the raw text is clipped, which is a fragment, but a moving fragment is
 * still proof that something is happening.
 */
export function gistOf(text: string, width: number): string {
    const tail = text.slice(-GIST_TAIL);
    const heads = [...tail.matchAll(BOLD)];
    const last = heads.at(-1)?.[1];
    return clip(last ?? tail, width);
}

// ---------------------------------------------------------------------------
// Reading an answer
//
// Models write markdown. What used to be read of it was the two constructs a
// terminal must not REFLOW — the fence and the table — and everything else was
// printed with its markers showing: an answer arrived as `**Summary**` and
// `- item`, which is the source, not the document.
//
// What is read here is still a subset, and the line is drawn by the invariant
// at the top of this file rather than by the spec. Block structure comes out as
// `Block`s for the view to draw with its own boxes, because INK MUST OWN
// LAYOUT: a renderer that returned its own pre-wrapped, pre-coloured string
// would make `**x**` nine columns wide to every measurement in this file and
// one column wide to the terminal — and a frame that miscounts its own height
// is the one thing Ink cannot erase.
//
// Inline markup comes out as `Span`s, which carry their styling BESIDE the
// text rather than inside it. The width of a row is therefore still the width
// of its characters — `columnsOf` — and `boxWidth` cannot be lied to.
//
// The scan is one pass and tolerant of anything half-written, because on a
// stream everything is half-written at some point: a fence with no close, a
// `**` with no partner. An unmatched marker is emitted as the text it is.
// ---------------------------------------------------------------------------

/** A run of inline text and what it is. Style rides beside the text, never in it. */
export interface Span {
    text: string;
    bold?: boolean;
    italic?: boolean;
    /** an inline code span, taken verbatim and never scanned again */
    code?: boolean;
    /** where a link points, when its own text does not say */
    href?: string;
}

export type BlockKind = 'paragraph' | 'heading' | 'item' | 'quote' | 'code' | 'table' | 'rule';

/** How a table column is set, when its rule row said. */
export type Align = 'left' | 'right' | 'center';

/**
 * One block of an answer.
 *
 * `lines`, `cells` and `spans` are exclusive and say how the block may be
 * drawn: `lines` is verbatim and must be cut rather than wrapped, `cells` is a
 * grid to be laid out by `gridOf`, `spans` is prose and the renderer may do as
 * it likes with it.
 */
export interface Block {
    kind: BlockKind;
    /** `heading`: its depth, 1-6. `item`: how deep it is nested. */
    level?: number;
    /** the fence's info string, when it had one */
    title?: string;
    /** what a list item is drawn behind — a bullet, or the number that was written */
    marker?: string;
    /** `code` only, whose indentation is its meaning */
    lines?: string[];
    /** `table` only: every row but the rule, as cells, with their markup resolved */
    cells?: Span[][][];
    /** `table` only: how each column is set, and that the first row is a header */
    align?: Align[];
    /** every other kind, with its inline markup resolved */
    spans?: Span[];
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/** What a backslash may turn back into ordinary text. */
const ESCAPABLE = /[\\`*_~[\]()#+\-.!>|]/;

/** Emphasis has to hug its own text, or `2 * 3 * 4` reads as arithmetic in italics. */
const spacey = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/** An underscore between word characters is part of the word: `snake_case_name`. */
const wordy = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Far past anything a model writes, and the thing that stops a pathological nest. */
const NESTING = 4;

/**
 * The inline markup of one block, resolved.
 *
 * Order is the correctness argument. Code is settled first and never entered
 * again, which is why this is a scanner and not a chain of replaces: in
 * "use `[a](b)` syntax" the brackets are prose, and no regex over the whole
 * string can know that. Everything else recurses on the text between its own
 * markers, so `**bold with `code` in it**` keeps both.
 */
export function inlineOf(text: string, style: Omit<Span, 'text'> = {}, depth = 0): Span[] {
    const out: Span[] = [];
    let buffer = '';
    const keep = (): void => {
        if (buffer) {
            out.push({ text: buffer, ...style });
            buffer = '';
        }
    };

    let i = 0;
    while (i < text.length) {
        const ch = text[i] as string;

        if (ch === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
            buffer += text[i + 1];
            i += 2;
            continue;
        }

        if (ch === '`') {
            const span = codeAt(text, i);
            if (span) {
                keep();
                out.push({ text: span.text, ...style, code: true });
                i = span.end;
                continue;
            }
        }

        if (depth < NESTING && (ch === '[' || (ch === '!' && text[i + 1] === '['))) {
            const link = linkAt(text, i);
            if (link) {
                keep();
                const inner = { ...style, ...(link.href ? { href: link.href } : {}) };
                out.push(...inlineOf(link.label, inner, depth + 1));
                i = link.end;
                continue;
            }
        }

        if (depth < NESTING && (ch === '*' || ch === '_' || ch === '~')) {
            const marks = ch === '~' ? 2 : Math.min(runOf(text, i, ch), 2);
            const close = marks === 2 || ch !== '~' ? closingAt(text, i, ch, marks) : undefined;
            if (close !== undefined) {
                keep();
                // Strikethrough has no weight of its own here, so it resolves
                // to its text: the markers were never meant to be read.
                const added = ch === '~' ? {} : marks === 2 ? { bold: true } : { italic: true };
                out.push(
                    ...inlineOf(text.slice(i + marks, close), { ...style, ...added }, depth + 1),
                );
                i = close + marks;
                continue;
            }
        }

        buffer += ch;
        i += 1;
    }
    keep();
    return out;
}

/** How many of `ch` run on from `at`. */
function runOf(text: string, at: number, ch: string): number {
    let n = 0;
    while (text[at + n] === ch) {
        n += 1;
    }
    return n;
}

/**
 * The code span opening at `at`, or nothing when its backticks never close.
 *
 * A run of n backticks closes on a run of exactly n, which is what lets a code
 * span contain a backtick. One space either side of the content is padding for
 * that case rather than text, so it comes off.
 */
function codeAt(text: string, at: number): { text: string; end: number } | undefined {
    const run = runOf(text, at, '`');
    const fence = '`'.repeat(run);
    let from = at + run;
    for (;;) {
        const found = text.indexOf(fence, from);
        if (found < 0) {
            return undefined;
        }
        if (text[found + run] === '`') {
            from = found + runOf(text, found, '`');
            continue;
        }
        const body = text.slice(at + run, found);
        const padded = body.length > 2 && body.startsWith(' ') && body.endsWith(' ');
        return { text: padded ? body.slice(1, -1) : body, end: found + run };
    }
}

/**
 * Where the emphasis opened at `at` closes, or nothing.
 *
 * Two of CommonMark's flanking rules earn their keep and the rest do not: a
 * marker that opens is followed by something other than a space, one that
 * closes is preceded by something other than a space. Without them `a * b * c`
 * is italic and every second multiplication in an answer goes missing.
 */
function closingAt(text: string, at: number, ch: string, marks: number): number | undefined {
    if (spacey(text[at + marks]) || (ch === '_' && wordy(text[at - 1]))) {
        return undefined;
    }
    const mark = ch.repeat(marks);
    let from = at + marks + 1;
    while (from < text.length) {
        const found = text.indexOf(mark, from);
        if (found < 0) {
            return undefined;
        }
        if (!spacey(text[found - 1]) && !(ch === '_' && wordy(text[found + marks]))) {
            return found;
        }
        from = found + 1;
    }
    return undefined;
}

/** `[label](href)` or `![alt](href)` at `at`, or nothing when it is only a bracket. */
function linkAt(
    text: string,
    at: number,
): { label: string; href: string; end: number } | undefined {
    const open = text[at] === '!' ? at + 1 : at;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\') {
            i += 1;
        } else if (ch === '[') {
            depth += 1;
        } else if (ch === ']') {
            depth -= 1;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close < 0 || text[close + 1] !== '(') {
        return undefined;
    }
    const end = text.indexOf(')', close + 2);
    if (end < 0) {
        return undefined;
    }
    // `[label](url "title")` — the title is for a tooltip nothing here has.
    const target =
        text
            .slice(close + 2, end)
            .trim()
            .split(/\s+/)[0] ?? '';
    return {
        label: text.slice(open + 1, close),
        href: target.replace(/^<|>$/g, ''),
        end: end + 1,
    };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^(\s*)(```+|~~~+)\s*(\S*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/** A markdown table row. Both pipes, so a sentence with one in it is still prose. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** A cell of the rule row under a header: dashes, and where the column is set. */
const RULE_CELL = /^:?-+:?$/;

/** What a bullet is drawn as, by how deep it is nested. */
const BULLETS = ['\u2022', '\u25e6', '\u25aa'] as const;

/** Splits a row on the pipes that divide it, dropping the two that bound it. */
function cellsOf(row: string): string[] {
    const out: string[] = [];
    let cell = '';
    for (let i = 0; i < row.length; i += 1) {
        const ch = row[i] as string;
        // An escaped pipe is text, and stays escaped for the inline scan.
        if (ch === '\\' && row[i + 1] === '|') {
            cell += '\\|';
            i += 1;
        } else if (ch === '|') {
            out.push(cell);
            cell = '';
        } else {
            cell += ch;
        }
    }
    out.push(cell);
    return out.slice(1, -1).map((c) => c.trim());
}

/**
 * The rows a table was written as, read into a grid.
 *
 * The rule row is not kept: what it said about alignment is kept instead, and
 * `gridOf` draws a rule of the width the columns turn out to be. A table
 * without one is still a table — models write them — it just has no header.
 */
function gatherTable(rows: string[]): Block {
    const grid = rows.map(cellsOf);
    const rule = grid[1];
    const ruled = rule !== undefined && rule.length > 0 && rule.every((c) => RULE_CELL.test(c));
    const body = ruled ? [grid[0] as string[], ...grid.slice(2)] : grid;
    const columns = Math.max(0, ...body.map((row) => row.length));
    return {
        kind: 'table',
        cells: body.map((row) => Array.from({ length: columns }, (_, i) => inlineOf(row[i] ?? ''))),
        ...(ruled
            ? {
                  align: Array.from({ length: columns }, (_, i): Align =>
                      (rule[i] ?? '').endsWith(':')
                          ? (rule[i] as string).startsWith(':')
                              ? 'center'
                              : 'right'
                          : 'left',
                  ),
              }
            : {}),
    };
}

/** Takes back up to `by` columns of indent, and no more than the line has. */
function dedent(line: string, by: number): string {
    let n = 0;
    while (n < by && (line[n] === ' ' || line[n] === '\t')) {
        n += 1;
    }
    return line.slice(n);
}

/**
 * An answer, as the blocks it is made of.
 *
 * Read top down, one line at a time, because that is the order the text
 * arrives in and a stream must be readable before it is finished. The two
 * verbatim kinds win over everything: a pipe inside a fence is whatever the
 * code says it is, and a `#` inside one is a comment, not a heading.
 */
export function blocksOf(text: string): Block[] {
    const out: Block[] = [];
    let prose: { kind: BlockKind; level?: number; marker?: string; lines: string[] } | undefined;
    let fence: { marker: string; indent: number; title?: string; lines: string[] } | undefined;
    let table: string[] | undefined;

    const closeProse = (): void => {
        if (prose) {
            out.push({
                kind: prose.kind,
                ...(prose.level === undefined ? {} : { level: prose.level }),
                ...(prose.marker === undefined ? {} : { marker: prose.marker }),
                spans: inlineOf(prose.lines.join('\n').trim()),
            });
            prose = undefined;
        }
    };
    const closeTable = (): void => {
        if (table) {
            out.push(gatherTable(table));
            table = undefined;
        }
    };
    const closeFence = (): void => {
        if (fence) {
            out.push({
                kind: 'code',
                ...(fence.title ? { title: fence.title } : {}),
                lines: fence.lines,
            });
            fence = undefined;
        }
    };
    const settle = (): void => {
        closeProse();
        closeTable();
    };

    for (const raw of text.split('\n')) {
        if (fence) {
            if (raw.trimStart().startsWith(fence.marker)) {
                closeFence();
            } else {
                fence.lines.push(dedent(raw, fence.indent));
            }
            continue;
        }

        const opening = FENCE.exec(raw);
        if (opening) {
            settle();
            fence = {
                marker: (opening[2] as string).slice(0, 3),
                indent: (opening[1] as string).length,
                ...(opening[3] ? { title: opening[3] } : {}),
                lines: [],
            };
            continue;
        }

        // A blank line ends whatever was being gathered and is not itself a block.
        if (!raw.trim()) {
            settle();
            continue;
        }

        if (TABLE_ROW.test(raw)) {
            closeProse();
            (table ??= []).push(raw.trim());
            continue;
        }
        closeTable();

        const heading = HEADING.exec(raw);
        if (heading) {
            closeProse();
            out.push({
                kind: 'heading',
                level: (heading[1] as string).length,
                spans: inlineOf(heading[2] as string),
            });
            continue;
        }

        // Before the item check, so `* * *` is a rule and not a list of one star.
        if (RULE.test(raw)) {
            closeProse();
            out.push({ kind: 'rule' });
            continue;
        }

        const quote = QUOTE.exec(raw);
        if (quote) {
            if (prose?.kind !== 'quote') {
                closeProse();
                prose = { kind: 'quote', lines: [] };
            }
            prose.lines.push(quote[1] as string);
            continue;
        }

        const item = ITEM.exec(raw);
        if (item) {
            closeProse();
            const level = Math.min(BULLETS.length - 1, Math.floor((item[1] as string).length / 2));
            const number = item[3];
            prose = {
                kind: 'item',
                level,
                marker: number ? `${number}.` : (BULLETS[level] as string),
                lines: [item[4] as string],
            };
            continue;
        }

        // A line under an item belongs to it; a line under nothing starts a paragraph.
        if (prose) {
            prose.lines.push(raw.trim());
        } else {
            prose = { kind: 'paragraph', lines: [raw] };
        }
    }

    settle();
    closeFence();
    return out;
}

// ---------------------------------------------------------------------------
// Back to text
// ---------------------------------------------------------------------------

/** What a run of spans measures, which is the text and never the styling. */
const lengthOf = (spans: Span[]): number => spans.reduce((n, s) => n + columnsOf(s.text), 0);

/** A cell in its column, set where the rule row asked for it. */
function padOf(spans: Span[], width: number, align: Align): Span[] {
    const slack = Math.max(0, width - lengthOf(spans));
    const lead = align === 'right' ? slack : align === 'center' ? Math.floor(slack / 2) : 0;
    return [
        ...(lead > 0 ? [{ text: ' '.repeat(lead) }] : []),
        ...spans,
        ...(slack > lead ? [{ text: ' '.repeat(slack - lead) }] : []),
    ];
}

/**
 * A table as its rows, each one a single run of spans.
 *
 * Columns are laid out here and nowhere else, so the drawn table and the plain
 * one are the same table: a cell's width is the columns its text takes, which is
 * what a `Span` measures whatever styling rides beside it. Nothing a model
 * writes in a cell can move the cell after it.
 */
export function gridOf(block: Block): Span[][] {
    const cells = block.cells ?? [];
    const count = Math.max(0, ...cells.map((row) => row.length));
    if (count === 0) {
        return [];
    }
    const widths = Array.from({ length: count }, (_, i) =>
        Math.max(3, ...cells.map((row) => lengthOf(row[i] ?? []))),
    );
    const rows = cells.map((row) => {
        const out: Span[] = [];
        widths.forEach((width, i) => {
            out.push({ text: i === 0 ? '| ' : ' | ' });
            out.push(...padOf(row[i] ?? [], width, block.align?.[i] ?? 'left'));
        });
        out.push({ text: ' |' });
        return out;
    });
    if (block.align && rows.length > 0) {
        rows.splice(1, 0, [{ text: `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|` }]);
    }
    return rows;
}

/**
 * A block as the row or rows it reads as, with its markers resolved rather
 * than shown, and nothing styled.
 *
 * This is what a sink that cannot style gets — the pre-answer stream, and the
 * plain box `zen meta` draws — so that the text does not visibly change shape
 * at the moment it settles.
 */
export function textOf(block: Block, width = 0): string {
    if (block.kind === 'code') {
        // The same chrome the settled answer draws, so a fence that is still
        // arriving is already the shape it will end up as.
        return [
            `\u250c\u2500${block.title ? ` ${block.title}` : ''}`,
            ...(block.lines ?? []).map((l) => `\u2502 ${l}`),
            '\u2514\u2500',
        ].join('\n');
    }
    if (block.lines) {
        return block.lines.join('\n');
    }
    if (block.kind === 'table') {
        return gridOf(block)
            .map((row) => row.map((s) => s.text).join(''))
            .join('\n');
    }
    if (block.kind === 'rule') {
        return '\u2500'.repeat(Math.max(3, width));
    }
    const body = (block.spans ?? []).map((s) => s.text).join('');
    if (block.kind === 'item') {
        return `${'  '.repeat(block.level ?? 0)}${block.marker ?? BULLETS[0]} ${body}`;
    }
    if (block.kind === 'quote') {
        return `\u2502 ${body}`;
    }
    return body;
}

/** A whole answer with its markup resolved instead of shown. Still plain text. */
export function unmarked(text: string, width = 0): string {
    const rows: string[] = [];
    let previous: Block | undefined;
    for (const block of blocksOf(text)) {
        // Items of one list are one thing; a blank row between them is two lists.
        if (previous && !(block.kind === 'item' && previous.kind === 'item')) {
            rows.push('');
        }
        rows.push(textOf(block, width));
        previous = block;
    }
    return rows.join('\n');
}
