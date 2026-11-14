// ---------------------------------------------------------------------------
// Oracles for generated data.
//
// A generated search has no fixed body to assert, so these check relations
// between answers instead. Everything here is pure or takes an injected
// fetcher, so `oracles.test.ts` can prove each oracle *fails* on bad input
// without a server or a model: an oracle that cannot fail proves nothing.
// ---------------------------------------------------------------------------

export interface Verdict {
    ok: boolean;
    /** true when the relation held only because there was nothing to check */
    vacuous: boolean;
    detail: string;
}

const pass = (detail: string, vacuous = false): Verdict => ({ ok: true, vacuous, detail });
const fail = (detail: string): Verdict => ({ ok: false, vacuous: false, detail });

const preview = (xs: readonly string[], n = 5): string =>
    xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} … (+${xs.length - n} more)`;

// --- HTTP ------------------------------------------------------------------

export type Json = Record<string, unknown>;
export type FetchJson = (url: string, init?: RequestInit) => Promise<Json>;

/** GET/POST returning parsed JSON; a non-2xx answer throws with the body, so it is never mistaken for data. */
export const fetchJson: FetchJson = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    try {
        return JSON.parse(text) as Json;
    } catch {
        throw new Error(`${url} -> ${res.status} but body is not JSON: ${text.slice(0, 300)}`);
    }
};

export function withQuery(base: string, query: Record<string, string | number | undefined>) {
    const url = new URL(base);
    for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    return url.toString();
}

// --- Paging ------------------------------------------------------------------

export type StopReason = 'end' | 'repeated-token' | 'seen-token' | 'page-cap';

export interface Walk<T> {
    items: T[];
    pages: number;
    tokens: string[];
    stop: StopReason;
}

/**
 * Follow `nextPageToken` until it stops, and say why it stopped. Never hangs:
 * a token equal to the one just sent, a token seen earlier, or `maxPages`
 * each end the walk with their own reason.
 */
export async function walk<T = Json>(
    url: string,
    itemsKey: string,
    opts: { maxPages?: number; fetch?: FetchJson } = {},
): Promise<Walk<T>> {
    const get = opts.fetch ?? fetchJson;
    const maxPages = opts.maxPages ?? 50;
    const items: T[] = [];
    const tokens: string[] = [];
    const seen = new Set<string>();
    let sent: string | undefined;

    for (let page = 1; ; page++) {
        const body = await get(sent === undefined ? url : withQuery(url, { pageToken: sent }));
        const pageItems = body[itemsKey];
        if (pageItems !== undefined && !Array.isArray(pageItems)) {
            throw new Error(`${url}: "${itemsKey}" is ${typeof pageItems}, not an array`);
        }
        items.push(...((pageItems as T[] | undefined) ?? []));

        const next = body.nextPageToken;
        if (next === undefined || next === null || next === '') {
            return { items, pages: page, tokens, stop: 'end' };
        }
        const token = String(next);
        tokens.push(token);
        if (token === sent) return { items, pages: page, tokens, stop: 'repeated-token' };
        if (seen.has(token)) return { items, pages: page, tokens, stop: 'seen-token' };
        if (page >= maxPages) return { items, pages: page, tokens, stop: 'page-cap' };
        seen.add(token);
        sent = token;
    }
}

// --- Relations -----------------------------------------------------------------

const idsOf = (items: readonly unknown[]): string[] =>
    items.map((x) => String((x as { id?: unknown }).id));

/** R1: `maxResults=n` returns at most n items. */
export function atMost(items: readonly unknown[], n: number): Verdict {
    if (items.length > n) {
        return fail(`asked for at most ${n}, got ${items.length}: ${preview(idsOf(items))}`);
    }
    return pass(`${items.length} <= ${n}`, items.length === 0);
}

/** R2: adding a clause to q never grows the result set — narrow must be a subset of broad. */
export function notGrowing(broad: readonly unknown[], narrow: readonly unknown[]): Verdict {
    const b = new Set(idsOf(broad));
    const extra = idsOf(narrow).filter((id) => !b.has(id));
    if (extra.length > 0) {
        return fail(
            `narrower query returned ${extra.length} id(s) the broader one did not: ${preview(extra)}` +
                ` (broad=${b.size}, narrow=${narrow.length})`,
        );
    }
    return pass(`narrow ${narrow.length} ⊆ broad ${b.size}`, narrow.length === 0);
}

/** R3: the union of all pages equals the single uncapped page. */
export function sameSet(paged: readonly unknown[], whole: readonly unknown[]): Verdict {
    const p = new Set(idsOf(paged));
    const w = new Set(idsOf(whole));
    const missing = [...w].filter((id) => !p.has(id));
    const extra = [...p].filter((id) => !w.has(id));
    const dupes = paged.length - p.size;
    if (missing.length || extra.length || dupes) {
        return fail(
            [
                missing.length ? `missing from pages: ${preview(missing)}` : '',
                extra.length ? `only in pages: ${preview(extra)}` : '',
                dupes ? `${dupes} id(s) repeated across pages` : '',
            ]
                .filter(Boolean)
                .join('; ') + ` (paged=${p.size}, whole=${w.size})`,
        );
    }
    return pass(`${p.size} ids on both sides`, w.size === 0);
}

interface EventLike {
    id?: unknown;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
}

/**
 * R4: every event overlaps the window. The spec: timeMin bounds an event's END
 * (exclusive), timeMax bounds its START (exclusive) — so end > timeMin and start < timeMax.
 */
export function overlapsWindow(
    events: readonly unknown[],
    timeMin: string,
    timeMax: string,
): Verdict {
    const lo = Date.parse(timeMin);
    const hi = Date.parse(timeMax);
    const bad: string[] = [];
    for (const raw of events) {
        const e = raw as EventLike;
        const s = Date.parse(e.start?.dateTime ?? '');
        const en = Date.parse(e.end?.dateTime ?? '');
        if (Number.isNaN(s) || Number.isNaN(en)) {
            bad.push(`${String(e.id)} (unparseable start/end)`);
        } else if (!(en > lo && s < hi)) {
            bad.push(`${String(e.id)} [${e.start?.dateTime} – ${e.end?.dateTime}]`);
        }
    }
    if (bad.length) {
        return fail(
            `${bad.length}/${events.length} event(s) outside [${timeMin}, ${timeMax}): ${preview(bad, 3)}`,
        );
    }
    return pass(`${events.length} event(s) inside the window`, events.length === 0);
}

/** R5: freeBusy.calendars contains exactly the ids asked about — no more, no fewer. */
export function exactKeys(calendars: unknown, asked: readonly string[]): Verdict {
    if (calendars === null || typeof calendars !== 'object' || Array.isArray(calendars)) {
        return fail(`calendars is not an object: ${JSON.stringify(calendars)?.slice(0, 100)}`);
    }
    const got = Object.keys(calendars);
    const want = new Set(asked);
    const missing = [...want].filter((id) => !got.includes(id));
    const extra = got.filter((id) => !want.has(id));
    if (missing.length || extra.length) {
        return fail(
            [
                missing.length ? `missing: ${preview(missing)}` : '',
                extra.length ? `not asked for: ${preview(extra)}` : '',
            ]
                .filter(Boolean)
                .join('; '),
        );
    }
    return pass(`keys = {${got.join(', ')}}`);
}

// --- Settings ----------------------------------------------------------------

/**
 * A positive whole number from an environment variable, or the fallback when it
 * is unset. Anything else throws: `ORACLE_REPEATS=0` would otherwise run every
 * case zero times and pass with an empty report.
 */
export function positiveInt(name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(n) || n < 1) {
        throw new Error(`${name} must be a positive integer, got "${raw}"`);
    }
    return n;
}

// --- Report ------------------------------------------------------------------

/** One markdown table cell: pipes escaped, line breaks flattened, so a row never splits. */
export const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export interface Trial {
    relation: string;
    case: string;
    run: number;
    verdict: Verdict;
}

export function report(trials: readonly Trial[], meta: Record<string, string>): string {
    const byRelation = new Map<string, Trial[]>();
    for (const t of trials) {
        byRelation.set(t.relation, [...(byRelation.get(t.relation) ?? []), t]);
    }
    const lines = [
        '# Oracle run',
        '',
        ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
        '',
        '| Relation | Trials | Passed | Pass rate | Vacuous | First failure |',
        '| --- | ---: | ---: | ---: | ---: | --- |',
    ];
    for (const [relation, ts] of byRelation) {
        const passed = ts.filter((t) => t.verdict.ok).length;
        const vacuous = ts.filter((t) => t.verdict.vacuous).length;
        const first = ts.find((t) => !t.verdict.ok);
        const rate = ts.length ? `${Math.round((100 * passed) / ts.length)}%` : '-';
        const failure = first
            ? `\`${cell(first.case)}\` #${first.run}: ${cell(first.verdict.detail)}`
            : '';
        lines.push(
            `| ${relation} | ${ts.length} | ${passed} | ${rate} | ${vacuous} | ${failure} |`,
        );
    }
    lines.push('', '## Every trial', '', '| Relation | Case | Run | Result | Detail |');
    lines.push('| --- | --- | ---: | --- | --- |');
    for (const t of trials) {
        const result = t.verdict.ok ? (t.verdict.vacuous ? 'pass (vacuous)' : 'pass') : 'FAIL';
        lines.push(
            `| ${t.relation} | \`${cell(t.case)}\` | ${t.run} | ${result} | ${cell(t.verdict.detail)} |`,
        );
    }
    return lines.join('\n') + '\n';
}
