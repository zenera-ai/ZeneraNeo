// ---------------------------------------------------------------------------
// zen models browse
//
// The catalog as something to walk rather than something to grep: providers,
// then what one of them serves, then one model in full — with a key to ask it
// a real question and a key to take it.
//
// Drawn on STDERR, like the banner and every other piece of narration, so the
// one thing that reaches stdout is the ref picked at the end. That is what
// makes `ref=$(zen models browse)` work: the person sees the interface, the
// shell sees the answer.
//
// Nothing here knows how to list or probe a model. Both arrive as callbacks
// from commands/models.ts, which already owns credentials and the catalog, so
// this file is layout and keys and nothing else.
// ---------------------------------------------------------------------------

import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import stringWidth from 'string-width';

import type { Provider } from '@zenera/engine';
import {
    byGroup,
    isPartner,
    matches,
    perMillion,
    type Balance,
    type Catalog,
    type CatalogEntry,
    type Role,
} from '../catalog.ts';
import { ago } from '../term.ts';
import { resolveTheme, type Theme } from './theme.ts';
import { clip, padEndCols, padStartCols, scrollTop, wrap } from './wrap.ts';

export interface ProviderRow {
    provider: Provider;
    /** where its credential came from — `environment`, `keyring` — or '' for none */
    credential: string;
    /** what the cached listing holds, read without asking anyone */
    models: number;
    origin: Catalog['origin'];
    fetchedAt: string;
}

/** What asking a model one question found out. */
export interface Verdict {
    state: 'live' | 'dead' | 'blocked' | 'unknown';
    ms?: number;
    detail?: string;
    fix?: string;
    dimensions?: number;
}

export interface BrowseOptions {
    providers: readonly ProviderRow[];
    /** opens straight into this provider's listing */
    initial?: Provider;
    /** the role filter a listing opens on, when it has any such model */
    role?: Role;
    theme?: string;
    /** set in a gateway mode: every listing and test goes through it */
    gateway?: { name: string; url: string };
    load(provider: Provider, refresh: boolean): Promise<Catalog>;
    /** what the account has left to spend, for providers that say */
    balance?(provider: Provider): Promise<Balance | undefined>;
    test(entry: CatalogEntry): Promise<Verdict>;
}

type Screen = 'providers' | 'models' | 'detail';

const ROLES: readonly Role[] = ['chat', 'embedding', 'image', 'audio'];

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const thousands = (n: number | undefined): string =>
    n === undefined ? '' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

const ms = (n: number): string => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

const money = (n: number): string => {
    const abs = Math.abs(n);
    return `${n < 0 ? '-' : ''}$${abs !== 0 && abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2)}`;
};

/** The balance as one line; `short` for the providers screen. */
function account(b: Balance, short: boolean): string {
    const parts: string[] = [];
    if (b.credits !== undefined) {
        parts.push(`balance ${money(b.credits)}`);
    }
    if (b.cap && !short) {
        const reset = b.cap.reset ? ` ${b.cap.reset}` : '';
        parts.push(`key cap ${money(b.cap.remaining)} left of ${money(b.cap.limit)}${reset}`);
    }
    if (b.free && !short) {
        parts.push(`free ${b.free.remaining}/${b.free.limit} requests left today`);
    }
    return parts.join(' · ');
}

function freshness(origin: Catalog['origin'], fetchedAt: string, via?: unknown): string {
    switch (origin) {
        case 'curated':
            return via ? 'not listed yet' : 'built-in list';
        case 'stale':
            return `stale, ${ago(fetchedAt)}`;
        case 'live':
            return 'fetched now';
        default:
            return `cached ${ago(fetchedAt)}`;
    }
}

interface Said {
    text: string;
    color?: string;
}

function said(verdict: Verdict | 'asking' | undefined, theme: Theme): Said | undefined {
    if (verdict === undefined) {
        return undefined;
    }
    if (verdict === 'asking') {
        return { text: '… asking', color: theme.warn };
    }
    switch (verdict.state) {
        case 'live':
            return {
                text: `✓ answers ${verdict.ms === undefined ? '' : ms(verdict.ms)}`.trim(),
                color: theme.code.color,
            };
        case 'blocked':
            return { text: '! blocked', color: theme.warn };
        case 'dead':
            return { text: '✗ refused', color: theme.line.error.color };
        default:
            return { text: '? no answer', color: theme.chrome.color };
    }
}

/** One row, never wrapped: a wrapped row is a row the frame did not budget for. */
function Row({ children, ...style }: React.ComponentProps<typeof Text>): React.JSX.Element {
    return (
        <Text wrap="truncate-end" {...style}>
            {children}
        </Text>
    );
}

function Keys({ theme, text }: { theme: Theme; text: string }): React.JSX.Element {
    return <Row color={theme.chrome.color}>{text}</Row>;
}

/** Rides on each screen's title row, so it costs the frame no height. */
function Via({
    gateway,
    theme,
}: {
    gateway: BrowseOptions['gateway'];
    theme: Theme;
}): React.JSX.Element | null {
    if (!gateway) {
        return null;
    }
    return (
        <>
            <Text>{'   '}</Text>
            <Text inverse bold color={theme.warn}>{` ⇄ ${gateway.name} `}</Text>
            <Text color={theme.chrome.color}>{` ${gateway.url}`}</Text>
        </>
    );
}

const CTX_W = 9;
const PRICE_W = 10;

/** The model listing's rendered row, shared with deterministic layout tests. */
export function ModelTableRow({
    entry: e,
    here,
    verdict,
    theme,
    idW,
    roleWidth,
    withMaker,
    priced,
}: {
    entry: CatalogEntry;
    here: boolean;
    verdict: Verdict | 'asking' | undefined;
    theme: Theme;
    idW: number;
    roleWidth: number;
    withMaker: boolean;
    priced: boolean;
}): React.JSX.Element {
    const v = said(verdict, theme);
    return (
        <Row>
            <Text color={here ? theme.accent : undefined} bold={here}>
                {here ? '› ' : '  '}
                {padEndCols(clip(e.id, idW - 2), idW)}
            </Text>
            {withMaker ? (
                <Text color={isPartner(e) ? theme.warn : theme.code.color}>
                    {padEndCols(clip(e.publisher ?? '', 11), 12)}
                </Text>
            ) : null}
            <Text color={theme.chrome.color}>
                {padEndCols(e.roles.join('+'), roleWidth)}
                {padEndCols(padStartCols(thousands(e.contextLength), CTX_W - 2), CTX_W)}
            </Text>
            {priced ? (
                <Text color={e.pricing?.free ? theme.code.color : undefined}>
                    {padEndCols(padStartCols(perMillion(e.pricing?.prompt), PRICE_W - 2), PRICE_W)}
                    {padEndCols(
                        padStartCols(
                            e.pricing?.free ? '' : perMillion(e.pricing?.completion),
                            PRICE_W - 2,
                        ),
                        PRICE_W,
                    )}
                </Text>
            ) : null}
            {v ? <Text color={v.color}>{v.text}</Text> : null}
        </Row>
    );
}

interface BrowserProps {
    options: BrowseOptions;
    theme: Theme;
    onPick(entry: CatalogEntry): void;
}

function Browser({ options, theme, onPick }: BrowserProps): React.JSX.Element | null {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    useEffect(() => {
        const resized = (): void =>
            setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
        stdout.on('resize', resized);
        return () => {
            stdout.off('resize', resized);
        };
    }, [stdout]);

    const start = options.providers.findIndex((p) => p.provider === options.initial);
    const [screen, setScreen] = useState<Screen>(start >= 0 ? 'models' : 'providers');
    const [at, setAt] = useState(Math.max(0, start));
    const [catalogs, setCatalogs] = useState<ReadonlyMap<Provider, Catalog>>(new Map());
    const [loading, setLoading] = useState<Provider>();
    const [failure, setFailure] = useState<string>();
    const [query, setQuery] = useState('');
    const [typing, setTyping] = useState(false);
    const [role, setRole] = useState<Role | undefined>(options.role);
    const [selected, setSelected] = useState(0);
    const [verdicts, setVerdicts] = useState<ReadonlyMap<string, Verdict | 'asking'>>(new Map());
    const [balances, setBalances] = useState<ReadonlyMap<Provider, Balance | string>>(new Map());
    const [closing, setClosing] = useState(false);
    const top = useRef(0);

    const provider = options.providers[at]!.provider;
    const catalog = catalogs.get(provider);

    const load = (p: Provider, refresh: boolean): void => {
        setLoading(p);
        setFailure(undefined);
        options.load(p, refresh).then(
            (cat) => {
                setCatalogs((prev) => new Map(prev).set(p, cat));
                setLoading((now) => (now === p ? undefined : now));
            },
            (err: unknown) => {
                setFailure(message(err));
                setLoading((now) => (now === p ? undefined : now));
            },
        );
    };

    const fetchBalance = (p: Provider): void => {
        options.balance?.(p).then(
            (b) => b && setBalances((prev) => new Map(prev).set(p, b)),
            (err: unknown) => setBalances((prev) => new Map(prev).set(p, message(err))),
        );
    };

    useEffect(() => {
        if (start >= 0) {
            load(provider, false);
        }
        for (const p of options.providers) {
            if (p.credential) {
                fetchBalance(p.provider);
            }
        }
        // Once, for `zen models browse <provider>`; every later open is a key.
    }, []);

    useEffect(() => {
        if (closing) {
            exit();
        }
    }, [closing, exit]);

    // Only the roles this listing actually has: cycling through `audio` on a
    // provider with no audio models is a keypress spent on an empty screen.
    const present = useMemo(
        () => [
            undefined,
            ...ROLES.filter((r) => catalog?.entries.some((e) => e.roles.includes(r))),
        ],
        [catalog],
    );
    const only = present.includes(role) ? role : undefined;
    const rows = useMemo(
        () =>
            (catalog?.entries ?? [])
                .filter((e) => matches(e, query, { roles: only ? [only] : [] }))
                .sort(byGroup),
        [catalog, query, only],
    );
    const index = Math.min(selected, Math.max(0, rows.length - 1));
    const current = rows[index];

    const open = (next: number): void => {
        const p = options.providers[next]!.provider;
        setAt(next);
        setScreen('models');
        setQuery('');
        setTyping(false);
        setRole(options.role);
        setSelected(0);
        top.current = 0;
        if (!catalogs.has(p)) {
            load(p, false);
        }
    };

    const ask = (entry: CatalogEntry): void => {
        if (verdicts.get(entry.ref) === 'asking') {
            return;
        }
        setVerdicts((prev) => new Map(prev).set(entry.ref, 'asking'));
        options.test(entry).then(
            (v) => setVerdicts((prev) => new Map(prev).set(entry.ref, v)),
            (err: unknown) =>
                setVerdicts((prev) =>
                    new Map(prev).set(entry.ref, { state: 'unknown', detail: message(err) }),
                ),
        );
    };

    const pick = (entry: CatalogEntry): void => {
        onPick(entry);
        setClosing(true);
    };

    // Everything but the list is a fixed number of rows, and the list gets
    // what is left. A row is kept in hand: a frame as tall as the viewport is
    // the one Ink cannot erase (see tui/app.tsx).
    const problem = catalog?.problem;
    const balance = balances.get(provider);
    const funds =
        balance === undefined
            ? []
            : wrap(
                  typeof balance === 'string'
                      ? `balance could not be read: ${balance}`
                      : account(balance, false) || 'balance: nothing reported',
                  Math.max(20, size.columns - 1),
              );
    const short =
        typeof balance === 'string' || (balance?.credits !== undefined && balance.credits <= 0);
    const chrome = 7 + (problem ? 1 : 0) + funds.length;
    const height = Math.max(3, size.rows - 1 - chrome);
    top.current = scrollTop(index, top.current, height, rows.length);

    useInput((input, key) => {
        if (closing) {
            return;
        }
        const quit = (): void => setClosing(true);

        if (screen === 'providers') {
            const n = options.providers.length;
            if (key.upArrow || input === 'k') {
                setAt((i) => (i + n - 1) % n);
            } else if (key.downArrow || input === 'j') {
                setAt((i) => (i + 1) % n);
            } else if (key.return || key.rightArrow || input === 'l') {
                open(at);
            } else if (key.escape || input === 'q') {
                quit();
            }
            return;
        }

        if (screen === 'detail') {
            if (!current) {
                setScreen('models');
            } else if (input === 't') {
                ask(current);
            } else if (key.return || input === 'p') {
                pick(current);
            } else if (key.escape || key.leftArrow || input === 'h') {
                setScreen('models');
            } else if (input === 'q') {
                quit();
            }
            return;
        }

        const move = (by: number): void =>
            setSelected(Math.max(0, Math.min(rows.length - 1, index + by)));
        if (key.upArrow) {
            return move(-1);
        }
        if (key.downArrow) {
            return move(1);
        }
        if (key.pageUp) {
            return move(-height);
        }
        if (key.pageDown) {
            return move(height);
        }

        if (typing) {
            if (key.return) {
                setTyping(false);
            } else if (key.escape) {
                setQuery('');
                setTyping(false);
            } else if (key.backspace || key.delete) {
                setQuery((q) => q.slice(0, -1));
                setSelected(0);
            } else if (input && !key.ctrl && !key.meta && !key.tab) {
                // Fast typing or a paste can arrive as one chunk with the Enter
                // inside it: keep the text, honour the Enter, drop the rest.
                const [text = '', ...after] = input.split(/[\r\n]/);
                setQuery((q) => q + text.replace(/[\u0000-\u001f\u007f]/g, ''));
                setSelected(0);
                if (after.length > 0) {
                    setTyping(false);
                }
            }
            return;
        }

        if (input === 'k') {
            move(-1);
        } else if (input === 'j') {
            move(1);
        } else if (key.home || input === 'g') {
            setSelected(0);
        } else if (key.end || input === 'G') {
            setSelected(Math.max(0, rows.length - 1));
        } else if (input.startsWith('/')) {
            // A pasted `/gpt-5` arrives as one chunk, not as a slash and then
            // the rest.
            setTyping(true);
            setQuery(input.slice(1));
            setSelected(0);
        } else if (key.tab) {
            setRole(present[(present.indexOf(only) + 1) % present.length]);
            setSelected(0);
        } else if ((key.return || key.rightArrow || input === 'l') && current) {
            setScreen('detail');
        } else if (input === 't' && current) {
            ask(current);
        } else if (input === 'p' && current) {
            pick(current);
        } else if (input === 'r') {
            load(provider, true);
            fetchBalance(provider);
        } else if (key.escape && query) {
            setQuery('');
            setSelected(0);
        } else if (key.escape || key.leftArrow || input === 'h') {
            setScreen('providers');
        } else if (input === 'q') {
            quit();
        }
    });

    if (closing) {
        // An empty frame erases the last one, so the shell is left as it was
        // found rather than with a stale picture of a list on it.
        return null;
    }

    const width = Math.max(20, size.columns - 1);

    if (screen === 'providers') {
        const nameW = Math.max(...options.providers.map((p) => stringWidth(p.provider))) + 2;
        return (
            <Box flexDirection="column">
                <Row>
                    <Text bold color={theme.accent}>
                        Providers
                    </Text>
                    <Via gateway={options.gateway} theme={theme} />
                </Row>
                <Text> </Text>
                {options.providers.map((p, i) => {
                    const here = i === at;
                    const cat = catalogs.get(p.provider);
                    const count = cat?.entries.length ?? p.models;
                    const fresh = cat
                        ? freshness(cat.origin, cat.fetchedAt, cat.via)
                        : freshness(p.origin, p.fetchedAt, options.gateway);
                    const b = balances.get(p.provider);
                    return (
                        <Row key={p.provider}>
                            <Text color={here ? theme.accent : undefined} bold={here}>
                                {here ? '› ' : '  '}
                                {padEndCols(p.provider, nameW)}
                            </Text>
                            {p.credential ? (
                                <Text color={theme.code.color}>{padEndCols(p.credential, 15)}</Text>
                            ) : (
                                <Text color={theme.line.error.color}>
                                    {padEndCols('no credential', 15)}
                                </Text>
                            )}
                            <Text color={theme.chrome.color}>
                                {padEndCols(`${count} model${count === 1 ? '' : 's'}`, 13)}
                                {p.credential ? fresh : `zen key add ${p.provider}`}
                            </Text>
                            {b && typeof b !== 'string' ? (
                                <Text color={theme.code.color}>{`   ${account(b, true)}`}</Text>
                            ) : null}
                        </Row>
                    );
                })}
                <Text> </Text>
                <Keys theme={theme} text="↑↓ move · enter open · q quit" />
            </Box>
        );
    }

    if (screen === 'detail' && current) {
        return (
            <Detail
                entry={current}
                catalog={catalog}
                verdict={verdicts.get(current.ref)}
                gateway={options.gateway}
                theme={theme}
                width={width}
                rows={size.rows - 1}
            />
        );
    }

    const header = catalog
        ? `${provider} · ${catalog.entries.length} models · ${freshness(catalog.origin, catalog.fetchedAt, catalog.via)}`
        : provider;
    const withMaker = rows.some((e) => e.publisher);
    const priced = rows.some((e) => e.pricing);
    const ROLE_W = Math.max(4, ...rows.map((e) => stringWidth(e.roles.join('+')))) + 2;
    const fixed =
        (withMaker ? 12 : 0) +
        ROLE_W +
        CTX_W +
        (priced ? PRICE_W * 2 : 0) +
        stringWidth('test') +
        2;
    const idW = Math.max(
        10,
        Math.min(46, Math.max(8, ...rows.map((e) => stringWidth(e.id))) + 2, width - fixed),
    );
    const shown = rows.slice(top.current, top.current + height);
    const filter = typing ? `/${query}▌` : query ? `/${query}` : '';
    const columns = [
        `  ${padEndCols('model', idW)}`,
        withMaker ? padEndCols('maker', 12) : '',
        padEndCols('role', ROLE_W),
        padEndCols(padStartCols('context', CTX_W - 2), CTX_W),
        priced ? padEndCols(padStartCols('in $/1M', PRICE_W - 2), PRICE_W) : '',
        priced ? padEndCols(padStartCols('out $/1M', PRICE_W - 2), PRICE_W) : '',
        'test',
    ].join('');

    let body: React.JSX.Element;
    if (failure) {
        body = <Row color={theme.line.error.color}>{failure}</Row>;
    } else if (loading === provider || !catalog) {
        body = <Row color={theme.warn}>listing {provider} …</Row>;
    } else if (rows.length === 0) {
        body = (
            <Row color={theme.chrome.color}>
                {query ? `nothing matches "${query}"` : 'nothing listed'}
            </Row>
        );
    } else {
        body = (
            <>
                {shown.map((e, i) => {
                    const here = top.current + i === index;
                    return (
                        <ModelTableRow
                            key={e.ref}
                            entry={e}
                            here={here}
                            verdict={verdicts.get(e.ref)}
                            theme={theme}
                            idW={idW}
                            roleWidth={ROLE_W}
                            withMaker={withMaker}
                            priced={priced}
                        />
                    );
                })}
            </>
        );
    }

    const preview = current ? [current.name, current.description].filter(Boolean).join(' — ') : '';

    return (
        <Box flexDirection="column">
            <Row>
                <Text bold color={theme.accent}>
                    {header}
                </Text>
                <Text color={theme.chrome.color}>
                    {'   role: '}
                    {only ?? 'all'}
                    {filter ? '   ' : ''}
                </Text>
                <Text color={theme.code.color}>{filter}</Text>
                <Via gateway={options.gateway} theme={theme} />
            </Row>
            {problem ? (
                <Row color={theme.warn}>
                    could not be listed: {problem.detail ?? 'no reason given'}
                </Row>
            ) : null}
            {funds.map((line, i) => (
                <Row key={`funds${i}`} color={short ? theme.warn : theme.code.color}>
                    {line}
                </Row>
            ))}
            <Text> </Text>
            <Row bold color={theme.chrome.color}>
                {columns}
            </Row>
            <Box flexDirection="column" height={height}>
                {body}
            </Box>
            <Row color={theme.chrome.color}>{clip(preview, width) || ' '}</Row>
            <Row color={theme.chrome.color}>
                {rows.length === 0
                    ? ' '
                    : `${index + 1} of ${rows.length}${rows.length < (catalog?.entries.length ?? 0) ? ` (${catalog!.entries.length} in all)` : ''}`}
            </Row>
            <Keys
                theme={theme}
                text={
                    typing
                        ? 'type to filter · enter keep · esc clear · ↑↓ move'
                        : '↑↓ · / filter · tab role · ⏎ more · t test · p pick · r reload · esc back'
                }
            />
        </Box>
    );
}

interface DetailProps {
    entry: CatalogEntry;
    catalog: Catalog | undefined;
    verdict: Verdict | 'asking' | undefined;
    gateway: BrowseOptions['gateway'];
    theme: Theme;
    width: number;
    rows: number;
}

function Detail({
    entry,
    catalog,
    verdict,
    gateway,
    theme,
    width,
    rows,
}: DetailProps): React.JSX.Element {
    const facts: [string, string][] = [];
    const add = (label: string, value: string | undefined): void => {
        if (value) {
            facts.push([label, value]);
        }
    };
    add('name', entry.name);
    add('roles', entry.roles.join(', '));
    add(
        'context',
        entry.contextLength ? `${entry.contextLength.toLocaleString()} tokens` : undefined,
    );
    add(
        'max output',
        entry.maxOutputTokens ? `${entry.maxOutputTokens.toLocaleString()} tokens` : undefined,
    );
    add('dimensions', entry.dimensions ? String(entry.dimensions) : undefined);
    add('input', entry.modalities?.input?.join(', '));
    add('output', entry.modalities?.output?.join(', '));
    add(
        'supports',
        Object.entries(entry.supports ?? {})
            .filter(([, on]) => on)
            .map(([k]) => k)
            .join(', '),
    );
    add(
        'pricing',
        entry.pricing?.free
            ? 'free'
            : entry.pricing?.prompt
              ? `${perMillion(entry.pricing.prompt)} per 1M input tokens, ${perMillion(entry.pricing.completion) || '?'} per 1M output tokens`
              : undefined,
    );
    add('released', entry.created);
    add(
        'source',
        entry.source === 'live' && catalog
            ? `${catalog.via ? `${catalog.via.name} (${entry.provider})` : entry.provider}, ${freshness(catalog.origin, catalog.fetchedAt, catalog.via)}`
            : 'built-in list',
    );

    const v = said(verdict, theme);
    const reason =
        verdict && verdict !== 'asking'
            ? [
                  verdict.dimensions ? `${verdict.dimensions} dims` : '',
                  verdict.state === 'live' ? '' : (verdict.detail ?? ''),
                  verdict.fix ? `fix: ${verdict.fix}` : '',
              ]
                  .filter(Boolean)
                  .join(' · ')
            : '';

    // Header, blank, facts, the verdict row, blank, keys — the description has
    // whatever is left, and is cut rather than allowed to push the keys off.
    const room = Math.max(0, rows - facts.length - 6);
    const about = entry.description ? wrap(entry.description, width - 2).slice(0, room) : [];

    return (
        <Box flexDirection="column">
            <Row>
                <Text bold color={theme.accent}>
                    {entry.ref}
                </Text>
                <Via gateway={gateway} theme={theme} />
            </Row>
            <Text> </Text>
            {facts.map(([label, value]) => (
                <Row key={label}>
                    <Text color={theme.chrome.color}>{`  ${padEndCols(label, 12)}`}</Text>
                    <Text>{value}</Text>
                </Row>
            ))}
            <Row>
                <Text color={theme.chrome.color}>
                    {'  '}
                    {padEndCols('asked', 12)}
                </Text>
                {v ? (
                    <Text color={v.color}>{v.text}</Text>
                ) : (
                    <Text color={theme.chrome.color}>not yet — t to ask it one question</Text>
                )}
                {reason ? <Text color={v?.color}>{`  ${reason}`}</Text> : null}
            </Row>
            {about.length > 0 ? <Text> </Text> : null}
            {about.map((line, i) => (
                <Row key={i} color={theme.chrome.color}>
                    {`  ${line}`}
                </Row>
            ))}
            <Text> </Text>
            <Keys theme={theme} text="t test · p pick (prints the ref) · esc back · q quit" />
        </Box>
    );
}

/**
 * Runs the browser until the person picks a model or leaves. Resolves to the
 * picked entry, or undefined when nothing was picked.
 */
export async function browse(options: BrowseOptions): Promise<CatalogEntry | undefined> {
    // Asked before Ink takes the terminal, as tui/app.tsx does.
    const theme = await resolveTheme(options.theme);
    let chosen: CatalogEntry | undefined;
    const instance = render(
        <Browser
            options={options}
            theme={theme}
            onPick={(entry) => {
                chosen = entry;
            }}
        />,
        { stdout: process.stderr },
    );
    await instance.waitUntilExit();
    return chosen;
}
