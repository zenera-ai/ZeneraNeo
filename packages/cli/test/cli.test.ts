import {
    ambient,
    assertUsable,
    auditModels,
    checkRegion,
    credentialFor,
    credentials,
    dirSize,
    envNames,
    envOf,
    isStamp,
    KeyStore,
    lastUsedAt,
    loadProjectEnv,
    mask,
    parseRef,
    projectMounts,
    readProjectEnv,
    sessionPaths,
    stamp,
    stampInstant,
    type KeyEntry,
    type Provider,
} from '@zenera/engine';
import type {
    Embedder,
    EmbeddingRequest,
    Model,
    ModelRequest,
    ProcResult,
    runProcess,
} from '@zenera/neo';
import { MEMORY_MOUNT, readProjectConfig } from '@zenera/neo';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extract, split } from '../src/args.ts';
import { bannerLines, NEO_BANNER } from '../src/banner.ts';
import { Cache, cacheKey } from '../src/cache.ts';
import {
    byGroup,
    CATALOG_KIND,
    CATALOG_TTL_MS,
    catalogKey,
    CURATED,
    fetchCatalog,
    groupOf,
    loadCatalog,
    loadCatalogs,
    matches,
    perMillion,
    sampleByProvider,
    type CatalogEntry,
} from '../src/catalog.ts';
import { COMMANDS, EXTERNAL, type External } from '../src/commands/index.ts';
import { cliManifest, versionOf } from '../src/commands/version.ts';
import { hasExternal, loadExternal } from '../src/external.ts';
import { History, historyPath, MAX_ENTRIES } from '../src/history.ts';
import { classify, probe, probeChat, probeModels } from '../src/liveness.ts';
import {
    absorb,
    answerBox,
    chooseModel,
    defaultRef,
    footerCells,
    gatewayDefaultRef,
    masked,
    metaCompatible,
    misspelledProvider,
    editorFiles,
    listPrompts,
    promptPath,
    readPrompt,
    readSpan,
    resumeDelayMs,
    sameModel,
    sessionModel,
    shutdownModels,
    splitLines,
    startRelay,
    Tally,
    toneAt,
    transient,
    wire,
    wireApi,
    wireGateway,
    type Outcome,
    type Sink,
} from '../src/meta/index.ts';
import { splitRef } from '../src/modelref.ts';
import { duration } from '../src/narrate.ts';
import {
    assertLocks,
    engineDisk,
    ensurePodmanReady,
    idleContainers,
    ownedContainers,
    sharedEndpoint,
    type OwnedContainer,
} from '../src/podman.ts';
import { parseRequest, readRequest } from '../src/request.ts';
import { chooseWorkspace } from '../src/resolve.ts';
import { scaffold } from '../src/scaffold.ts';
import * as term from '../src/term.ts';
import { bytes, CliError, cut, EXIT, keysIn, pad, table } from '../src/term.ts';
import { formatInline, formatMarkdown } from '../src/tui/markdown.ts';
import {
    ACTIVITY_ROWS,
    answerWidth,
    blocksOf,
    BOX_CHROME,
    boxWidth,
    BRANCH_MIN,
    BRANCH_ROWS,
    branchRows,
    budgetOf,
    CHROME_ROWS,
    clip,
    describeCall,
    gistOf,
    inlineOf,
    readable,
    scrollTop,
    summarise,
    textOf,
    THINKING_ROWS,
    unmarked,
    windowOf,
    wrap,
    type Block,
} from '../src/tui/wrap.ts';
import { LEDGER_ENV, ledgerPath } from '../src/usage.ts';
import { repinDockerfile, validateProject, type Report } from '../src/validate.ts';

// ---------------------------------------------------------------------------
// The parts of the CLI that are pure functions of their input. Everything else
// is a directory and a network call, and is covered by using the tool.
// ---------------------------------------------------------------------------

describe('formatting elapsed time', () => {
    it('uses hours, minutes and seconds for long runs', () => {
        expect(duration(10_226_000)).toBe('2h 50m 26s');
        expect(duration(3_599_600)).toBe('1h 0m 0s');
    });
});

describe('splitting the command line', () => {
    it('takes the first bare word as the command', () => {
        expect(split(['run', 'hello'])).toEqual({ before: [], name: 'run', after: ['hello'] });
    });

    it('keeps global flags that come first', () => {
        const s = split(['--json', '-C', '/tmp', 'list']);
        expect(s.before).toEqual(['--json', '-C', '/tmp']);
        expect(s.name).toBe('list');
    });

    /**
     * The regression this file exists for: an unknown flag must survive to the
     * command that defines it, rather than being absorbed by the frame.
     */
    it("does not swallow a command's own flags", () => {
        const { after } = split(['key', 'add', 'openai', '--no-check']);
        const { rest } = extract(after);
        expect(rest).toEqual(['add', 'openai', '--no-check']);
    });

    it('lifts global flags out of a command’s arguments', () => {
        const { rest, global } = extract(['--sessions', '--json', '-C', '/tmp']);
        expect(rest).toEqual(['--sessions']);
        expect(global).toEqual(['--json', '-C', '/tmp']);
    });

    it('leaves everything after -- alone', () => {
        const { rest } = extract(['--', '--json', '--help']);
        expect(rest).toEqual(['--json', '--help']);
    });
});

describe('commands in another package', () => {
    const absent: External = {
        package: 'zenera-nothing-at-all',
        summary: 'Nothing.',
        usage: 'zen nothing',
        install: 'npm i -g zenera-nothing-at-all',
    };

    it('says what to install instead of throwing a resolver error', async () => {
        const err = await loadExternal('nothing', absent).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(EXIT.usage);
        expect((err as CliError).hint).toContain(absent.install);
    });

    it('reports an uninstalled package without loading anything', () => {
        expect(hasExternal(absent)).toBe(false);
    });

    it('finds the gym, which this workspace has', () => {
        expect(hasExternal(EXTERNAL.gym)).toBe(true);
    });

    it('finds the rag package, which this workspace also has', () => {
        expect(hasExternal(EXTERNAL.rag)).toBe(true);
    });

    it('registers gym directly as an external command', () => {
        expect(EXTERNAL.gym.package).toBe('@zenera/gym');
        expect(EXTERNAL.gym.usage).toContain('|model>');
        expect(COMMANDS.gym).toBeUndefined();
    });

    /**
     * The whole point of the seam: `zen list` must not pay for a mock server's
     * dependencies, which it would the moment anything imports it statically.
     */
    it('is not imported by the frame', () => {
        const dist = join(import.meta.dirname, '..', 'dist');
        const sources = readdirSync(dist, { recursive: true }) as string[];
        for (const file of sources.filter((f) => f.endsWith('.js'))) {
            const text = readFileSync(join(dist, file), 'utf8');
            for (const ext of Object.values(EXTERNAL)) {
                expect(text).not.toContain(`from '${ext.package}`);
            }
        }
    });
});

describe('identifiers', () => {
    it('round-trips a stamp', () => {
        const id = stamp(new Date(2026, 7, 25, 14, 30, 12));
        expect(id).toMatch(/^20260825-143012-[0-9a-f]{4}$/);
        expect(isStamp(id)).toBe(true);
        expect(stampInstant(id)).toBe(new Date(2026, 7, 25, 14, 30, 12).toISOString());
    });

    it('rejects anything that could be a path', () => {
        for (const bad of ['..', 'workspace', '20260825', '20260825-143012-zzzz', '../../etc']) {
            expect(isStamp(bad)).toBe(false);
        }
    });
});

describe('keys', () => {
    it('splits a reference and refuses one that is not a name', () => {
        expect(parseRef('openai')).toEqual({ provider: 'openai', name: undefined });
        expect(parseRef('openai/work')).toEqual({ provider: 'openai', name: 'work' });
        expect(() => parseRef('openai/../etc')).toThrow();
        expect(() => parseRef('nope')).toThrow();
    });

    it('shows enough of a secret to recognise it and no more', () => {
        expect(mask('sk-proj-abcdefghijklmnop')).toBe('sk-p…mnop');
        expect(mask('short')).not.toContain('short');
    });

    // A key that a tool spends is held the same way a model key is, and is
    // named the same way on the command line. What it must not do is answer
    // the question the run gate asks, which is whether anything here can
    // reach a model.
    describe('a service key', () => {
        const kept = { ...process.env };
        afterEach(() => {
            process.env = { ...kept };
        });

        const only = (provider: string): KeyStore => {
            const entry = { provider, name: 'default', holds: 'secret', value: 'k' };
            return {
                active: (p: string) => (p === provider ? (entry as KeyEntry) : undefined),
            } as unknown as KeyStore;
        };

        const blank = (): void => {
            for (const name of Object.keys(process.env)) {
                if (/_API_KEY$|^GOOGLE_APPLICATION_CREDENTIALS$/.test(name)) {
                    delete process.env[name];
                }
            }
        };

        it('is a name the reference parser knows', () => {
            expect(parseRef('exa')).toEqual({ provider: 'exa', name: undefined });
            expect(parseRef('exa/work')).toEqual({ provider: 'exa', name: 'work' });
        });

        it('does not make a keyring usable on its own', () => {
            blank();
            expect(() => assertUsable(only('exa'))).toThrow(/no credentials/);
            expect(() => assertUsable(only('openai'))).not.toThrow();
        });
    });

    // Vertex is reached two ways that have nothing in common: a service-account
    // file the SDK resolves for itself, and an express-mode api key. Which one
    // an entry is decides the variable it occupies, so a keyring that knew only
    // the provider would export the wrong name for one of them.
    describe('a provider with two shapes', () => {
        const kept = { ...process.env };
        afterEach(() => {
            process.env = { ...kept };
        });

        const blank = (): void => {
            for (const name of Object.keys(process.env)) {
                if (/_API_KEY$|^GOOGLE_APPLICATION_CREDENTIALS$|^CLOUDSDK_CONFIG$/.test(name)) {
                    delete process.env[name];
                }
            }
            // A developer's own gcloud login must not decide what this asserts.
            process.env.CLOUDSDK_CONFIG = join(dir, 'no-gcloud');
        };

        const dir = mkdtempSync(join(tmpdir(), 'zen-keys-'));
        afterAll(() => rmSync(dir, { recursive: true, force: true }));

        const empty = { active: () => undefined } as unknown as KeyStore;

        it('names both variables it could arrive in', () => {
            expect(envNames('vertex')).toEqual([
                'GOOGLE_APPLICATION_CREDENTIALS',
                'VERTEX_API_KEY',
            ]);
            expect(envNames('openai')).toEqual(['OPENAI_API_KEY']);
        });

        it('exports each entry under the variable its own shape uses', () => {
            const file = { provider: 'vertex', holds: 'file' } as KeyEntry;
            const key = { provider: 'vertex', holds: 'secret' } as KeyEntry;
            expect(envOf(file)).toBe('GOOGLE_APPLICATION_CREDENTIALS');
            expect(envOf(key)).toBe('VERTEX_API_KEY');
        });

        it('honours the variable an entry recorded, over anything inferred', () => {
            const entry = { provider: 'vertex', holds: 'secret', env: 'LEGACY' } as KeyEntry;
            expect(envOf(entry)).toBe('LEGACY');
        });

        it('reports a credential the environment brought, under either name', () => {
            blank();
            process.env.VERTEX_API_KEY = 'vx-express';
            expect(ambient(empty, ['vertex'])).toEqual([
                { provider: 'vertex', env: 'VERTEX_API_KEY', holds: 'secret', value: 'vx-express' },
            ]);

            process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
            expect(ambient(empty, ['vertex']).map((c) => c.env)).toEqual([
                'GOOGLE_APPLICATION_CREDENTIALS',
                'VERTEX_API_KEY',
            ]);
        });

        it('collects what a run is actually carrying, whatever put it there', () => {
            blank();
            process.env.OPENAI_API_KEY = 'sk-openai';
            process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
            expect(credentials()).toEqual([
                { env: 'OPENAI_API_KEY', holds: 'secret', value: 'sk-openai' },
                {
                    env: 'GOOGLE_APPLICATION_CREDENTIALS',
                    holds: 'file',
                    value: '/tmp/sa.json',
                },
            ]);
        });
    });

    // A region is not checked by anything until the first call is made with it,
    // and that call is a 404 with no hint of which flag caused it.
    describe('a vertex region', () => {
        it('takes a concrete region, and the multi-region endpoints', () => {
            expect(checkRegion('us-central1')).toBe(true);
            expect(checkRegion('europe-west4')).toBe(true);
            expect(checkRegion('me-west1')).toBe(true);
            expect(checkRegion('northamerica-northeast1')).toBe(true);
            expect(checkRegion('northamerica-south1')).toBe(true);
            expect(checkRegion('global')).toBe(true);
            // Which models a location serves is per model, not per name, so it
            // is not a question this can answer and does not try.
            expect(checkRegion('us')).toBe(true);
            expect(checkRegion('eu')).toBe(true);
        });

        it('refuses a name no region could be', () => {
            expect(() => checkRegion('usa')).toThrow(/not a region/);
            expect(() => checkRegion('us-central')).toThrow(/not a region/);
            expect(() => checkRegion('US-CENTRAL1')).toThrow(/not a region/);
            expect(() => checkRegion('')).toThrow(/not a region/);
        });

        // Google adds regions between releases, so an unknown one is reported
        // and kept. A typo that happens to be well-formed lands here too, which
        // is the whole reason the caller says something rather than nothing.
        it('allows a well-formed region it does not know, and says so', () => {
            expect(checkRegion('us-cental1')).toBe(false);
            expect(checkRegion('mars-west1')).toBe(false);
        });
    });

    // One virtual key in place of every vendor's, switched on by a mode rather
    // than by holding the key: a laptop can keep both and choose.
    describe('a gateway key', () => {
        const kept = { ...process.env };
        let home: string;
        beforeEach(() => {
            home = mkdtempSync(join(tmpdir(), 'zen-gateway-'));
            process.env.ZENERA_HOME = home;
            for (const name of Object.keys(process.env)) {
                if (/_API_KEY$|^BIFROST_|^GOOGLE_APPLICATION_CREDENTIALS$/.test(name)) {
                    delete process.env[name];
                }
            }
        });
        afterEach(() => {
            process.env = { ...kept };
            rmSync(home, { recursive: true, force: true });
        });

        const stocked = async (): Promise<KeyStore> => {
            const store = await KeyStore.open();
            store.add('openai', 'default', 'sk-openai');
            store.add('exa', 'default', 'exa-key');
            store.add('bifrost', 'default', 'sk-bf-1', { url: 'https://gw.example' });
            return store;
        };

        it('is held but not exported while the keyring is direct', async () => {
            const store = await stocked();
            expect(store.mode).toBe('direct');
            expect(store.environment()).toEqual({
                OPENAI_API_KEY: 'sk-openai',
                EXA_API_KEY: 'exa-key',
            });
        });

        it('replaces every vendor key in its own mode, and leaves the services', async () => {
            const store = await stocked();
            store.setMode('bifrost');
            expect(store.environment()).toEqual({
                EXA_API_KEY: 'exa-key',
                BIFROST_API_KEY: 'sk-bf-1',
                BIFROST_BASE_URL: 'https://gw.example',
            });
        });

        it('exports the url even when the shell already supplies the key', async () => {
            const store = await stocked();
            store.setMode('bifrost');
            process.env.BIFROST_API_KEY = 'sk-bf-shell';
            expect(store.environment()).toMatchObject({ BIFROST_BASE_URL: 'https://gw.example' });
            expect(store.environment()).not.toHaveProperty('BIFROST_API_KEY');
        });

        it('refuses a mode with no gateway behind it', async () => {
            const store = await KeyStore.open();
            expect(() => store.setMode('bifrost')).toThrow(/no Bifrost key/);
        });

        // The sandbox forwards what this returns as secrets, by name; the url goes as plain env.
        it('hands the key to the sandbox as a secret', async () => {
            const store = await stocked();
            store.setMode('bifrost');
            store.materialize();
            expect(credentials()).toContainEqual({
                env: 'BIFROST_API_KEY',
                holds: 'secret',
                value: 'sk-bf-1',
            });
            expect(credentials().map((c) => c.env)).not.toContain('OPENAI_API_KEY');
        });

        it('survives a save', async () => {
            const store = await stocked();
            store.setMode('bifrost');
            store.save();
            expect((await KeyStore.open()).mode).toBe('bifrost');
        });

        it('makes a keyring with no vendor key usable', () => {
            const empty = { active: () => undefined } as unknown as KeyStore;
            expect(() => assertUsable(empty)).toThrow(/no credentials/);
            process.env.BIFROST_BASE_URL = 'https://gw.example';
            expect(() => assertUsable(empty)).not.toThrow();
        });

        it('names the gateway key, not the vendor one, in the audit', () => {
            expect(
                credentialFor({
                    provider: 'vertex',
                    kind: 'vertex',
                    apiKeyEnv: 'BIFROST_API_KEY',
                    satisfied: false,
                    keyOptional: false,
                    gateway: 'bifrost',
                }),
            ).toEqual({ env: 'BIFROST_API_KEY', present: false });
        });

        describe('when checked', () => {
            let server: Server;
            let url: string;
            let answer: { status: number; body: unknown };
            let seen: Record<string, string | string[] | undefined>;
            beforeEach(async () => {
                server = createServer((req, res) => {
                    seen = { path: req.url, ...req.headers };
                    res.writeHead(answer.status, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(answer.body));
                });
                await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
                url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            });
            afterEach(() => new Promise<void>((done) => server.close(() => done())));

            const check = async () => {
                const store = await KeyStore.open();
                return probe(store, store.add('bifrost', 'default', 'sk-bf-1', { url }));
            };

            it('asks the model listing, with the key in both headers', async () => {
                answer = { status: 200, body: { data: [] } };
                expect((await check()).state).toBe('live');
                expect(seen).toMatchObject({
                    path: '/v1/models',
                    authorization: 'Bearer sk-bf-1',
                    'x-bf-vk': 'sk-bf-1',
                });
            });

            it('calls a refused key dead', async () => {
                answer = {
                    status: 401,
                    body: {
                        type: 'virtual_key_required',
                        status_code: 401,
                        error: { message: 'virtual key is required' },
                    },
                };
                expect(await check()).toMatchObject({
                    state: 'dead',
                    detail: '401 virtual key is required',
                });
            });

            it('calls a spent budget blocked, which a new key would not fix', async () => {
                answer = {
                    status: 402,
                    body: {
                        type: 'budget_exceeded',
                        status_code: 402,
                        error: { message: 'Budget exceeded' },
                    },
                };
                expect(await check()).toMatchObject({ state: 'blocked', fix: /budget/ });
            });
        });

        // A pod handed BIFROST_* by a Secret has an empty keys.json and runs through the gateway.
        describe('set only in the environment', () => {
            let server: Server;
            let seen: Record<string, string | string[] | undefined>;
            beforeEach(async () => {
                server = createServer((req, res) => {
                    seen = { path: req.url, ...req.headers };
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ data: [] }));
                });
                await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
                process.env.BIFROST_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                process.env.BIFROST_API_KEY = 'sk-bf-env';
                // Keeps a real gcloud login on this machine out of the ambient credentials.
                process.env.CLOUDSDK_CONFIG = home;
            });
            afterEach(() => new Promise<void>((done) => server.close(() => done())));

            async function zenKey(...args: string[]): Promise<any> {
                const out: string[] = [];
                const write = vi
                    .spyOn(process.stdout, 'write')
                    .mockImplementation((chunk: string | Uint8Array) => {
                        out.push(String(chunk));
                        return true;
                    });
                const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
                try {
                    await COMMANDS.key!.run({ args, json: true, cwd: home });
                } finally {
                    write.mockRestore();
                    quiet.mockRestore();
                }
                return JSON.parse(out.join(''));
            }

            it('is in gateway mode with nothing stored', async () => {
                const store = await KeyStore.open();
                expect([store.mode, store.modeFrom]).toEqual(['bifrost', 'env']);
                expect(await zenKey('mode')).toEqual({
                    mode: 'bifrost',
                    from: 'env',
                    key: '$BIFROST_API_KEY',
                    url: process.env.BIFROST_BASE_URL,
                });
            });

            it('withholds the stored vendor keys, which the runtime would not read', async () => {
                expect((await stocked()).environment()).toEqual({ EXA_API_KEY: 'exa-key' });
            });

            it('lists the environment key in that mode', async () => {
                const listed = await zenKey('ls');
                expect(listed.mode).toBe('bifrost');
                expect(listed.ambient).toEqual([
                    expect.objectContaining({ id: 'bifrost/$BIFROST_API_KEY' }),
                ]);
            });

            it('checks the environment key against the environment url', async () => {
                expect(await zenKey('check')).toEqual([
                    expect.objectContaining({ key: 'bifrost/$BIFROST_API_KEY', state: 'live' }),
                ]);
                expect(seen).toMatchObject({ path: '/v1/models', 'x-bf-vk': 'sk-bf-env' });
            });

            it('accepts the mode it is already in, with no gateway key stored', async () => {
                expect(await zenKey('mode', 'bifrost')).toMatchObject({ mode: 'bifrost' });
            });

            it('stays in it when switched to direct, since the environment wins', async () => {
                (await stocked()).save();
                expect(await zenKey('mode', 'direct')).toMatchObject({
                    mode: 'bifrost',
                    from: 'env',
                });
                delete process.env.BIFROST_BASE_URL;
                expect((await KeyStore.open()).mode).toBe('direct');
            });
        });
    });
});

describe('columns', () => {
    it('can keep the block banner for an interactive terminal', () => {
        expect(bannerLines(NEO_BANNER, 1)).toHaveLength(2);
        expect(bannerLines(NEO_BANNER, Infinity)).toHaveLength(8);
    });

    it('gives every subcommand its own banner with a distinct accent hue', () => {
        const all = {
            ...Object.fromEntries(Object.entries(COMMANDS).map(([k, c]) => [k, c.banner])),
            ...Object.fromEntries(Object.entries(EXTERNAL).map(([k, e]) => [k, e.banner])),
        };
        const hues = new Set<string>();
        for (const [name, b] of Object.entries(all)) {
            expect(b, `command "${name}" missing banner`).toBeDefined();
            expect(b!.accent).toBeTruthy();
            expect(b!.subtitle).toBeTruthy();
            expect(b!.hue).toBeTruthy();
            expect(hues.has(b!.hue!), `duplicate hue "${b!.hue}" on command "${name}"`).toBe(false);
            hues.add(b!.hue!);

            const lines = bannerLines(b!, Infinity);
            expect(lines.length).toBeGreaterThanOrEqual(8);
        }
    });

    it('aligns on visible width, not byte length', () => {
        const styled = '\u001b[1mzn\u001b[22m';
        expect(pad(styled, 5)).toBe(`${styled}   `);
        expect(
            table([
                ['a', 'one'],
                ['bbbb', 'two'],
            ]),
        ).toEqual(['a     one', 'bbbb  two']);
    });
});

describe('reading the keyboard', () => {
    // The bug this exists for: one read carries several keystrokes when keys
    // are held or a line is pasted, so a picker that treats the chunk as one
    // key acts on the first and silently drops the Enter behind it.
    it('splits a chunk into one string per key', () => {
        expect([...keysIn('\u001b[B\u001b[B\r')]).toEqual(['\u001b[B', '\u001b[B', '\r']);
        expect([...keysIn('12\r')]).toEqual(['1', '2', '\r']);
        expect([...keysIn('\u001bOA\u001b[6~j')]).toEqual(['\u001bOA', '\u001b[6~', 'j']);
    });

    it('leaves a lone escape alone, which is how cancelling is spelt', () => {
        expect([...keysIn('\u001b')]).toEqual(['\u001b']);
    });
});

describe('an agent at the terminal', () => {
    // Not `vi.stubEnv`: earlier tests replace `process.env` and it keeps the old object.
    const NAMES = ['ZENERA_AGENT', 'AI_AGENT', 'COPILOT_AGENT'];
    let held: (string | undefined)[] = [];
    const set = (name: string, value: string): void => {
        process.env[name] = value;
    };
    const clear = (): void => {
        for (const name of NAMES) {
            delete process.env[name];
        }
    };
    beforeEach(() => {
        held = NAMES.map((name) => process.env[name]);
        clear();
    });
    afterEach(() => {
        clear();
        NAMES.forEach((name, i) => {
            if (held[i] !== undefined) {
                process.env[name] = held[i];
            }
        });
    });

    it('is told apart by the variables agents export', () => {
        expect(term.drivenByAgent()).toBe(false);
        set('AI_AGENT', 'github_copilot_vscode_agent');
        expect(term.drivenByAgent()).toBe(true);
        clear();
        set('COPILOT_AGENT', '1');
        expect(term.drivenByAgent()).toBe(true);
    });

    it('lets ZENERA_AGENT decide either way, so a person can opt back in', () => {
        set('ZENERA_AGENT', '1');
        expect(term.drivenByAgent()).toBe(true);
        set('AI_AGENT', 'github_copilot_vscode_agent');
        set('ZENERA_AGENT', '0');
        expect(term.drivenByAgent()).toBe(false);
    });

    it('is never asked anything, even on a real pty', () => {
        const streams = [process.stdin, process.stderr];
        const before = streams.map((s) => Object.getOwnPropertyDescriptor(s, 'isTTY'));
        try {
            for (const s of streams) {
                Object.defineProperty(s, 'isTTY', { value: true, configurable: true });
            }
            expect(term.isInteractive()).toBe(true);
            set('COPILOT_AGENT', '1');
            expect(term.isInteractive()).toBe(false);
        } finally {
            streams.forEach((s, i) => {
                const was = before[i];
                if (was) {
                    Object.defineProperty(s, 'isTTY', was);
                } else {
                    delete (s as { isTTY?: boolean }).isTTY;
                }
            });
        }
    });
});

describe('cutting a styled line', () => {
    // A row that wraps is a row the erase does not know about, and the width a
    // terminal counts is the visible one.
    it('measures without the style codes and closes them off', () => {
        const styled = `${'\u001b[1m'}a very long label${'\u001b[22m'}`;
        const short = cut(styled, 8);
        expect(short.replace(/\u001b\[[0-9;]*m/g, '')).toBe('a very …');
        expect(short.endsWith('\u001b[0m')).toBe(true);
    });

    it('leaves a line that already fits exactly as it was', () => {
        const styled = `${'\u001b[1m'}short${'\u001b[22m'}`;
        expect(cut(styled, 80)).toBe(styled);
    });
});

describe('the waiting border', () => {
    // A box 40 wide with 6 rows of narration: the ring is the two rules plus
    // the two sides, and it is one ring rather than four runs.
    const span = 2 * 40 + 2 * 6;
    const brightest = 6;

    it('lights the crest where the head is', () => {
        for (const head of [0, 5, 41, span - 1]) {
            expect(toneAt(head, head, span)).toBe(brightest);
        }
    });

    it('drags a tail behind the crest and leaves the rest at rest', () => {
        const head = 60;
        expect(toneAt(head - 2, head, span)).toBe(brightest - 1);
        expect(toneAt(head - 4, head, span)).toBe(brightest - 2);
        expect(toneAt(head - 40, head, span)).toBe(0);
        // Ahead of the crest is border the wave has not reached yet.
        expect(toneAt(head + 1, head, span)).toBe(0);
    });

    it('rounds the corners without a seam, because the ring has no end', () => {
        // A crest two cells past the start has its tail on the last cells of
        // the ring - the left side, which is drawn bottom to top.
        expect(toneAt(span - 1, 1, span)).toBe(brightest - 1);
        expect(toneAt(0, span, span)).toBe(brightest);
    });
});

describe('the waiting label', () => {
    const cells = (label: string, width = 40): string[] => footerCells(label, width);

    it('is a rule of exactly the width, label or no label', () => {
        expect(cells('')).toHaveLength(40);
        expect(cells('Working... 12s')).toHaveLength(40);
        expect(cells('Working... 1200s')).toHaveLength(40);
    });

    it('keeps the corners, so the box is still a box', () => {
        const drawn = cells('Working... 12s');
        expect(drawn[0]).toBe('\u2570');
        expect(drawn.at(-1)).toBe('\u256f');
    });

    it('sets the label near the left corner rather than centred', () => {
        expect(cells('Working... 12s').join('')).toContain('\u2570\u2500 Working... 12s ');
    });

    it('cuts a label too long for the rule instead of widening it', () => {
        const drawn = cells('x'.repeat(80));
        expect(drawn).toHaveLength(40);
        expect(drawn.join('')).toContain(`\u2500 ${'x'.repeat(34)} `);
    });

    it('is a plain rule when there is nothing to wait for', () => {
        expect(cells('').join('')).toBe(`\u2570${'\u2500'.repeat(38)}\u256f`);
    });
});

describe('the streaming window', () => {
    // The bug this exists for: a reasoning stream is one long paragraph with no
    // newlines, so counting `\n` says one line while the terminal draws fifty,
    // and a frame taller than the viewport cannot be erased.
    const paragraph = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');

    it('measures the rows a terminal will draw, not the newlines', () => {
        expect(paragraph.split('\n')).toHaveLength(1);
        expect(windowOf(paragraph, 40, 6)).toHaveLength(6);
    });

    it('never returns a row the terminal would wrap again', () => {
        for (const row of windowOf(paragraph, 40, 6)) {
            expect(row.length).toBeLessThanOrEqual(40);
        }
    });

    it('shows the tail, which is where the stream is', () => {
        const rows = windowOf(paragraph, 40, 6);
        expect(rows.at(-1)).toContain('word399');
    });

    it('breaks a word wider than the terminal rather than overflowing', () => {
        expect(wrap('x'.repeat(25), 10)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
    });

    it('asks for no more rows than there are', () => {
        expect(windowOf('one\ntwo', 40, 6)).toEqual(['one', 'two']);
    });
});

describe('dividing the frame', () => {
    // Same bug, one level up: three blocks now share the rows below the
    // scrollback, and their total is the thing that must not exceed the
    // viewport. Anything else on screen is `Static`, which never repaints.
    const height = (b: { activity: number; thinking: number; live: number }): number =>
        b.activity + b.thinking + b.live;

    it('never hands out more rows than the terminal has', () => {
        for (const rows of [1, 2, 6, 7, 8, 12, 24, 60]) {
            for (const activity of [0, 1, 3, 6, 20]) {
                for (const thinking of [0, 1, THINKING_ROWS]) {
                    const budget = budgetOf(rows, activity, thinking);
                    expect(height(budget)).toBeLessThanOrEqual(Math.max(2, rows - CHROME_ROWS));
                    // And exactly as many as it reserves: the region is drawn
                    // at `total`, so a sum that came out short would leave the
                    // footer riding on whatever the model happened to say.
                    expect(height(budget)).toBe(budget.total);
                }
            }
        }
    });

    it('always leaves a row for the answer', () => {
        for (const rows of [1, 2, 8, 24]) {
            expect(budgetOf(rows, 20, THINKING_ROWS).live).toBeGreaterThanOrEqual(1);
        }
    });

    it('drops the reasoning line rather than the answer', () => {
        // Two rows to give away go to the answer first: the gist is a heading
        // for text that is about to arrive, and a heading with nothing under
        // it is worth less than the thing itself.
        expect(budgetOf(9, 0, THINKING_ROWS)).toMatchObject({ thinking: 1, live: 1 });
        expect(budgetOf(8, 2, THINKING_ROWS)).toMatchObject({ activity: 0, thinking: 1, live: 1 });
    });

    it('never spends more than a row on reasoning', () => {
        // However much arrives, and whatever the caller asks for: it is a
        // heading, and the whole chain is in the report.
        expect(budgetOf(24, 0, THINKING_ROWS).thinking).toBe(1);
        expect(budgetOf(24, 0, 1).thinking).toBe(1);
        expect(budgetOf(24, 0, 1).live).toBe(16);
        expect(budgetOf(24, 0, 0).live).toBe(17);
    });

    it('caps what is in flight rather than the answer', () => {
        expect(budgetOf(48, 30, 0).activity).toBe(ACTIVITY_ROWS);
        expect(budgetOf(24, 20, 0).activity).toBe(15);
        expect(budgetOf(24, 2, 0).activity).toBe(2);
        expect(budgetOf(24, 0, 0).activity).toBe(0);
    });

    it('gives the activity list nothing when there is no room for it', () => {
        expect(budgetOf(8, 4, 0).activity).toBe(0);
    });
});

describe('sharing the frame between branches', () => {
    it('never gives a box more than it can draw', () => {
        for (const count of [1, 2, 3, 4, 6, 8]) {
            const each = branchRows(count, 12);
            expect(each).toBeGreaterThanOrEqual(BRANCH_MIN);
            expect(each).toBeLessThanOrEqual(BRANCH_ROWS);
        }
    });

    it('divides the allowance while every box can still be read', () => {
        // Two branches in the whole allowance can each afford the full detail;
        // three share it down to the floor, and a fork wider than that is cut
        // by `fitActivity` rather than flattened to a label apiece.
        expect(branchRows(2, ACTIVITY_ROWS)).toBe(BRANCH_ROWS);
        expect(branchRows(3, ACTIVITY_ROWS)).toBe(BRANCH_MIN);
        expect(3 * (BOX_CHROME + branchRows(3, ACTIVITY_ROWS))).toBeLessThanOrEqual(ACTIVITY_ROWS);
    });

    it('keeps a box legible rather than complete, and nothing at all for none', () => {
        expect(branchRows(8, 12)).toBe(BRANCH_MIN);
        expect(branchRows(1, 0)).toBe(BRANCH_MIN);
        expect(branchRows(0, 12)).toBe(0);
    });
});

describe('bounding the answer', () => {
    it('stops well short of a very wide terminal', () => {
        expect(answerWidth(200)).toBe(96);
        expect(answerWidth(100)).toBe(96);
    });

    it('leaves the margin on a narrow one, and never goes to nothing', () => {
        expect(answerWidth(80)).toBe(76);
        expect(answerWidth(10)).toBe(24);
    });

    /**
     * Folding a table row is the one thing that makes a table useless, so the
     * box gives up its comfort width rather than its alignment.
     */
    it('grows past the comfort width to hold a table, and no further than the terminal', () => {
        const row = `| ${'x'.repeat(116)} |`;
        expect(row.length).toBe(120);
        expect(boxWidth(`look:\n${row}`, 200)).toBe(124);
        expect(boxWidth(`look:\n${row}`, 100)).toBe(96);
        expect(boxWidth('just prose', 200)).toBe(answerWidth(200));
    });
});

describe('reading a tool payload', () => {
    it('gives a lone argument as itself, with no json around it', () => {
        expect(readable('{"command":"ls -la /tmp"}')).toBe('ls -la /tmp');
    });

    it('unescapes the quotes a shell command is full of', () => {
        expect(readable('{"command":"zen rag docs search -d /docs \\"What is a tenant\\""}')).toBe(
            'zen rag docs search -d /docs "What is a tenant"',
        );
    });

    it('reads a preview that was cut off mid-string', () => {
        // The common case: the calls worth reading are the long ones, and a
        // preview is cut to a length, so the json does not close.
        expect(readable('{"command":"zen rag docs search -d /assets/docs \\"Rate limit he')).toBe(
            'zen rag docs search -d /assets/docs "Rate limit he',
        );
    });

    it('names the fields when there is more than one', () => {
        expect(readable('{"exit_code":0,"stdout":"ok"}')).toBe('exit_code=0 stdout=ok');
    });

    it('leaves something that is not a payload alone', () => {
        expect(readable('  transferred to docs_searcher  ')).toBe('transferred to docs_searcher');
    });

    it('keeps a non-string value as written', () => {
        expect(readable('{"names":["docs_index"]}')).toBe('["docs_index"]');
    });
});

describe('saying what a call is doing', () => {
    // A transcript row has one line to say what the agent did, and the tool's
    // own name next to its serialised arguments is the least readable way to
    // spend it.

    it('gives a known tool a verb and the argument that identifies it', () => {
        expect(describeCall('run_command', '{"command":"npm test"}')).toEqual({
            verb: 'run',
            subject: 'npm test',
        });
        expect(describeCall('read_file', '{"path":"src/index.ts","start":1}')).toEqual({
            verb: 'read',
            subject: 'src/index.ts',
        });
    });

    it('names a few items and counts more than a few', () => {
        const two = '{"nodes":[{"name":"alpha"},{"name":"beta"}]}';
        expect(describeCall('memory_commit', two).subject).toBe('alpha, beta');
        const three = '{"nodes":[{"name":"a"},{"name":"b"},{"name":"c"}]}';
        expect(describeCall('memory_commit', three).subject).toBe('3 nodes');
    });

    it('counts an array of plain strings too', () => {
        expect(describeCall('memory_forget', '{"ids":["n1"]}').subject).toBe('n1');
        expect(describeCall('skill_load', '{"names":["a","b","c","d"]}').subject).toBe('4 skills');
    });

    it('reads the files out of a patch rather than the patch', () => {
        const patch =
            '{"patch":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-x\\n+y\\n' +
            '*** Add File: src/b.ts\\n"}';
        expect(describeCall('apply_patch', patch)).toEqual({
            verb: 'patch',
            subject: 'src/a.ts, src/b.ts',
        });
        expect(
            describeCall(
                'apply_patch',
                '{"patch":"*** Update File: a\\n*** Update File: b\\n*** Delete File: c\\n"}',
            ).subject,
        ).toBe('3 files');
    });

    it('draws a move as where it went', () => {
        expect(describeCall('move_file', '{"from":"a.ts","to":"b.ts"}').subject).toBe(
            'a.ts → b.ts',
        );
    });

    it('reads a handoff off the tool name, since there is one per agent', () => {
        expect(describeCall('transfer_to_docs_searcher', '{}')).toEqual({
            verb: 'hand off to',
            subject: 'docs_searcher',
        });
    });

    it('falls back to the name and the payload for a tool it does not know', () => {
        expect(describeCall('lookup_invoice', '{"id":"INV-9"}')).toEqual({
            verb: 'lookup_invoice',
            subject: 'INV-9',
        });
    });
});

describe('saying what came back', () => {
    it('lets an error have the whole row', () => {
        expect(summarise('run_command', '{"exit_code":1,"error":"no such file"}')).toBe(
            'no such file',
        );
    });

    it('counts a listing rather than naming the first two of forty', () => {
        expect(summarise('list_dir', '{"path":"/src","entries":["a.ts","b.ts","c.ts"]}')).toBe(
            '3 entries',
        );
    });

    it('takes the field that says how it went', () => {
        expect(summarise('run_command', '{"exit_code":0,"stdout":"ok"}')).toBe('exit code 0');
        expect(summarise('read_file', '{"path":"a.ts","lines":120}')).toBe('lines 120');
    });

    it('shows the payload for a tool it does not know', () => {
        expect(summarise('lookup_invoice', '{"total":"42.00"}')).toBe('42.00');
    });
});

describe('the gist of a reasoning stream', () => {
    it('takes the last heading, which is where the model got to', () => {
        const text = '**Reading the config**\nsome prose\n**Checking the ports**\nmore prose';
        expect(gistOf(text, 60)).toBe('Checking the ports');
    });

    it('falls back to the raw tokens when nothing is marked up', () => {
        expect(gistOf('just thinking about the problem', 60)).toBe(
            'just thinking about the problem',
        );
    });

    it('is always one row', () => {
        const text = `**A**\n${'word '.repeat(400)}`;
        expect(gistOf(text, 40)).not.toContain('\n');
        expect(gistOf(text, 40).length).toBeLessThanOrEqual(40);
    });
});

describe('clipping to one row', () => {
    it('flattens the shape a preview happened to arrive in', () => {
        expect(clip('a\n  b\t c ', 40)).toBe('a b c');
    });

    it('marks a value it had to cut', () => {
        expect(clip('abcdefghij', 5)).toBe('abcd…');
        expect(clip('abcde', 5)).toBe('abcde');
    });
});

describe('scrolling a list', () => {
    it('stays put while the selection is in view', () => {
        expect(scrollTop(5, 3, 10, 100)).toBe(3);
    });

    it('moves only as far as the selection needs', () => {
        expect(scrollTop(20, 3, 10, 100)).toBe(11);
        expect(scrollTop(2, 3, 10, 100)).toBe(2);
    });

    it('never scrolls past the last full window, nor above the first row', () => {
        expect(scrollTop(99, 95, 10, 100)).toBe(90);
        expect(scrollTop(0, 0, 10, 4)).toBe(0);
    });
});

describe('the blocks of an answer', () => {
    const kinds = (text: string): string[] => blocksOf(text).map((b) => b.kind);

    it('leaves an answer with no markup as one paragraph', () => {
        expect(blocksOf('one\ntwo')).toEqual([
            { kind: 'paragraph', spans: [{ text: 'one\ntwo' }] },
        ]);
    });

    it('keeps the indentation a code block depends on', () => {
        const [prose, block] = blocksOf('look:\n```ts\nif (x) {\n    y();\n}\n```');
        expect(prose).toEqual({ kind: 'paragraph', spans: [{ text: 'look:' }] });
        expect(block?.kind).toBe('code');
        expect(block?.title).toBe('ts');
        expect(block?.lines).toEqual(['if (x) {', '    y();', '}']);
    });

    it('takes an unlabelled fence, and an unclosed one', () => {
        const [block] = blocksOf('```\nx\n');
        expect(block?.kind).toBe('code');
        expect(block?.title).toBeUndefined();
        expect(block?.lines).toEqual(['x', '']);
    });

    it('splits a table out of the prose around it', () => {
        const [intro, table, note] = blocksOf('ranked:\n| a | b |\n| - | - |\n| 1 | 2 |\nso.');
        expect(intro).toEqual({ kind: 'paragraph', spans: [{ text: 'ranked:' }] });
        expect(table?.kind).toBe('table');
        expect(table?.cells).toEqual([
            [[{ text: 'a' }], [{ text: 'b' }]],
            [[{ text: '1' }], [{ text: '2' }]],
        ]);
        expect(table?.align).toEqual(['left', 'left']);
        expect(note).toEqual({ kind: 'paragraph', spans: [{ text: 'so.' }] });
    });

    /**
     * A model writes the pipes where its words end, not where the columns are,
     * and it emphasises a cell as readily as a sentence. Both are the table's
     * problem to solve: the markers come out, and the columns are laid out from
     * what is left.
     */
    it('lays a table out in columns of its own, with the markup resolved', () => {
        const [table] = blocksOf(
            '| Resource | Usage |\n| :--- | ---: |\n| **Security** | 75.15% |\n| Audit | 4% |',
        );
        expect(textOf(table as Block)).toBe(
            [
                '| Resource |  Usage |',
                '|----------|--------|',
                '| Security | 75.15% |',
                '| Audit    |     4% |',
            ].join('\n'),
        );
    });

    it('is still a table with no rule row, and has no header to embolden', () => {
        const [table] = blocksOf('| a | bb |\n| ccc | d |');
        expect(table?.align).toBeUndefined();
        expect(textOf(table as Block)).toBe('| a   | bb  |\n| ccc | d   |');
    });

    it('leaves a pipe inside a fence, and one in a sentence, as they were', () => {
        const [block] = blocksOf('```sh\n| a | b |\n```');
        expect(block?.kind).toBe('code');
        expect(block?.lines).toEqual(['| a | b |']);
        expect(kinds('pipe ls | wc -l for a count')).toEqual(['paragraph']);
    });

    it('reads a heading down to its level, without the hashes', () => {
        const [h] = blocksOf('## What changed ##');
        expect(h?.kind).toBe('heading');
        expect(h?.level).toBe(2);
        expect(h?.spans).toEqual([{ text: 'What changed' }]);
        // Seven is not a heading, and a bare `#` with no text is not one either.
        expect(kinds('####### nope')).toEqual(['paragraph']);
        expect(kinds('#nope')).toEqual(['paragraph']);
    });

    it('gives a list one block per item, with the bullet resolved', () => {
        const blocks = blocksOf('- first\n- second\n  - nested\n1. numbered');
        expect(blocks.map((b) => b.kind)).toEqual(['item', 'item', 'item', 'item']);
        expect(blocks.map((b) => b.marker)).toEqual(['\u2022', '\u2022', '\u25e6', '1.']);
        expect(blocks.map((b) => b.level)).toEqual([0, 0, 1, 0]);
        expect(blocks[0]?.spans).toEqual([{ text: 'first' }]);
    });

    it('keeps a wrapped item with the item it belongs to', () => {
        const [item] = blocksOf('- a long point\n  that carried on');
        expect(item?.kind).toBe('item');
        expect(item?.spans).toEqual([{ text: 'a long point\nthat carried on' }]);
    });

    /** Models use `---` as a separator far more often than they mean a setext rule. */
    it('takes a rule, and does not mistake a list for one', () => {
        expect(kinds('a\n\n---\n\nb')).toEqual(['paragraph', 'rule', 'paragraph']);
        expect(kinds('* * *')).toEqual(['rule']);
        expect(kinds('- item')).toEqual(['item']);
    });

    it('gathers a quote, however many `>` rows it took', () => {
        const [quote] = blocksOf('> one\n> two');
        expect(quote?.kind).toBe('quote');
        expect(quote?.spans).toEqual([{ text: 'one\ntwo' }]);
    });
});

describe('the inline markup of an answer', () => {
    it('lifts the weights out of the text rather than leaving the markers in', () => {
        expect(inlineOf('a **bold** and *slanted* word')).toEqual([
            { text: 'a ' },
            { text: 'bold', bold: true },
            { text: ' and ' },
            { text: 'slanted', italic: true },
            { text: ' word' },
        ]);
    });

    /**
     * The reason this is a scanner and not a chain of replaces: no regex over
     * the whole string can know that the brackets here are being quoted.
     */
    it('never reads markup inside a code span', () => {
        expect(inlineOf('write `[a](b)` and `**x**`')).toEqual([
            { text: 'write ' },
            { text: '[a](b)', code: true },
            { text: ' and ' },
            { text: '**x**', code: true },
        ]);
    });

    it('lets a code span hold a backtick, and takes the padding off', () => {
        expect(inlineOf('`` ` ``')).toEqual([{ text: '`', code: true }]);
    });

    it('carries a link target beside its text', () => {
        expect(inlineOf('see [the docs](https://x.dev/a "title") now')).toEqual([
            { text: 'see ' },
            { text: 'the docs', href: 'https://x.dev/a' },
            { text: ' now' },
        ]);
    });

    it('nests, so a bold sentence keeps the code in it', () => {
        expect(inlineOf('**run `zen check` first**')).toEqual([
            { text: 'run ', bold: true },
            { text: 'zen check', bold: true, code: true },
            { text: ' first', bold: true },
        ]);
    });

    /** Half a marker is the normal state of a stream, not an error. */
    it('emits an unmatched marker as the text it is', () => {
        expect(inlineOf('a **bold')).toEqual([{ text: 'a **bold' }]);
        expect(inlineOf('unclosed `code')).toEqual([{ text: 'unclosed `code' }]);
        expect(inlineOf('[not a link')).toEqual([{ text: '[not a link' }]);
    });

    it('leaves arithmetic and identifiers alone', () => {
        expect(inlineOf('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4' }]);
        expect(inlineOf('snake_case_name')).toEqual([{ text: 'snake_case_name' }]);
    });

    it('honours an escape', () => {
        expect(inlineOf('literal \\*stars\\*')).toEqual([{ text: 'literal *stars*' }]);
    });

    it('drops the markers of a weight it has nowhere to put', () => {
        expect(inlineOf('~~gone~~')).toEqual([{ text: 'gone' }]);
    });

    /**
     * The invariant the whole design rests on: styling rides beside the text,
     * so a row is exactly as wide as the characters it will print.
     */
    it('measures as the text it prints, not the source it came from', () => {
        const spans = inlineOf('a **bold** `code` [link](https://x.dev) word');
        expect(spans.reduce((n, s) => n + s.text.length, 0)).toBe('a bold code link word'.length);
    });
});

describe('an answer with its markers resolved', () => {
    it('draws what the stream will show before the styling lands on it', () => {
        expect(unmarked('## Title\n\n- **one**\n- two\n\nDone.')).toBe(
            'Title\n\n\u2022 one\n\u2022 two\n\nDone.',
        );
    });

    it('leaves a fence exactly as it was, behind the chrome it will settle into', () => {
        expect(unmarked('```\n  x = **1**\n```')).toBe(
            '\u250c\u2500\n\u2502   x = **1**\n\u2514\u2500',
        );
    });
});

describe('the prompt history', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-history-'));
    let n = 0;

    const project = (): string => {
        const dir = join(root, `p${n++}`);
        mkdirSync(dir, { recursive: true });
        return dir;
    };

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('survives the process that wrote it', () => {
        const dir = project();
        const first = History.open(dir);
        first.add('what changed in the last release?');
        first.add('summarise it');
        expect(History.open(dir).entries).toEqual([
            'what changed in the last release?',
            'summarise it',
        ]);
    });

    it('lives beside the sessions, not inside one', () => {
        const dir = project();
        expect(historyPath(dir)).toBe(join(dir, 'sessions', '.history'));
        History.open(dir).add('hello');
        expect(readFileSync(historyPath(dir), 'utf8')).toBe('hello\n');
    });

    it('keeps blanks and repeats out of it', () => {
        const dir = project();
        const history = History.open(dir);
        history.add('  ');
        history.add('again');
        history.add('again');
        history.add('  again  ');
        history.add('once more');
        expect(history.entries).toEqual(['again', 'once more']);
    });

    it('reads a file it did not write', () => {
        const dir = project();
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        writeFileSync(historyPath(dir), 'one\n\ntwo\n');
        expect(History.open(dir).entries).toEqual(['one', 'two']);
    });

    it('keeps the newest entries and no more', () => {
        const dir = project();
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        const lines = Array.from({ length: MAX_ENTRIES * 3 }, (_, i) => `q${i}`);
        writeFileSync(historyPath(dir), `${lines.join('\n')}\n`);
        const history = History.open(dir);
        expect(history.entries).toHaveLength(MAX_ENTRIES);
        expect(history.entries.at(-1)).toBe(`q${MAX_ENTRIES * 3 - 1}`);
        // Past twice the cap the file itself is rewritten, so it cannot grow
        // without bound just because nobody ever deletes it.
        expect(readFileSync(historyPath(dir), 'utf8').trimEnd().split('\n')).toHaveLength(
            MAX_ENTRIES,
        );
    });

    it('is absent until something is asked', () => {
        const dir = project();
        expect(History.open(dir).entries).toEqual([]);
        expect(existsSync(historyPath(dir))).toBe(false);
    });
});

describe('model prices', () => {
    it('are shown per million tokens, the unit price lists use', () => {
        expect(perMillion('0.0000025')).toBe('$2.50');
        expect(perMillion('0.000000075')).toBe('$0.075');
        expect(perMillion('0.0000001')).toBe('$0.10');
        expect(perMillion('0')).toBe('free');
        expect(perMillion('-1')).toBe('varies');
        expect(perMillion(undefined)).toBe('');
    });
});

describe('the model probe', () => {
    const served: Model = {
        id: 'gpt-stub',
        generate: async () => ({ text: 'ok', toolCalls: [] }),
    };
    const refuses = (err: unknown): Model => ({
        id: 'gpt-stub',
        generate: async () => {
            throw err;
        },
    });
    const fails = (message: string, status?: number): Error =>
        Object.assign(new Error(message), status === undefined ? {} : { status });

    it('reports a model that answers, and what it answered as', async () => {
        const [probe] = await probeModels([{ ref: 'main', kind: 'model', model: served }]);
        expect(probe).toMatchObject({ ref: 'main', id: 'gpt-stub', kind: 'model' });
        expect(probe!.check.state).toBe('live');
    });

    // The whole point of asking: a credential that works, spent on a model id
    // that does not. Nothing short of the call says so - and the answer is
    // `blocked` rather than `dead`, because a new key would be refused for
    // exactly the same reason and the fix is a different model.
    it('calls an unserved model id blocked, and points at the listing', async () => {
        const err = fails('The model `gpt-9` does not exist or you do not have access', 404);
        const [probe] = await probeModels([
            { ref: 'openai:gpt-9', kind: 'model', model: refuses(err) },
        ]);
        expect(probe!.check.state).toBe('blocked');
        expect(probe!.check.fix).toBe('zen models ls openai');
    });

    // A tool-less ping passed models that then refused the first real turn.
    it('asks with a tool, as every run does', async () => {
        let asked: ModelRequest | undefined;
        const model: Model = {
            id: 'gpt-stub',
            generate: async (req) => {
                asked = req;
                return { text: 'ok', toolCalls: [] };
            },
        };
        await probeModels([{ ref: 'main', kind: 'model', model }]);
        expect(asked?.tools).toHaveLength(1);
    });

    it('points a reasoning model refused tools on chat completions at the responses API', async () => {
        const err = fails(
            '400 Function tools with reasoning_effort are not supported for gpt-5.6-luna in ' +
                "/v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
            400,
        );
        const [probe] = await probeModels([
            { ref: 'openai:gpt-5.6-luna', kind: 'model', model: refuses(err) },
        ]);
        expect(probe!.check.state).toBe('blocked');
        expect(probe!.check.fix).toContain('openai/responses:gpt-stub');
    });

    it('keeps the credential refusal and the unreachable host apart', async () => {
        const [refused, silent] = await probeModels([
            { ref: 'a', kind: 'model', model: refuses(fails('invalid_api_key', 401)) },
            { ref: 'b', kind: 'model', model: refuses(fails('fetch failed')) },
        ]);
        expect(refused!.check.state).toBe('dead');
        expect(silent!.check.state).toBe('unknown');
    });

    // A 429 proves the key, not the model: nothing came back, so it is not `live`.
    it('does not call a rate-limited model live', async () => {
        const err = Object.assign(new Error('Provider returned error'), { statusCode: 429 });
        const [probe] = await probeModels([
            { ref: 'openrouter:google/gemma:free', kind: 'model', model: refuses(err) },
        ]);
        expect(probe!.check.state).toBe('unknown');
        expect(probe!.check.detail).toContain('rate limited');
        expect(probe!.check.fix).toContain('zen models test openrouter:google/gemma');
    });

    it('asks an embedder for a vector instead of a completion', async () => {
        let asked: EmbeddingRequest | undefined;
        const embedder: Embedder = {
            id: 'embed-stub',
            embed: async (req) => {
                asked = req;
                return { vectors: [[1]], dimensions: 1 };
            },
        };
        const [probe] = await probeModels([{ ref: 'main', kind: 'embedding', embedder }]);
        expect(probe).toMatchObject({ id: 'embed-stub', kind: 'embedding' });
        expect(probe!.check.state).toBe('live');
        expect(asked?.input).toHaveLength(1);
    });

    // The registry refuses a knob the adapter never sends, and the OpenAI
    // adapters have no output cap - so a probe that capped every vendor was
    // refused before it asked anything.
    describe('building the chat model it asks', () => {
        beforeEach(() => {
            vi.stubEnv('OPENAI_API_KEY', 'sk-test');
            vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
        });
        afterEach(() => vi.unstubAllEnvs());

        it('leaves the cap off where the adapter would not read it', () => {
            expect(probeChat('openai', 'gpt-stub').id).toBe('gpt-stub');
        });

        it('keeps it where the vendor requires one', () => {
            expect(probeChat('anthropic', 'claude-stub').id).toBe('claude-stub');
        });
    });
});

describe('the credential audit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-audit-'));
    // Only the keyring's verdict on a key is asked for here; the keys
    // themselves reach the audit the way they reach the library, through the
    // environment.
    const store = { active: () => undefined } as unknown as KeyStore;
    const kept = { ...process.env };

    afterEach(() => {
        process.env = { ...kept };
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const project = (models: string): string => {
        writeFileSync(
            join(dir, 'agents.yaml'),
            `version: 1\nmodel: fast\nmodels:\n${models}\nagents:\n  - name: default\n`,
        );
        return dir;
    };

    it('names the model and the variable that would carry its key', () => {
        delete process.env.GEMINI_API_KEY;
        const issues = auditModels(
            project('    fast:\n        provider: google\n        model: gemini-2.5-flash\n'),
            store,
        );
        expect(issues).toEqual([
            {
                name: 'fast',
                role: 'model',
                provider: 'google',
                env: 'GEMINI_API_KEY',
                reason: 'missing',
                add: 'google',
            },
        ]);
    });

    it('says nothing about a model that can be reached', () => {
        process.env.GEMINI_API_KEY = 'k';
        expect(
            auditModels(
                project('    fast:\n        provider: google\n        model: gemini-2.5-flash\n'),
                store,
            ),
        ).toEqual([]);
    });

    /**
     * Vertex takes no api key at all, so asking after `VERTEX_API_KEY` would
     * warn about every correctly configured service account there is.
     */
    it('looks for vertex credentials where vertex keeps them', () => {
        const config = '    fast:\n        provider: vertex\n        model: gemini-2.5-flash\n';
        process.env.GOOGLE_APPLICATION_CREDENTIALS = join(dir, 'sa.json');
        expect(auditModels(project(config), store)).toEqual([]);

        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        process.env.CLOUDSDK_CONFIG = join(dir, 'no-gcloud');
        expect(auditModels(project(config), store)).toEqual([
            {
                name: 'fast',
                role: 'model',
                provider: 'vertex',
                env: 'GOOGLE_APPLICATION_CREDENTIALS',
                reason: 'missing',
                add: 'vertex',
            },
        ]);
    });

    /** A config nothing can read is the loader's to complain about, in its own words. */
    it('stays quiet when there is no config to read', () => {
        expect(auditModels(join(dir, 'nowhere'), store)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The project check
//
// What is under test is the thing the loader cannot do: keep going. Every case
// below plants more than one problem and asserts that more than one comes
// back, because a check that stopped at the first would be the loader with a
// longer name.
// ---------------------------------------------------------------------------

describe('the project check', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-check-'));
    let n = 0;

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** A project directory holding exactly the files a case names. */
    const project = (files: Record<string, string>): string => {
        const dir = join(root, `p${n++}`);
        for (const [rel, body] of Object.entries(files)) {
            mkdirSync(join(dir, rel, '..'), { recursive: true });
            writeFileSync(join(dir, rel), body);
        }
        mkdirSync(dir, { recursive: true });
        return dir;
    };

    const codes = (report: Report): string[] => report.findings.map((f) => f.code);
    const errors = (report: Report): string[] =>
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code);

    it('passes a project whose files are all there', async () => {
        const dir = project({
            'agents/instructions.md': 'House rules.\n',
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
            'agents/prompts/solo.md': 'Be useful.\n',
        });
        const report = await validateProject({ dir });

        expect(report.ok).toBe(true);
        expect(errors(report)).toEqual([]);
        expect(report.project.entry).toBe('solo');
        expect(report.agents[0].instructions).toEqual([
            'agents/instructions.md',
            'agents/prompts/solo.md',
        ]);
        // No keyring was passed, so nothing may be said about credentials.
        expect(report.models[0].credential).toBe('unknown');
    });

    /**
     * Every agent reads every one of them, so the check has to name every one
     * of them: an instruction file nothing lists is one nobody knows is live.
     */
    it('lists every house-rules file an agent is given, in the loader order', async () => {
        const dir = project({
            'agents/instructions.md': 'House rules.\n',
            'agents/memory-instructions.md': 'Never grep /memory.\n',
            'agents/aaa-instructions.md': 'First.\n',
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
            'agents/prompts/solo.md': 'Be useful.\n',
        });
        const report = await validateProject({ dir });

        expect(errors(report)).toEqual([]);
        expect(report.agents[0].instructions).toEqual([
            'agents/instructions.md',
            'agents/aaa-instructions.md',
            'agents/memory-instructions.md',
            'agents/prompts/solo.md',
        ]);
        expect(report.files.find((f) => f.path === 'agents/memory-instructions.md')?.exists).toBe(
            true,
        );
    });

    it('reports every broken reference, not the first', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\ndefault: nobody\nagents:\n' +
                '  - name: intake\n    system: prompts/gone.md\n' +
                '    tools: [workspace:*, invented_tool]\n' +
                '    handoffs: [ghost, intake]\n',
        });
        const found = errors(await validateProject({ dir }));

        expect(found).toContain('entry.unknown');
        expect(found).toContain('prompt.missing');
        expect(found).toContain('tools.unresolved');
        expect(found).toContain('handoff.unknown');
        expect(found).toContain('handoff.self');
    });

    /**
     * A hand-off is a one-way door, so an edge with no way home leaves the
     * agent it points at owning the conversation for good. Indirect returns
     * count, and a fork needs no edge at all.
     */
    it('warns about a hand-off that can never come back', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\nagents:\n' +
                '  - name: intake\n    description: Routes.\n' +
                '    handoffs: [billing, technical]\n' +
                '  - name: billing\n    description: Bills.\n    handoffs: [technical]\n' +
                '  - name: technical\n    description: Fixes.\n    handoffs: [intake]\n',
        });
        const report = await validateProject({ dir });

        // intake → billing → technical → intake closes; billing → technical
        // does too, the long way round. Nothing is one-way here.
        expect(codes(report)).not.toContain('handoff.one-way');
        expect(errors(report)).toEqual([]);
    });

    it('names the edge that strands the conversation', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\nagents:\n' +
                '  - name: intake\n    description: Routes.\n    handoffs: [docs]\n' +
                '  - name: docs\n    description: Searches documents.\n',
        });
        const report = await validateProject({ dir });

        const one = report.findings.find((f) => f.code === 'handoff.one-way');
        expect(one?.severity).toBe('warning');
        expect(one?.where).toBe('agents.intake.handoffs');
        expect(errors(report)).toEqual([]);
    });

    /** A branch returns on its own, so a fork is never a dead end. */
    it('asks nothing of a fork', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\nagents:\n' +
                '  - name: intake\n    description: Routes.\n' +
                '    fork:\n      agents: [docs]\n' +
                '  - name: docs\n    description: Searches documents.\n',
        });
        const report = await validateProject({ dir });

        expect(codes(report)).not.toContain('handoff.one-way');
    });

    it('says which files it looked for when there is no config at all', async () => {
        const report = await validateProject({
            dir: project({ 'agents/instructions.md': 'hello\n' }),
        });

        expect(errors(report)).toEqual(['config.missing']);
        expect(report.project.config).toBeNull();
    });

    /**
     * A schema failure ends the walk, so the one thing that must survive it is
     * the file inventory: it is what says whether the prompts a broken config
     * points at are even on disk.
     */
    it('keeps the file inventory when the schema fails', async () => {
        const report = await validateProject({
            dir: project({
                'agents.yaml': 'version: 1\nagents:\n  - name: Not A Name\n',
                'agents/instructions.md': 'hello\n',
            }),
        });

        expect(errors(report)).toEqual(['config.invalid']);
        expect(report.files.find((f) => f.path === 'agents/instructions.md')?.exists).toBe(true);
    });

    it('checks the skill catalog it will actually read', async () => {
        const dir = project({
            'agents.yaml':
                'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n' +
                '    skills:\n      allow: [known]\n      preload: [unlisted]\n',
            'agents/prompts/solo.md': 'Be useful.\n',
            'agents/skills/known/SKILL.md': '---\nname: known\ndescription: A skill.\n---\nBody.\n',
            'agents/skills/halfway/notes.md': 'no SKILL.md here\n',
            'agents/skills/loose.md': '---\ndescription: Loose.\n---\nBody.\n',
        });
        const report = await validateProject({ dir });

        expect(errors(report)).toContain('skills.preload-not-allowed');
        expect(errors(report)).toContain('skills.preload-unknown');
        expect(codes(report)).toContain('skill.no-skill-md');
        // A bare `<name>.md` is indexed, and is still the wrong layout.
        expect(errors(report)).toContain('skill.flat');
        expect(report.skills.entries.map((s) => s.name)).toEqual(['known', 'loose']);
        expect(report.skills.entries[0].usedBy).toEqual(['solo']);
    });

    /** The files a skill folder ships, which the agent reaches under /skills. */
    it('lists what else is in a skill folder', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
            'agents/skills/render/SKILL.md': '---\ndescription: Renders.\n---\nRun scripts/go.py\n',
            'agents/skills/render/scripts/go.py': 'print("hi")\n',
            'agents/skills/plain.md': 'Just text.\n',
        });
        const report = await validateProject({ dir });

        const byName = new Map(report.skills.entries.map((s) => [s.name, s]));
        expect(byName.get('render')?.files).toEqual(['scripts/']);
        // A bare `<name>.md` skill's neighbours are other skills, not its own files.
        expect(byName.get('plain')?.files).toBeUndefined();
    });

    it('reports an assets directory that is named but not there', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nassets: handbook\nagents:\n  - name: solo\n',
        });
        const report = await validateProject({ dir });

        expect(errors(report)).toContain('assets.missing');
        expect(report.files.find((f) => f.path === 'handbook')?.from).toBe('assets');
    });

    /**
     * Pointing `assets:` at the project itself hands every agent the sessions
     * directory - every transcript of every run, including the one reading it.
     */
    it('warns when assets would include the project’s own files', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nassets: .\nagents:\n  - name: solo\n',
            'sessions/keep.txt': 'a transcript would live here\n',
        });
        const report = await validateProject({ dir });

        expect(codes(report)).toContain('assets.overbroad');
        expect(errors(report)).not.toContain('assets.overbroad');
    });

    /** No `assets:`, no folder, nothing to say. */
    it('says nothing about assets when the project has none', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
        });
        const report = await validateProject({ dir });

        expect(codes(report).filter((c) => c.startsWith('assets.'))).toEqual([]);
        expect(report.files.some((f) => f.path === 'assets')).toBe(false);
    });

    it('notes an assets directory with nothing in it', async () => {
        const dir = project({
            'agents.yaml': 'version: 1\nmodel: gpt-4o\nagents:\n  - name: solo\n',
        });
        mkdirSync(join(dir, 'assets'), { recursive: true });
        const report = await validateProject({ dir });

        expect(codes(report)).toContain('assets.empty');
        expect(errors(report)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// What a run mounts
//
// The container's mounts are decided before the project is loaded, so nothing
// downstream can correct them: what is asserted here is that the file tools
// and the container are told about the same directory.
// ---------------------------------------------------------------------------

describe('what a run mounts', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-mounts-'));

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    function project(yaml: string): string {
        const dir = mkdtempSync(join(root, 'p-'));
        writeFileSync(join(dir, 'agents.yaml'), yaml, 'utf8');
        return dir;
    }

    /**
     * Remembered files reach a sandbox only through `memory_copy_file`, so a
     * box holds nothing that changes under it while it runs, and a remote one
     * has nothing of the graph's to keep in sync.
     */
    it('never mounts the memory, and does not make its directory', () => {
        const dir = project('agents:\n  - name: solo\n    memory: true\n');
        mkdirSync(join(dir, 'assets'));
        const mounts = projectMounts(dir, readProjectConfig(dir).config);
        expect(mounts.map((m) => m.at)).toEqual(['/assets']);
        expect(mounts.some((m) => m.at === MEMORY_MOUNT)).toBe(false);
        expect(existsSync(join(dir, 'memory'))).toBe(false);
    });
});

describe('choosing the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-workspace-'));

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const session = sessionPaths(root, stamp());

    it('does not warn when --workspace is explicitly passed', async () => {
        let stderr = '';
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderr += String(chunk);
            return true;
        });
        try {
            const target = await chooseWorkspace(session, {
                cwd: root,
                workspace: 'outside',
                yes: true,
            });
            expect(target).toBe(join(root, 'outside'));
            expect(stderr).not.toContain('the agent will be able to read and write');
        } finally {
            spy.mockRestore();
        }
    });

    it('warns when workspace is chosen implicitly', async () => {
        let stderr = '';
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            stderr += String(chunk);
            return true;
        });
        const chooseSpy = vi.spyOn(term, 'choose').mockResolvedValue(root);
        const confirmSpy = vi.spyOn(term, 'confirm').mockResolvedValue(true);
        const interactiveSpy = vi.spyOn(term, 'isInteractive').mockReturnValue(true);
        try {
            const target = await chooseWorkspace(session, {
                cwd: root,
                yes: true,
            });
            expect(target).toBe(root);
            expect(stderr).toContain(`the agent will be able to read and write ${root}`);
        } finally {
            spy.mockRestore();
            chooseSpy.mockRestore();
            confirmSpy.mockRestore();
            interactiveSpy.mockRestore();
        }
    });

    it('takes the session workspace without asking when told not to ask', async () => {
        const chooseSpy = vi.spyOn(term, 'choose');
        const interactiveSpy = vi.spyOn(term, 'isInteractive').mockReturnValue(true);
        try {
            const target = await chooseWorkspace(session, { cwd: root, ask: false, yes: true });
            expect(target).toBe(resolve(session.workspace));
            expect(chooseSpy).not.toHaveBeenCalled();
        } finally {
            chooseSpy.mockRestore();
            interactiveSpy.mockRestore();
        }
    });
});

describe('a run request in a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-request-'));
    const base = join(root, 'cases');

    // The smallest thing that is really a PNG, so the extension is not a lie.
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );

    beforeEach(() => {
        mkdirSync(base, { recursive: true });
        writeFileSync(join(base, 'shot.png'), png);
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const parse = (body: unknown): ReturnType<typeof parseRequest> =>
        parseRequest(JSON.stringify(body), base, 'case.json');

    it('takes a plain string as the whole input', () => {
        expect(parse({ input: 'what changed?' }).input).toBe('what changed?');
    });

    it('inlines a local image relative to the file, not the cwd', () => {
        const parts = parse({
            input: [{ text: 'what is this?' }, { image: './shot.png' }],
        }).input;
        expect(parts).toEqual([
            { type: 'text', text: 'what is this?' },
            {
                type: 'image',
                url: `data:image/png;base64,${png.toString('base64')}`,
                mimeType: 'image/png',
            },
        ]);
    });

    it('leaves a url the model can already fetch alone', () => {
        expect(parse({ input: [{ image: 'https://example.com/a.png' }] }).input).toEqual([
            { type: 'image', url: 'https://example.com/a.png', mimeType: undefined },
        ]);
        expect(parse({ input: [{ file: 'data:text/plain;base64,aGk=' }] }).input).toEqual([
            { type: 'file', url: 'data:text/plain;base64,aGk=', mimeType: undefined },
        ]);
    });

    it('accepts the canonical part shape as well as the shorthand', () => {
        expect(parse({ input: ['bare', { type: 'text', text: 'typed' }] }).input).toEqual([
            { type: 'text', text: 'bare' },
            { type: 'text', text: 'typed' },
        ]);
    });

    it('asks for a mimeType rather than guessing one', () => {
        writeFileSync(join(base, 'thing.xyz'), 'hi');
        expect(() => parse({ input: [{ file: './thing.xyz' }] })).toThrow(/nothing known about/);
        expect(parse({ input: [{ file: './thing.xyz', mimeType: 'text/plain' }] }).input).toEqual([
            { type: 'file', url: 'data:text/plain;base64,aGk=', mimeType: 'text/plain' },
        ]);
    });

    it('names the field it could not read', () => {
        expect(() => parse({ workspace: './ws' })).toThrow(/no "input"/);
        expect(() => parse({ input: [{ nope: 1 }] })).toThrow(/input\[0\]/);
        expect(() => parse({ input: [{ image: './missing.png' }] })).toThrow(/cannot read/);
        expect(() => parse({ input: 7 })).toThrow(/"input" must be/);
        expect(() => parseRequest('{', base, 'case.json')).toThrow(/case\.json/);
    });

    it('resolves paths against the file but leaves a project name alone', () => {
        const req = parse({
            input: 'hi',
            project: 'acme',
            workspace: './ws',
            memory: '../mem',
        });
        expect(req.project).toBe('acme');
        expect(req.workspace).toBe(join(base, 'ws'));
        expect(req.memory).toBe(join(root, 'mem'));
        expect(parse({ input: 'hi', project: './other' }).project).toBe(join(base, 'other'));
    });

    it('reads a piped request against the cwd, because there is no file', async () => {
        const req = await readRequest('-', base, '{"input":"hi","workspace":"./ws"}');
        expect(req.workspace).toBe(join(base, 'ws'));
        expect(req.input).toBe('hi');
    });

    it('reads a file and resolves its images from beside it', async () => {
        writeFileSync(join(base, 'case.json'), JSON.stringify({ input: [{ image: 'shot.png' }] }));
        const req = await readRequest('cases/case.json', root);
        expect(req.input).toEqual([
            {
                type: 'image',
                url: `data:image/png;base64,${png.toString('base64')}`,
                mimeType: 'image/png',
            },
        ]);
    });
});

describe('when a project was last used', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-used-'));

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    function project(sessions: Record<string, string[]>): string {
        const dir = mkdtempSync(join(root, 'p-'));
        for (const [id, runs] of Object.entries(sessions)) {
            mkdirSync(join(dir, 'sessions', id), { recursive: true });
            for (const run of runs) {
                mkdirSync(join(dir, 'sessions', id, 'runs', run), { recursive: true });
            }
        }
        return dir;
    }

    it('is the newest run, not the newest session', () => {
        // A session opened and left empty is newer than the one that did the
        // work, and would otherwise date the project to now.
        const dir = project({
            '20260101-090000-aaaa': ['20260110-120000-cccc'],
            '20260105-090000-bbbb': [],
        });
        expect(lastUsedAt(dir)).toBe('20260110-120000-cccc');
    });

    it('falls back to the session for one that never ran', () => {
        const dir = project({ '20260105-090000-bbbb': [] });
        expect(lastUsedAt(dir)).toBe('20260105-090000-bbbb');
    });

    it('has no answer for a project nobody has opened', () => {
        expect(lastUsedAt(project({}))).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// What `zen init` writes
//
// What is worth asserting about a scaffold is that the project it produces is
// one `zen check` passes, that the specification it writes describes that
// project and not a different one, and that what is meant to be run can be.
// Everything else - which files, in what order - is the scaffold's business
// and changes with it.
// ---------------------------------------------------------------------------

describe('the scaffold', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-scaffold-'));

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('writes a Dockerfile, names it, and passes its own check', async () => {
        const dir = join(root, 'fresh');
        mkdirSync(dir, { recursive: true });
        const written = scaffold({ dir, model: 'gpt-4o' });

        expect(written.files).toContain(join('sandbox', 'Dockerfile'));
        // The editor's files are written, but they are not what was created.
        expect(
            written.files.filter((f) => f.startsWith('.github') || f.startsWith('.vscode')),
        ).toEqual([]);
        expect(written.editor).toContain(join('.vscode', 'settings.json'));
        const dockerfile = readFileSync(join(dir, 'sandbox', 'Dockerfile'), 'utf8');
        expect(dockerfile).toMatch(/^FROM /m);
        // The tools in the container are the ones that wrote the project.
        expect(dockerfile).toContain(`@zenera/cli@${await versionOf(cliManifest)}`);
        expect(readFileSync(join(dir, 'agents.yaml'), 'utf8')).toContain(
            'dockerfile: sandbox/Dockerfile',
        );

        // The one part that would run something is off: what is under test is
        // the project, not the container engine on whatever machine this is.
        const report = await validateProject({ dir, sandbox: { enabled: false } });
        expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
        expect(report.sandbox.dockerfile).toBe('sandbox/Dockerfile');
    });

    /**
     * A skill's folder name is the slash command the editor offers, so renaming
     * one unbinds every mention of it in the help text, the docs and the
     * skills without breaking anything that compiles.
     */
    it('ships the commands the editor offers as slash commands', async () => {
        const dir = join(root, 'prompts');
        mkdirSync(dir, { recursive: true });
        const written = scaffold({ dir, model: 'gpt-4o' });

        for (const name of [
            'analyze',
            'dataset',
            'finetune',
            'new-agent',
            'new-skill',
            'project-review',
            'spec-apply-feedback',
            'spec-edit',
            'spec-sync-project',
        ]) {
            const path = join('.github', 'skills', name, 'SKILL.md');
            expect(written.editor).toContain(path);
            const text = readFileSync(join(dir, path), 'utf8');
            expect(text).toContain(`\nname: ${name}\n`);
            // Typed by a person, never loaded by the model on a hunch.
            expect(text).toContain('\ndisable-model-invocation: true\n');
        }
        expect(existsSync(join(dir, '.github', 'prompts'))).toBe(false);

        // The `zen-*` skills are the model's; the tuning loop's one is nobody's to type.
        const listed = await listPrompts(dir);
        expect(listed).toContain('spec-edit');
        expect(listed.filter((n) => n.startsWith('zen-'))).toEqual([]);
        for (const skill of readdirSync(join(dir, '.github', 'skills'))) {
            if (skill.startsWith('zen-')) {
                expect(
                    readFileSync(join(dir, '.github', 'skills', skill, 'SKILL.md'), 'utf8'),
                ).toContain('\nuser-invocable: false\n');
            }
        }
    });

    /**
     * Copilot dropped prompt files, so the copies an older `zen` wrote would
     * offer a second, stale `/name`. A prompt file of the project's own stays.
     */
    it('retires the prompt files it used to ship, and only those', () => {
        const dir = join(root, 'retired');
        const prompts = join(dir, '.github', 'prompts');
        mkdirSync(prompts, { recursive: true });
        writeFileSync(join(prompts, 'spec-edit.prompt.md'), 'old\n');
        writeFileSync(join(prompts, 'mine.prompt.md'), 'mine\n');

        expect(editorFiles(dir)).toContain(join('.github', 'prompts', 'spec-edit.prompt.md'));
        expect(readdirSync(prompts)).toEqual(['mine.prompt.md']);

        rmSync(join(prompts, 'mine.prompt.md'));
        writeFileSync(join(prompts, 'analyze.prompt.md'), 'old\n');
        editorFiles(dir);
        expect(existsSync(prompts)).toBe(false);
    });

    /** It is the project's file once written, and editing it is the point. */
    it('leaves an edited Dockerfile alone', () => {
        const dir = join(root, 'edited');
        mkdirSync(join(dir, 'sandbox'), { recursive: true });
        writeFileSync(join(dir, 'sandbox', 'Dockerfile'), 'FROM mine\n');
        scaffold({ dir, model: 'gpt-4o' });

        expect(readFileSync(join(dir, 'sandbox', 'Dockerfile'), 'utf8')).toBe('FROM mine\n');
    });

    /**
     * The specification describes the project it was written next to, so what
     * it says about tools has to follow the tools that were actually granted.
     */
    it('specifies the web only when the web is granted', () => {
        const dry = join(root, 'dry');
        mkdirSync(dry, { recursive: true });
        scaffold({ dir: dry, model: 'gpt-4o' });
        const withoutWeb = readFileSync(join(dry, 'SPECIFICATION.md'), 'utf8');

        const wet = join(root, 'wet');
        mkdirSync(wet, { recursive: true });
        scaffold({ dir: wet, model: 'gpt-4o', web: true });
        const withWeb = readFileSync(join(wet, 'SPECIFICATION.md'), 'utf8');

        // Nothing is left holding a placeholder open in either of them.
        expect(withoutWeb).not.toContain('{{');
        expect(withWeb).not.toContain('{{');

        expect(withoutWeb).not.toMatch(/web/i);
        expect(withWeb).toMatch(/web/i);
        // A granted tool no prompt mentions is a tool nothing uses.
        expect(readFileSync(join(wet, 'agents.yaml'), 'utf8')).toContain('exa:*');
        expect(readFileSync(join(wet, 'agents', 'prompts', 'default.md'), 'utf8')).toMatch(/web/i);
    });

    /**
     * The setup script is copied rather than generated, which is how it loses
     * its executable bit; and a script nobody can run is one nobody runs.
     */
    it('writes a setup script that runs, twice, from anywhere', () => {
        const dir = join(root, 'setup');
        mkdirSync(dir, { recursive: true });
        const written = scaffold({ dir, model: 'gpt-4o' });
        const script = join(dir, 'scripts', '_setup.sh');

        expect(written.files).toContain(join('scripts', '_setup.sh'));
        expect(statSync(script).mode & 0o777).toBe(0o755);

        // It cd's to the project itself, so where it is called from is not a
        // thing anyone has to know. Twice, because it has to stay safe to redo.
        const run = (): string => execFileSync(script, { cwd: tmpdir(), encoding: 'utf8' });
        expect(run()).toBe(run());
    });

    /**
     * `--check` answers the question `zen check` cannot reach - an index is not
     * something `agents.yaml` declares - so it has to say what is missing
     * without paying the download and the embedding to find out.
     */
    it('answers --check without doing the work, and refuses a flag it does not know', () => {
        const dir = join(root, 'setup-check');
        mkdirSync(dir, { recursive: true });
        scaffold({ dir, model: 'gpt-4o' });
        const script = join(dir, 'scripts', '_setup.sh');

        // A fresh scaffold has no steps, so the dry run agrees with the real one.
        const at = (...args: string[]): string =>
            execFileSync(script, args, { cwd: tmpdir(), encoding: 'utf8' });
        expect(at('--check')).toBe(at());

        let code: number | undefined;
        try {
            execFileSync(script, ['--nope'], { cwd: tmpdir(), stdio: 'pipe' });
        } catch (err) {
            code = (err as { status?: number }).status;
        }
        expect(code).toBe(2);
    });

    /**
     * The runner's half of the bargain: a step that reports it is not done must
     * not stop the walk the way a failure does, or the first unbuilt thing
     * hides everything behind it and the list is read twice.
     */
    it('names every step that needs setup, not just the first', () => {
        const dir = join(root, 'setup-pending');
        mkdirSync(dir, { recursive: true });
        scaffold({ dir, model: 'gpt-4o' });
        const script = join(dir, 'scripts', '_setup.sh');
        writeFileSync(script, readFileSync(script, 'utf8').replace('STEPS=""', 'STEPS="one two"'));
        for (const [name, code] of [
            ['one', 4],
            ['two', 3],
        ] as const) {
            const step = join(dir, 'scripts', `${name}.sh`);
            writeFileSync(step, `#!/usr/bin/env bash\necho "${name} spoke"\nexit ${code}\n`);
            chmodSync(step, 0o755);
        }

        // Non-zero overall, which is what makes it usable as a gate.
        let out: string;
        try {
            out = execFileSync(script, ['--check'], { cwd: tmpdir(), encoding: 'utf8' });
            expect.unreachable('a pending step should exit non-zero');
        } catch (err) {
            out = (err as { stdout: string }).stdout;
        }
        expect(out).toContain('one: needs setup');
        expect(out).toContain('two spoke');
        expect(out).toContain('two: skipped');
    });

    /**
     * A file the project needs and git must never see. It cannot be stored
     * under its own name - this repository ignores `.env` too - so the one
     * thing worth pinning is that it arrives with the dot on.
     */
    it('writes .env and .env.test, ignored, beside a committed .env.example', () => {
        const dir = join(root, 'env');
        mkdirSync(dir, { recursive: true });
        const written = scaffold({ dir, model: 'gpt-4o' });

        expect(written.files).toContain('.env');
        expect(written.files).toContain('.env.test');
        expect(readFileSync(join(dir, '.env'), 'utf8')).not.toContain('{{');
        const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
        expect(ignore).toMatch(/^\.env$/m);
        expect(ignore).toMatch(/^\.env\.test$/m);

        // Committed, so it holds names and no values, and nothing ignores it.
        expect(written.files).toContain('.env.example');
        expect(readFileSync(join(dir, '.env.example'), 'utf8')).not.toMatch(/^[A-Z_]+=\S/m);
        expect(ignore).not.toContain('.env.example');
    });

    it('leaves a filled-in .env alone', () => {
        const dir = join(root, 'filled');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '.env'), 'ACME_TOKEN=mine\n');
        scaffold({ dir, model: 'gpt-4o' });

        expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('ACME_TOKEN=mine\n');
    });

    /**
     * The record `/spec-sync-project` works from: two directories the project
     * commits, empty because what marks a completed pass is the manifest
     * inside them, and the script that writes it - executable, and at the path
     * the prompt tells the agent to run.
     */
    it('makes room for the spec-sync record, and ships the script that writes it', () => {
        const dir = join(root, 'spec-sync');
        mkdirSync(dir, { recursive: true });
        const written = scaffold({ dir, model: 'gpt-4o' });
        const script = join('.github', 'skills', 'zen-spec-sync', 'scripts', 'snapshot.sh');

        expect(readdirSync(join(dir, '.spec-sync', 'baseline'))).toEqual([]);
        expect(readdirSync(join(dir, '.spec-sync', 'history'))).toEqual([]);
        // A record only this machine has is not a record.
        expect(readFileSync(join(dir, '.gitignore'), 'utf8')).not.toContain('.spec-sync');

        expect(written.editor).toContain(join('.github', 'skills', 'zen-spec-sync', 'SKILL.md'));
        expect(written.editor).toContain(script);
        expect(statSync(join(dir, script)).mode & 0o777).toBe(0o755);
        // The command sends the agent to that path, so the two have to agree.
        expect(
            readFileSync(join(dir, '.github', 'skills', 'spec-sync-project', 'SKILL.md'), 'utf8'),
        ).toContain(script);

        // Called from anywhere, and honest about a project that has never had
        // a pass: there is nothing to diff against yet.
        expect(
            execFileSync(join(dir, script), ['status'], { cwd: tmpdir(), encoding: 'utf8' }),
        ).toContain('mode: full');
    });

    /**
     * The record covers the implementation as well as the intent, so a prompt,
     * skill or house rule edited between passes is a change the next pass has
     * to account for rather than one nothing reports.
     */
    it('records the implementation too, so a hand-edited house rule reads as a change', () => {
        const dir = join(root, 'spec-sync-tree');
        mkdirSync(dir, { recursive: true });
        scaffold({ dir, model: 'gpt-4o' });
        const script = join(dir, '.github', 'skills', 'zen-spec-sync', 'scripts', 'snapshot.sh');
        const run = (arg: string) =>
            execFileSync(script, [arg], { cwd: tmpdir(), encoding: 'utf8' });

        writeFileSync(join(dir, '.spec-sync', 'history', '2026-09-13T104500Z.md'), '# pass\n');
        run('commit');
        expect(existsSync(join(dir, '.spec-sync', 'baseline', 'agents', 'instructions.md'))).toBe(
            true,
        );
        expect(run('status')).toContain('mode: incremental');

        writeFileSync(join(dir, 'agents', 'instructions.md'), 'rewritten by hand\n');
        expect(run('status')).toContain('changed: agents/instructions.md');
        expect(run('diff')).toContain('rewritten by hand');
    });

    /**
     * The checks a review makes by rote, shipped as scripts rather than as
     * commands to retype. `.github/` is ours and is rewritten on every `init`
     * and `open`, so the distribution is the only place they can come from and
     * still be there next time.
     */
    it('ships the review scripts, runnable from anywhere', () => {
        const dir = join(root, 'review');
        mkdirSync(dir, { recursive: true });
        const written = scaffold({ dir, model: 'gpt-4o' });
        const entry = join('.github', 'skills', 'zen-review', 'scripts', 'review.sh');
        const paths = join('.github', 'skills', 'zen-review', 'scripts', 'check-paths.sh');

        expect(written.editor).toContain(join('.github', 'skills', 'zen-review', 'SKILL.md'));
        for (const script of [entry, paths]) {
            expect(written.editor).toContain(script);
            expect(statSync(join(dir, script)).mode & 0o777).toBe(0o755);
        }
        // The command sends the agent to the entry point, so the two must agree.
        expect(
            readFileSync(join(dir, '.github', 'skills', 'project-review', 'SKILL.md'), 'utf8'),
        ).toContain(entry);

        const run = (script: string) =>
            spawnSync(join(dir, script), { cwd: tmpdir(), encoding: 'utf8' });

        // A project as `zen init` leaves it has nothing to report.
        expect(run(paths).status).toBe(0);

        // A path outside the four mounts is a finding, and says where it is.
        writeFileSync(join(dir, 'agents', 'prompts', 'default.md'), 'Read /tmp/x.txt first.\n');
        const swept = run(paths);
        expect(swept.status).toBe(1);
        expect(swept.stdout).toContain('path: /tmp/x.txt');
        expect(swept.stdout).toContain('agents/prompts/default.md:1');
    });
});

// ---------------------------------------------------------------------------
// The project's own environment
//
// Two things to hold: the real environment still wins, and the names come back
// whole. The second is what the sandbox forwards, and a name dropped because
// the shell happened to answer it first is a variable missing inside the
// container for reasons nobody could reconstruct.
// ---------------------------------------------------------------------------

describe("a project's .env", () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-env-'));
    const names = ['ZEN_TEST_SET', 'ZEN_TEST_UNSET', 'ZEN_TEST_BLANK'];

    afterAll(() => rmSync(root, { recursive: true, force: true }));
    afterEach(() => {
        for (const name of [...names, 'GOOGLE_APPLICATION_CREDENTIALS', 'ZEN_ENV_FILE']) {
            delete process.env[name];
        }
    });

    it('fills the gaps and reports every name', () => {
        const dir = join(root, 'one');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, '.env'),
            '# a comment\nZEN_TEST_SET=from-file\nZEN_TEST_UNSET=from-file\nZEN_TEST_BLANK=from-file\n',
        );
        process.env['ZEN_TEST_SET'] = 'from-shell';
        process.env['ZEN_TEST_BLANK'] = '';

        const loaded = loadProjectEnv(dir);

        expect([...(loaded?.names ?? [])].sort()).toEqual([...names].sort());
        // What is exported wins; what is merely declared empty does not.
        expect(process.env['ZEN_TEST_SET']).toBe('from-shell');
        expect(process.env['ZEN_TEST_UNSET']).toBe('from-file');
        expect(process.env['ZEN_TEST_BLANK']).toBe('from-file');
    });

    it('says nothing about a project that has none', () => {
        const dir = join(root, 'bare');
        mkdirSync(dir, { recursive: true });

        expect(loadProjectEnv(dir)).toBeUndefined();
    });

    /**
     * `ZEN_ENV_FILE` names the one file read instead of `.env` - nothing of
     * `.env` comes through - and only reading touches nothing.
     */
    it('reads the file ZEN_ENV_FILE names, instead of .env', () => {
        const dir = join(root, 'other');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '.env'), 'ZEN_TEST_SET=real\nZEN_TEST_UNSET=real\n');
        writeFileSync(join(dir, '.env.test'), 'ZEN_TEST_SET=test\n');
        process.env['ZEN_ENV_FILE'] = '.env.test';

        const read = readProjectEnv(dir);

        expect(read?.path).toBe(join(dir, '.env.test'));
        expect(read?.values).toEqual({ ZEN_TEST_SET: 'test' });
        expect(process.env['ZEN_TEST_SET']).toBeUndefined();

        loadProjectEnv(dir);
        expect(process.env['ZEN_TEST_SET']).toBe('test');
        expect(process.env['ZEN_TEST_UNSET']).toBeUndefined();
    });

    it('does not fall back to .env when the named file is missing', () => {
        const dir = join(root, 'missing');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '.env'), 'ZEN_TEST_SET=real\n');
        process.env['ZEN_ENV_FILE'] = '.env.test';

        expect(loadProjectEnv(dir)).toBeUndefined();
        expect(process.env['ZEN_TEST_SET']).toBeUndefined();
    });

    it('reads a credential file path as relative to the project', () => {
        const dir = join(root, 'gac');
        mkdirSync(dir, { recursive: true });
        delete process.env['GOOGLE_APPLICATION_CREDENTIALS'];
        writeFileSync(
            join(dir, '.env'),
            'GOOGLE_APPLICATION_CREDENTIALS=service-account.json\nZEN_TEST_UNSET=./not-a-path\n',
        );

        loadProjectEnv(dir);

        expect(process.env['GOOGLE_APPLICATION_CREDENTIALS']).toBe(
            join(dir, 'service-account.json'),
        );
        // Only the variables that name a file are paths; the rest are values.
        expect(process.env['ZEN_TEST_UNSET']).toBe('./not-a-path');
    });
});

// ---------------------------------------------------------------------------
// The pre-flight
//
// Every process is injected, so what is under test is the order of the
// questions and what each answer leads to - which is the whole of this module.
// Each successful case uses its own image so it gets its own memo entry; a run
// only ever asks these questions once.
// ---------------------------------------------------------------------------

describe('the podman pre-flight', () => {
    const onLinux = platform() === 'linux';

    interface Fake {
        run: typeof runProcess;
        seen: string[];
        reply(match: string, res: Partial<ProcResult>): void;
    }

    const fake = (): Fake => {
        const seen: string[] = [];
        const replies: { match: string; res: Partial<ProcResult> }[] = [];
        return {
            seen,
            reply: (match, res) => void replies.push({ match, res }),
            run: (bin, args) => {
                const line = `${bin} ${args.join(' ')}`;
                seen.push(line);
                const i = replies.findIndex((r) => line.includes(r.match));
                const res = i >= 0 ? replies.splice(i, 1)[0].res : {};
                return Promise.resolve({
                    code: 0,
                    stdout: '',
                    stderr: '',
                    truncated: false,
                    timedOut: false,
                    ...res,
                });
            },
        };
    };

    /** One machine, up and running, so only the step under test is interesting. */
    const running = (f: Fake): Fake => {
        f.reply('machine list', {
            stdout: JSON.stringify([{ Name: 'podman-machine-default', Running: true }]),
        });
        return f;
    };

    it('asks in order: binary, machine, socket, image', async () => {
        const f = running(fake());
        await ensurePodmanReady({ image: 'img-order', yes: true, exec: f.run });

        const verbs = f.seen.map((l) => l.replace('podman ', ''));
        expect(verbs[0]).toBe('--version');
        expect(verbs.at(-2)).toBe('info');
        expect(verbs.at(-1)).toBe('image exists img-order');
        expect(verbs.includes('machine list --format json')).toBe(!onLinux);
    });

    it('fails with the install command for this platform, rather than hanging', async () => {
        const f = fake();
        f.reply('--version', { code: 127, stderr: 'not found' });
        await expect(
            ensurePodmanReady({ image: 'img-missing', yes: true, exec: f.run }),
        ).rejects.toMatchObject({
            code: EXIT.sandbox,
            hint: expect.stringContaining('install it'),
        });
    });

    it('creates a machine when there is none, sized as configured', async () => {
        if (onLinux) {
            return;
        }
        const f = fake();
        f.reply('machine list', { stdout: '[]' });
        await ensurePodmanReady({
            image: 'img-init',
            cpus: 4,
            memory: 8192,
            yes: true,
            exec: f.run,
        });
        expect(f.seen).toContain('podman machine init --cpus 4 --memory 8192');
        expect(f.seen.some((l) => l.startsWith('podman machine start'))).toBe(true);
    });

    it('starts a machine that exists but is stopped, and leaves a running one alone', async () => {
        if (onLinux) {
            return;
        }
        const stopped = fake();
        stopped.reply('machine list', {
            stdout: JSON.stringify([{ Name: 'other', Running: false, Starting: false }]),
        });
        await ensurePodmanReady({ image: 'img-stopped', yes: true, exec: stopped.run });
        expect(stopped.seen).toContain('podman machine start other');
        expect(stopped.seen).not.toContain('podman machine init');

        const up = running(fake());
        await ensurePodmanReady({ image: 'img-up', yes: true, exec: up.run });
        expect(up.seen.some((l) => l.includes('machine start'))).toBe(false);
    });

    it('pulls the image only when it is not already there', async () => {
        const absent = running(fake());
        absent.reply('image exists', { code: 1 });
        await ensurePodmanReady({ image: 'img-absent', yes: true, exec: absent.run });
        expect(absent.seen).toContain('podman pull img-absent');

        const present = running(fake());
        await ensurePodmanReady({ image: 'img-present', yes: true, exec: present.run });
        expect(present.seen.some((l) => l.includes('pull'))).toBe(false);
    });

    /**
     * A Dockerfile replaces the pull entirely, and is skipped once the tag is
     * on disk: the tag is a hash of the content, so the image existing means
     * the content is unchanged.
     */
    it('builds a Dockerfile instead of pulling', async () => {
        const build = { tag: 'localhost/zenera-sandbox:abc', dockerfile: '/p/D', context: '/p' };
        const f = running(fake());
        f.reply('image exists', { code: 1 });
        await ensurePodmanReady({ image: build.tag, build, yes: true, exec: f.run });

        expect(f.seen).toContain('podman build --tag localhost/zenera-sandbox:abc --file /p/D /p');
        expect(f.seen.some((l) => l.includes('pull'))).toBe(false);
    });

    it('does not rebuild a tag that is already on disk, unless asked to', async () => {
        const build = { tag: 'localhost/zenera-sandbox:cached', dockerfile: '/p/D', context: '/p' };
        const f = running(fake());
        await ensurePodmanReady({ image: build.tag, build, yes: true, exec: f.run });
        expect(f.seen).toContain('podman image exists localhost/zenera-sandbox:cached');
        expect(f.seen.some((l) => l.includes('build --tag'))).toBe(false);

        // `zen sandbox pull` is the way to catch a base image that moved.
        const forced = running(fake());
        await ensurePodmanReady({
            image: 'localhost/zenera-sandbox:forced',
            build: { ...build, tag: 'localhost/zenera-sandbox:forced' },
            rebuild: true,
            yes: true,
            exec: forced.run,
        });
        expect(forced.seen.some((l) => l.includes('build --tag'))).toBe(true);
        expect(forced.seen.some((l) => l.includes('image exists'))).toBe(false);
    });

    it('blames the Dockerfile, and quotes the end of the build log', async () => {
        const build = { tag: 'localhost/zenera-sandbox:bad', dockerfile: '/p/D', context: '/p' };
        const f = running(fake());
        f.reply('image exists', { code: 1 });
        f.reply('build --tag', { code: 1, stderr: 'STEP 2\nError: no such package: nope\n' });
        await expect(
            ensurePodmanReady({ image: build.tag, build, yes: true, exec: f.run }),
        ).rejects.toMatchObject({
            code: EXIT.sandbox,
            message: expect.stringContaining('/p/D'),
            hint: expect.stringContaining('no such package'),
        });
    });

    it('says the engine is wedged rather than blaming the image', async () => {
        const f = running(fake());
        f.reply('info', { code: 125, stderr: 'cannot connect to podman socket' });
        await expect(
            ensurePodmanReady({ image: 'img-wedged', yes: true, exec: f.run }),
        ).rejects.toMatchObject({
            code: EXIT.sandbox,
            message: expect.stringMatching(/responding/),
        });
    });

    /** Treating unreadable output as "no machines" would try to create a second one. */
    it('refuses to guess when machine list is not json', async () => {
        if (onLinux) {
            return;
        }
        const f = fake();
        f.reply('machine list', { stdout: 'podman: unknown flag --format' });
        await expect(
            ensurePodmanReady({ image: 'img-garbage', yes: true, exec: f.run }),
        ).rejects.toThrow(/machine list/);
    });

    // -----------------------------------------------------------------------
    // The connection, which is a concurrency limit in disguise
    //
    // The default `ssh://` connection is made fresh by every podman process,
    // and sshd refuses new ones past `MaxStartups` - ten - so a batch wider
    // than that loses calls at random. The machine forwards a second endpoint
    // that one long-lived connection carries for everybody; these pin down
    // that it is found, used, and never allowed to become a failure of its own.
    // -----------------------------------------------------------------------

    const inspected = (info: unknown): string => JSON.stringify([{ ConnectionInfo: info }]);
    const SOCK = '/var/folders/T/podman/podman-machine-default-api.sock';

    let held: string | undefined;
    beforeEach(() => {
        held = process.env['CONTAINER_HOST'];
        delete process.env['CONTAINER_HOST'];
    });
    afterEach(() => {
        if (held === undefined) {
            delete process.env['CONTAINER_HOST'];
        } else {
            process.env['CONTAINER_HOST'] = held;
        }
    });

    it('reads the forwarded socket as a uri', async () => {
        if (onLinux) {
            return;
        }
        const f = fake();
        f.reply('machine inspect', {
            stdout: inspected({ PodmanSocket: { Path: SOCK }, PodmanPipe: null }),
        });
        expect(await sharedEndpoint('podman', f.run)).toBe(`unix://${SOCK}`);
    });

    /** The same endpoint, spelled the way Windows spells it. */
    it('reads a named pipe as a uri', async () => {
        if (onLinux) {
            return;
        }
        const f = fake();
        f.reply('machine inspect', {
            stdout: inspected({
                PodmanSocket: null,
                PodmanPipe: { Path: '\\\\.\\pipe\\podman-machine-default' },
            }),
        });
        expect(await sharedEndpoint('podman', f.run)).toBe(
            'npipe:////./pipe/podman-machine-default',
        );
    });

    it('reports nothing rather than throwing when there is no endpoint to have', async () => {
        const f = fake();
        f.reply('machine inspect', { stdout: inspected({}) });
        expect(await sharedEndpoint('podman', f.run)).toBeUndefined();
        f.reply('machine inspect', { stdout: 'not json' });
        expect(await sharedEndpoint('podman', f.run)).toBeUndefined();
        f.reply('machine inspect', { code: 125, stderr: 'no such machine' });
        expect(await sharedEndpoint('podman', f.run)).toBeUndefined();
    });

    it('points this process at it, so parallel calls stop competing', async () => {
        if (onLinux) {
            return;
        }
        const f = running(fake());
        f.reply('machine inspect', { stdout: inspected({ PodmanSocket: { Path: SOCK } }) });
        await ensurePodmanReady({ image: 'img-shared', yes: true, exec: f.run });
        expect(process.env['CONTAINER_HOST']).toBe(`unix://${SOCK}`);
    });

    /** An optimisation never gets to be the reason a run fails. */
    it('puts the default connection back when the endpoint does not answer', async () => {
        if (onLinux) {
            return;
        }
        const f = running(fake());
        f.reply('machine inspect', { stdout: inspected({ PodmanSocket: { Path: SOCK } }) });
        f.reply('info', { code: 125, stderr: 'cannot connect' });
        await ensurePodmanReady({ image: 'img-fallback', yes: true, exec: f.run });

        expect(process.env['CONTAINER_HOST']).toBeUndefined();
        // Asked twice: once over the endpoint, once over the connection it
        // fell back to, which is the one that answered.
        expect(f.seen.filter((l) => l.endsWith(' info')).length).toBe(2);
    });

    /** Which engine to talk to is the user's decision, not a throughput one. */
    it('leaves a CONTAINER_HOST that was already set alone', async () => {
        if (onLinux) {
            return;
        }
        process.env['CONTAINER_HOST'] = 'tcp://elsewhere:2375';
        const f = running(fake());
        f.reply('machine inspect', { stdout: inspected({ PodmanSocket: { Path: SOCK } }) });
        await ensurePodmanReady({ image: 'img-theirs', yes: true, exec: f.run });

        expect(process.env['CONTAINER_HOST']).toBe('tcp://elsewhere:2375');
        expect(f.seen.some((l) => l.includes('machine inspect'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The disk report
//
// `zen sandbox disk` answers a question people ask after seeing a long list of
// stopped containers, and the answer is only useful if it keeps two disks
// apart: what the engine holds inside its machine, and what a project holds in
// its own directory. Removing a container reclaims one of them.
// ---------------------------------------------------------------------------

describe('the disk report', () => {
    const reply = (stdout: string, code = 0): typeof runProcess => {
        return () =>
            Promise.resolve({ code, stdout, stderr: '', truncated: false, timedOut: false });
    };

    const ps = JSON.stringify([
        {
            Names: ['zn-old-aaaaaaaaaa'],
            State: 'exited',
            Created: 1_700_000_000,
            Labels: { zenera: '1', 'zenera.key': '20260827-213141-fa7d' },
            Size: { rootFsSize: 100_000_000, rwSize: 64_900_000 },
        },
        {
            Names: ['zn-new-bbbbbbbbbb'],
            State: 'running',
            Created: 1_800_000_000,
            Labels: { zenera: '1', 'zenera.key': '20260901-132913-2eac' },
        },
    ]);

    it('reads a listing as json, newest first, keeping the session label', async () => {
        const found = await ownedContainers('podman', reply(ps));
        expect(found.map((c) => c.name)).toEqual(['zn-new-bbbbbbbbbb', 'zn-old-aaaaaaaaaa']);
        expect(found[0].state).toBe('running');
        expect(found[1].key).toBe('20260827-213141-fa7d');
        expect(found[1].size).toBe(64_900_000);
    });

    it('only pays for sizes when they are asked for', async () => {
        const seen: string[] = [];
        const run: typeof runProcess = (bin, args) => {
            seen.push(args.join(' '));
            return reply(ps)(bin, args, {});
        };
        await ownedContainers('podman', run);
        await ownedContainers('podman', run, { sizes: true });
        expect(seen[0]).not.toContain('--size');
        expect(seen[1]).toContain('--size');
    });

    it('reads a listing far past the default output cap', async () => {
        // Through the real runner's cap logic: ~1 kB a container, 2048 of them.
        const many = JSON.stringify(
            Array.from({ length: 2048 }, (_, i) => ({
                Names: [`zn-${i}-${'x'.repeat(1000)}`],
                State: 'exited',
                Labels: { zenera: '1' },
            })),
        );
        let cap = 0;
        const run: typeof runProcess = (bin, args, opts) => {
            cap = opts?.maxBytes ?? 64 * 1024;
            return reply(many.slice(0, cap))(bin, args, {});
        };
        expect(await ownedContainers('podman', run)).toHaveLength(2048);
        expect(cap).toBeGreaterThan(many.length);
    });

    describe('engine locks', () => {
        /** Answers by verb: `info` the free count, `container exists` the reuse, `ps` the listing. */
        const engine = (free: string, exists = 1): typeof runProcess => {
            return (bin, args) => {
                if (args[0] === 'info') return reply(free)(bin, args, {});
                if (args[0] === 'container') return reply('', exists)(bin, args, {});
                return reply(ps)(bin, args, {});
            };
        };

        it('lets a run through while there are enough', async () => {
            await expect(assertLocks(4, { exec: engine('4') })).resolves.toBeUndefined();
        });

        it('says nothing when the engine will not tell', async () => {
            await expect(assertLocks(4, { exec: engine('') })).resolves.toBeUndefined();
        });

        it('refuses a run the engine cannot hold, naming what could be freed', async () => {
            await expect(
                assertLocks(4, { exec: engine('3'), owners: new Map() }),
            ).rejects.toMatchObject({
                code: EXIT.sandbox,
                message: expect.stringContaining('3 locks free and this run needs 4'),
                hint: 'zen sandbox clean --idle frees 1',
            });
        });

        it('counts a running container as idle once its run is gone', () => {
            const dir = mkdtempSync(join(tmpdir(), 'zen-idle-'));
            try {
                const running = (key: string): OwnedContainer => ({
                    name: `zn-${key}`,
                    state: 'running',
                    key,
                });
                const owners = new Map([['20260901-132913-2eac', dir]]);
                const all = [
                    { name: 'zn-old', state: 'exited', key: 'x' },
                    running('20260901-132913-2eac'),
                    running('20990101-000000-none'),
                    running(`gym-${process.pid}`),
                    running('gym-999999'),
                ];
                // No lock in the session: its run exited without cleaning up.
                expect(idleContainers(all, owners).map((c) => c.name)).toEqual([
                    'zn-old',
                    'zn-20260901-132913-2eac',
                    'zn-gym-999999',
                ]);
                writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: process.pid }));
                expect(idleContainers(all, owners).map((c) => c.name)).toEqual([
                    'zn-old',
                    'zn-gym-999999',
                ]);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('lets a resumed session back into its own container at zero', async () => {
            await expect(
                assertLocks(1, { exec: engine('0', 0), reuses: 'zn-old-aaaaaaaaaa' }),
            ).resolves.toBeUndefined();
            await expect(
                assertLocks(1, { exec: engine('0', 1), reuses: 'zn-gone' }),
            ).rejects.toMatchObject({ code: EXIT.sandbox });
        });
    });

    it('reports nothing rather than throwing when the engine talks nonsense', async () => {
        expect(await ownedContainers('podman', reply('not json'))).toEqual([]);
        expect(await engineDisk('podman', reply('not json'))).toBeUndefined();
        expect(await engineDisk('podman', reply('', 1))).toBeUndefined();
    });

    it('separates what is used from what could be reclaimed', async () => {
        const df = JSON.stringify([
            { Type: 'Images', TotalCount: 10, Active: 3, RawSize: 665, RawReclaimable: 600 },
            { Type: 'Containers', TotalCount: 9, Active: 0, RawSize: 72, RawReclaimable: 72 },
            { Type: 'Local Volumes', TotalCount: 0, Active: 0, RawSize: 0, RawReclaimable: 0 },
        ]);
        const usage = await engineDisk('podman', reply(df));
        expect(usage?.images).toEqual({ count: 10, active: 3, size: 665, reclaimable: 600 });
        expect(usage?.containers.count).toBe(9);
        expect(usage?.volumes.size).toBe(0);
    });

    it('measures a tree in the blocks it occupies', () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-size-'));
        try {
            expect(dirSize(dir)).toBe(0);
            mkdirSync(join(dir, 'deep'));
            writeFileSync(join(dir, 'deep', 'file'), 'x'.repeat(10_000));
            const size = dirSize(dir);
            expect(size).toBeGreaterThanOrEqual(10_000);
            expect(size % 512).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prints sizes in the units the engine prints them in', () => {
        expect(bytes(0)).toBe('0 B');
        expect(bytes(999)).toBe('999 B');
        expect(bytes(1000)).toBe('1.0 kB');
        expect(bytes(11_332)).toBe('11.3 kB');
        expect(bytes(72_366_052)).toBe('72.4 MB');
        expect(bytes(665_426_572)).toBe('665 MB');
    });
});

// ---------------------------------------------------------------------------
// The sandbox check
//
// `zen check` is the one command that both reads and runs: a Dockerfile that
// does not build is a broken project, and only building it says so. The engine
// is injected here, so what these cases pin down is when it is asked and what
// each answer is reported as - in particular that a machine with no podman on
// it still gets a passing report, because that is the machine most likely to
// be running the check.
//
// Every case writes a different Dockerfile so it gets a different tag, and so
// its own entry in the pre-flight's memo.
// ---------------------------------------------------------------------------

describe('the sandbox check', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-sandbox-check-'));
    let n = 0;

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** A project that builds its own image and has an agent that can use it. */
    const project = (dockerfile: string, tools = 'sandbox:*'): string => {
        const dir = join(root, `p${n++}`);
        mkdirSync(join(dir, 'sandbox'), { recursive: true });
        writeFileSync(join(dir, 'sandbox', 'Dockerfile'), dockerfile);
        writeFileSync(
            join(dir, 'agents.yaml'),
            'version: 1\nmodel: gpt-4o\n' +
                'sandbox:\n    build:\n        dockerfile: sandbox/Dockerfile\n' +
                `agents:\n  - name: solo\n    tools: [${tools}]\n`,
        );
        return dir;
    };

    /** A working engine that has never seen this project's image before. */
    const engine = (): { run: typeof runProcess; seen: string[] } => {
        const seen: string[] = [];
        return {
            seen,
            run: (bin, args) => {
                const line = `${bin} ${args.join(' ')}`;
                seen.push(line);
                const res: Partial<ProcResult> = line.includes('machine list')
                    ? { stdout: JSON.stringify([{ Name: 'default', Running: true }]) }
                    : line.includes('image exists')
                      ? { code: 1 }
                      : line.includes('/bin/sh')
                        ? { stdout: 'zen-check\n/workspace\n' }
                        : {};
                return Promise.resolve({
                    code: 0,
                    stdout: '',
                    stderr: '',
                    truncated: false,
                    timedOut: false,
                    ...res,
                });
            },
        };
    };

    const of = (report: Report, severity: string): string[] =>
        report.findings.filter((f) => f.severity === severity).map((f) => f.code);

    it('builds the image, runs a command in it, and takes the container away', async () => {
        const e = engine();
        const report = await validateProject({
            dir: project('FROM scratch # happy\n'),
            sandbox: { enabled: true, exec: e.run },
        });

        expect(of(report, 'error')).toEqual([]);
        expect(report.sandbox.probed).toBe(true);
        expect(report.sandbox.dockerfile).toBe('sandbox/Dockerfile');
        expect(report.sandbox.image).toMatch(/^localhost\/zenera-sandbox:[0-9a-f]+$/);
        expect(e.seen.some((l) => l.includes('build --tag'))).toBe(true);
        // Whatever else happened, nothing is left running.
        expect(e.seen.some((l) => l.includes('rm --force'))).toBe(true);
    });

    it('reports a Dockerfile that does not build as an error', async () => {
        const e = engine();
        const failing: typeof runProcess = (bin, args, opts) =>
            args[0] === 'build'
                ? Promise.resolve({
                      code: 1,
                      stdout: '',
                      stderr: 'Error: nope',
                      truncated: false,
                      timedOut: false,
                  })
                : e.run(bin, args, opts);

        const report = await validateProject({
            dir: project('FROM scratch # broken\n'),
            sandbox: { enabled: true, exec: failing },
        });

        expect(report.ok).toBe(false);
        expect(of(report, 'error')).toContain('sandbox.build');
        expect(report.sandbox.probed).toBe(false);
    });

    /** The check has to be useful on the machine that is not set up yet. */
    it('warns, rather than failing, when there is no container engine', async () => {
        const absent: typeof runProcess = () =>
            Promise.resolve({
                code: 127,
                stdout: '',
                stderr: 'command not found',
                truncated: false,
                timedOut: false,
            });

        const report = await validateProject({
            dir: project('FROM scratch # no engine\n'),
            sandbox: { enabled: true, exec: absent },
        });

        expect(report.ok).toBe(true);
        expect(of(report, 'error')).toEqual([]);
        expect(of(report, 'warning')).toContain('sandbox.unchecked');
        expect(report.sandbox.probed).toBe(false);
    });

    it('says a container started but could not be worked in', async () => {
        const e = engine();
        const mute: typeof runProcess = (bin, args, opts) =>
            args.includes('/bin/sh')
                ? Promise.resolve({
                      code: 1,
                      stdout: '',
                      stderr: 'sh: cannot create zen-check.txt: read-only file system',
                      truncated: false,
                      timedOut: false,
                  })
                : e.run(bin, args, opts);

        const report = await validateProject({
            dir: project('FROM scratch # read only\n'),
            sandbox: { enabled: true, exec: mute },
        });

        expect(of(report, 'error')).toContain('sandbox.smoke');
        expect(report.sandbox.probed).toBe(false);
    });

    it('touches nothing when the check is asked not to', async () => {
        const e = engine();
        const report = await validateProject({
            dir: project('FROM scratch # skipped\n'),
            sandbox: { enabled: false, exec: e.run },
        });

        expect(e.seen).toEqual([]);
        expect(report.sandbox.probed).toBe(false);
        // The files it names are still checked; only the building is skipped.
        expect(report.sandbox.dockerfile).toBe('sandbox/Dockerfile');
    });

    /** Nothing is gained by building an image no agent can reach a shell in. */
    it('skips the build when no agent has the shell tools', async () => {
        const e = engine();
        const report = await validateProject({
            dir: project('FROM scratch # unused\n', 'workspace:*'),
            sandbox: { enabled: true, exec: e.run },
        });

        expect(e.seen).toEqual([]);
        expect(report.sandbox.used).toBe(false);
    });

    it('names the missing file when the Dockerfile is not there', async () => {
        const dir = join(root, `p${n++}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'agents.yaml'),
            'version: 1\nmodel: gpt-4o\n' +
                'sandbox:\n    build:\n        dockerfile: sandbox/Dockerfile\n' +
                'agents:\n  - name: solo\n    tools: [sandbox:*]\n',
        );

        const e = engine();
        const report = await validateProject({ dir, sandbox: { enabled: true, exec: e.run } });

        expect(of(report, 'error')).toContain('sandbox.dockerfile.missing');
        // A file that is not there cannot be built, so the engine is never asked.
        expect(e.seen.some((l) => l.includes('build'))).toBe(false);
    });

    /**
     * The pin `zen init` wrote is never rewritten afterwards, so the only thing
     * standing between an upgraded host and a container holding an older `zen`
     * is this reading - which is why it does not need the engine.
     */
    describe('the `@zenera/*` pin in the Dockerfile', () => {
        const dockerfile = (install: string): string =>
            `FROM scratch\n# bump @zenera/cli and @zenera/rag together\nRUN npm install -g ${install}\n`;

        it('says nothing when the pin is this `zen`', async () => {
            const mine = await versionOf(cliManifest);
            const report = await validateProject({
                dir: project(dockerfile(`@zenera/cli@${mine} @zenera/rag@${mine}`)),
                sandbox: { enabled: false },
            });

            expect(of(report, 'warning')).not.toContain('sandbox.pin.stale');
            expect(of(report, 'warning')).not.toContain('sandbox.pin.absent');
        });

        it('warns when the pin has fallen behind the host, and names both packages', async () => {
            const report = await validateProject({
                dir: project(dockerfile('@zenera/cli@0.0.1 @zenera/rag@0.0.1')),
                sandbox: { enabled: false },
            });

            // It loads and it builds; only the `zen` inside it is the wrong one.
            expect(of(report, 'error')).toEqual([]);
            expect(of(report, 'warning')).toContain('sandbox.pin.stale');
            const stale = report.findings.find((f) => f.code === 'sandbox.pin.stale')!;
            expect(stale.where).toBe('sandbox/Dockerfile');
            expect(stale.message).toContain('@zenera/cli@0.0.1');
            expect(stale.message).toContain('@zenera/rag@0.0.1');
            expect(stale.fix).toContain(await versionOf(cliManifest));
        });

        it('warns when the package is named with no version at all', async () => {
            const report = await validateProject({
                dir: project(dockerfile('@zenera/cli')),
                sandbox: { enabled: false },
            });

            expect(of(report, 'warning')).toContain('sandbox.pin.absent');
            expect(of(report, 'warning')).not.toContain('sandbox.pin.stale');
        });

        it('reads the pin, not the prose about it', async () => {
            const report = await validateProject({
                dir: project('FROM scratch\n# installs @zenera/cli@0.0.1 in another image\n'),
                sandbox: { enabled: false },
            });

            expect(of(report, 'warning')).not.toContain('sandbox.pin.stale');
        });

        it('is repinned to this `zen` by --fix, leaving the rest of the file alone', async () => {
            const mine = await versionOf(cliManifest);
            const dir = project(
                'FROM node:22\n# was @zenera/cli@0.0.1\n' +
                    'RUN npm install -g @zenera/cli@0.0.1 \\\n    @zenera/rag typescript@5\n',
            );

            expect(repinDockerfile(dir)).toEqual(['sandbox/Dockerfile']);
            expect(readFileSync(join(dir, 'sandbox', 'Dockerfile'), 'utf8')).toBe(
                'FROM node:22\n# was @zenera/cli@0.0.1\n' +
                    `RUN npm install -g @zenera/cli@${mine} \\\n    @zenera/rag@${mine} typescript@5\n`,
            );
            // A second pass has nothing left to do, and the check agrees.
            expect(repinDockerfile(dir)).toEqual([]);
            const report = await validateProject({ dir, sandbox: { enabled: false } });
            expect(of(report, 'warning')).not.toContain('sandbox.pin.stale');
            expect(of(report, 'warning')).not.toContain('sandbox.pin.absent');
        });
    });
});

// ---------------------------------------------------------------------------
// The catalog
//
// The vendor adapters are the part most likely to break without anyone
// noticing: a payload reshapes, a listing quietly returns nothing, and the
// only symptom is a shorter list. Stubbed clients keep them honest offline.
// ---------------------------------------------------------------------------

describe('reading a provider listing', () => {
    const pages = <T>(...items: T[]) => ({ models: { list: async () => items } });

    it('reads a role off an OpenAI id, and drops what cannot be reached', async () => {
        const rows = await fetchCatalog('openai', {
            models: {
                list: async () => [
                    { id: 'gpt-4o' },
                    { id: 'text-embedding-3-small' },
                    { id: 'dall-e-3' },
                    { id: 'chatgpt-image-latest' },
                    { id: 'omni-moderation-latest' },
                ],
            },
        });
        const roles = Object.fromEntries(rows.map((r) => [r.id, r.roles]));
        expect(roles).toEqual({
            'gpt-4o': ['chat'],
            'text-embedding-3-small': ['embedding'],
            'dall-e-3': ['image'],
            'chatgpt-image-latest': ['image'],
        });
        expect(rows[0]!.ref).toBe('openai:gpt-4o');
    });

    // OpenAI's listing has no dimensions field at all, and a blank there sends
    // someone to the docs for something this file already knows.
    it('fills an OpenAI embedding width in from the built-in list', async () => {
        const [row] = await fetchCatalog('openai', {
            models: { list: async () => [{ id: 'text-embedding-3-small' }] },
        });
        expect(row!.dimensions).toBe(1536);
        expect(row!.source).toBe('live');
    });

    it('never invents an Anthropic embedding model', async () => {
        const rows = await fetchCatalog('anthropic', {
            models: {
                list: async () => [{ id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }],
            },
        });
        expect(rows.every((r) => r.roles.includes('chat'))).toBe(true);
        expect(rows.some((r) => r.roles.includes('embedding'))).toBe(false);
    });

    it('asks Google for base models, not tuned ones', async () => {
        let asked: unknown;
        await fetchCatalog(
            'vertex',
            {
                models: {
                    list: async (params: unknown) => {
                        asked = params;
                        return [];
                    },
                },
            },
            async () => [],
        );
        // Without this the SDK lists tuned models, and an account with none
        // looks like an account with no models at all.
        expect(asked).toMatchObject({ config: { queryBase: true } });
    });

    it('strips the resource prefix and reads the role off supportedActions', async () => {
        const rows = await fetchCatalog(
            'vertex',
            pages(
                {
                    name: 'models/gemini-2.5-flash',
                    supportedActions: ['generateContent'],
                    inputTokenLimit: 1_048_576,
                },
                {
                    name: 'publishers/google/models/text-embedding-005',
                    supportedActions: ['embedContent'],
                },
            ),
            async () => [],
        );
        expect(rows.filter((r) => r.publisher === 'google').map((r) => [r.id, r.roles])).toEqual([
            ['gemini-2.5-flash', ['chat']],
            ['text-embedding-005', ['embedding']],
        ]);
        expect(rows[0]!.contextLength).toBe(1_048_576);
    });

    // Vertex lists the whole Model Garden. Those rows are deployment recipes,
    // and asking one a question fails in a way no error message explains.
    it('leaves out Model Garden rows the GenAI API will not serve', async () => {
        const rows = await fetchCatalog(
            'vertex',
            pages(
                { name: 'publishers/google/models/bart-large-cnn' },
                { name: 'publishers/google/models/alphafold3-request' },
                { name: 'publishers/google/models/gemini-3-experimental' },
            ),
            async () => [],
        );
        expect(rows.filter((r) => r.publisher === 'google').map((r) => r.id)).toEqual([
            'gemini-3-experimental',
        ]);
    });

    it("lists Vertex partner models after Google's, and survives their listing failing", async () => {
        const google = pages({
            name: 'publishers/google/models/gemini-3.8-flash',
            supportedActions: ['generateContent'],
        });
        const claude = {
            ref: 'vertex:claude-sonnet-5',
            id: 'claude-sonnet-5',
            provider: 'vertex' as const,
            roles: ['chat' as const],
            publisher: 'anthropic',
            source: 'live' as const,
        };
        const rows = (await fetchCatalog('vertex', google, async () => [claude])).sort(byGroup);
        expect(rows.map((r) => [r.id, groupOf(r)])).toEqual([
            ['gemini-3.8-flash', 'vertex · Google (Gemini, Gemma, Imagen, Veo)'],
            ['claude-sonnet-5', 'vertex · partner · anthropic'],
            ['openai/gpt-oss-120b-maas', 'vertex · partner · openai'],
            ['qwen/qwen3-235b-a22b-instruct-2507-maas', 'vertex · partner · qwen'],
        ]);

        const failed = await fetchCatalog('vertex', google, async () => {
            throw new Error('403');
        });
        expect(failed.map((r) => r.id)).toContain('gemini-3.8-flash');
    });

    it('shares a truncated listing between providers, best of each first', () => {
        const rows = (
            [
                ['anthropic', 'claude-opus-5'],
                ['anthropic', 'claude-sonnet-5'],
                ['anthropic', 'claude-haiku-5'],
                ['openai', 'gpt-6-sol'],
                ['openai', 'gpt-5.6-sol'],
                ['openai', 'gpt-5.6-terra'],
                ['google', 'gemini-4-argon'],
            ] as const
        ).map(([provider, id]) => ({
            ref: `${provider}:${id}`,
            id,
            provider,
            roles: ['chat' as const],
            source: 'live' as const,
        }));
        expect(sampleByProvider(rows, 5).map((r) => r.ref)).toEqual([
            'anthropic:claude-opus-5',
            'anthropic:claude-sonnet-5',
            'openai:gpt-6-sol',
            'openai:gpt-5.6-sol',
            'google:gemini-4-argon',
        ]);
        expect(sampleByProvider(rows, 10)).toHaveLength(7);
    });

    it('walks every OpenRouter page and folds in the separate embedding list', async () => {
        const chat = (id: string) => ({
            id,
            name: id,
            contextLength: 200_000,
            pricing: { prompt: '0', completion: '0' },
            architecture: { inputModalities: ['text', 'image'], outputModalities: ['text'] },
            supportedParameters: ['tools'],
        });
        const rows = await fetchCatalog('openrouter', {
            models: {
                list: async () => [
                    { result: { data: [chat('a/one')] } },
                    { result: { data: [chat('a/two')] } },
                ],
            },
            embeddings: {
                listModels: async () => [{ result: { data: [{ id: 'a/embed' }] } }],
            },
        });
        expect(rows.map((r) => r.id)).toEqual(['a/one', 'a/two', 'a/embed']);
        expect(rows[0]).toMatchObject({
            roles: ['chat'],
            supports: { tools: true, vision: true },
            pricing: { free: true },
        });
        expect(rows[2]!.roles).toEqual(['embedding']);
    });

    // The embeddings endpoint is the newer of the two and the one a gateway is
    // most likely not to proxy. Losing every chat model over it is a bad trade.
    it('still returns chat models when the embedding listing fails', async () => {
        const rows = await fetchCatalog('openrouter', {
            models: { list: async () => [{ result: { data: [{ id: 'a/one' }] } }] },
            embeddings: {
                listModels: async () => {
                    throw new Error('404 not found');
                },
            },
        });
        expect(rows.map((r) => r.id)).toEqual(['a/one']);
    });
});

describe('where a listing comes from', () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-catalog-'));
    // Set per test rather than once: neighbouring suites snapshot and restore
    // the whole environment, and a value written at collection time is gone by
    // the time anything here runs.
    beforeEach(() => {
        process.env.ZENERA_HOME = root;
    });
    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const cache = (provider: string, fetchedAt: string, ids: string[]): void =>
        new Cache(CATALOG_KIND).put(catalogKey(provider as Provider), {
            provider,
            fetchedAt,
            entries: ids.map((id) => ({
                ref: `${provider}:${id}`,
                id,
                provider,
                roles: ['chat'],
                source: 'live',
            })),
        });

    it('falls back to the built-in list when there is nothing else', async () => {
        const cat = await loadCatalog('anthropic', { offline: true });
        expect(cat.origin).toBe('curated');
        expect(cat.entries.every((e) => e.source === 'curated')).toBe(true);
        expect(cat.entries.map((e) => e.id)).toEqual(CURATED.anthropic.map((e) => e.id));
    });

    // Vertex offers a different set of models in each location, so a listing
    // filed under the provider alone answers for a place it never asked.
    it('files a vertex listing under the place it was asked', async () => {
        const kept = process.env.GOOGLE_CLOUD_LOCATION;
        try {
            process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
            cache('vertex', new Date().toISOString(), ['only-in-us-central1']);
            process.env.GOOGLE_CLOUD_LOCATION = 'us';
            expect((await loadCatalog('vertex', { offline: true })).origin).toBe('curated');

            process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
            const back = await loadCatalog('vertex', { offline: true });
            expect(back.origin).toBe('cache');
            expect(back.entries.map((e) => e.id)).toEqual(['only-in-us-central1']);
        } finally {
            process.env.GOOGLE_CLOUD_LOCATION = kept;
        }
    });

    it('leaves a provider with one listing filed under its own name', () => {
        expect(catalogKey('openai' as Provider)).toBe(catalogKey('openai' as Provider));
        expect(catalogKey('openai' as Provider)).not.toContain('global');
    });

    it('uses a cache written inside the day without asking anyone', async () => {
        cache('openai', new Date().toISOString(), ['cached-model']);
        const cat = await loadCatalog('openai', { offline: true });
        expect(cat.origin).toBe('cache');
        expect(cat.entries.map((e) => e.id)).toEqual(['cached-model']);
    });

    // Yesterday's real answer from this account beats today's guess about
    // accounts in general.
    it('prefers a stale cache to the built-in list', async () => {
        cache('google', new Date(Date.now() - 2 * CATALOG_TTL_MS).toISOString(), ['old-model']);
        const cat = await loadCatalog('google', { offline: true });
        expect(cat.origin).toBe('stale');
        expect(cat.entries.map((e) => e.id)).toEqual(['old-model']);
    });

    it('ignores a cache written by a version that is not this one', async () => {
        // The version is part of the key, so an entry from another one is not
        // read and rejected - it is simply never looked for.
        new Cache(CATALOG_KIND).put(cacheKey(99, 'openrouter'), {
            provider: 'openrouter',
            fetchedAt: new Date().toISOString(),
            entries: [{ ref: 'openrouter:x', id: 'x', provider: 'openrouter', roles: ['chat'] }],
        });
        const cat = await loadCatalog('openrouter', { offline: true });
        expect(cat.origin).toBe('curated');
    });
});

// In a gateway mode a run reaches only what the gateway serves, so that is the
// whole catalog - split back into the providers a ref can name.
describe('listing through a gateway', () => {
    const kept = { ...process.env };
    let root: string;
    let server: Server;
    let answer: { status: number; body: unknown };
    let asked = 0;
    let seen: Record<string, string | string[] | undefined> = {};

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'zen-gw-catalog-'));
        process.env.ZENERA_HOME = root;
        asked = 0;
        server = createServer((req, res) => {
            asked++;
            seen = { path: req.url, ...req.headers };
            res.writeHead(answer.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(answer.body));
        });
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        // A fresh port per test is also a fresh listing: the process memo is keyed by url.
        process.env.BIFROST_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        process.env.BIFROST_API_KEY = 'sk-bf-1';
    });
    afterEach(async () => {
        process.env = { ...kept };
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(root, { recursive: true, force: true });
    });

    const LISTING = {
        data: [
            { id: 'vertex/gemini-3.5-flash', created: 1_760_000_000, context_length: 1_048_576 },
            { id: 'vertex/claude-sonnet-5' },
            { id: 'gemini/gemini-embedding-2' },
            { id: 'openai/gpt-5.6-luna' },
            { id: 'groq/llama-4' },
        ],
    };

    it('splits one listing by provider, and asks once for all of them', async () => {
        answer = { status: 200, body: LISTING };
        const [vertex, google, openai, anthropic] = await loadCatalogs([
            'vertex',
            'google',
            'openai',
            'anthropic',
        ]);

        expect(asked).toBe(1);
        expect(seen).toMatchObject({ path: '/v1/models', 'x-bf-vk': 'sk-bf-1' });
        expect(vertex!.entries.map((e) => [e.ref, e.publisher])).toEqual([
            ['vertex:gemini-3.5-flash', 'google'],
            ['vertex:claude-sonnet-5', 'anthropic'],
        ]);
        expect(vertex!.via).toMatchObject({ name: 'bifrost' });
        expect(google!.entries).toMatchObject([
            { ref: 'google:gemini-embedding-2', roles: ['embedding'] },
        ]);
        expect(openai!.entries.map((e) => e.ref)).toEqual(['openai:gpt-5.6-luna']);
        // Served by nothing a ref could name, and the vendor's own list is not what runs reach.
        expect(anthropic!.entries).toEqual([]);
    });

    it('offers no built-in list when the gateway cannot be asked', async () => {
        answer = { status: 401, body: { type: 'virtual_key_required', error: { message: 'no' } } };
        const cat = await loadCatalog('openai');
        expect(cat.entries).toEqual([]);
        expect(cat.problem?.state).toBe('dead');
    });

    it('never caches a gateway listing, so an empty one does not stick', async () => {
        answer = { status: 200, body: { data: [] } };
        expect((await loadCatalog('openai')).entries).toEqual([]);
        answer = { status: 200, body: LISTING };
        // A new key is a new process memo, which is the only cache left.
        process.env.BIFROST_API_KEY = 'sk-bf-2';
        const cat = await loadCatalog('openai', { offline: true });
        expect(asked).toBe(2);
        expect(cat).toMatchObject({ origin: 'live' });
        expect(cat.entries.map((e) => e.ref)).toEqual(['openai:gpt-5.6-luna']);
    });

    // The meta agent's last resort: what the gateway serves, not a vendor recommendation it may not.
    it('falls back to the best chat model the gateway serves that can carry the tools', async () => {
        answer = {
            status: 200,
            body: {
                data: [
                    { id: 'openai/gpt-4o' },
                    { id: 'openai/gpt-6-sol' },
                    { id: 'gemini/gemini-4-argon' },
                    { id: 'anthropic/claude-haiku-5' },
                    { id: 'vertex/claude-sonnet-5' },
                    { id: 'openai/text-embedding-3-large' },
                ],
            },
        };
        expect(await gatewayDefaultRef()).toBe('vertex/claude-sonnet-5');
        expect(await gatewayDefaultRef('openai')).toBe('openai/gpt-6-sol');
        expect(await gatewayDefaultRef('anthropic')).toBe('anthropic/claude-haiku-5');
    });

    it('has no gateway fallback when nothing served can run the meta agent', async () => {
        answer = { status: 200, body: { data: [{ id: 'openai/gpt-4o' }] } };
        expect(await gatewayDefaultRef()).toBeUndefined();
    });

    it('ignores a cached vendor listing', async () => {
        new Cache(CATALOG_KIND).put(catalogKey('openai'), {
            provider: 'openai',
            fetchedAt: new Date().toISOString(),
            entries: [
                {
                    ref: 'openai:vendor-only',
                    id: 'vendor-only',
                    provider: 'openai',
                    roles: ['chat'],
                    source: 'live',
                },
            ],
        });
        answer = { status: 200, body: LISTING };
        const cat = await loadCatalog('openai');
        expect(cat.entries.map((e) => e.ref)).toEqual(['openai:gpt-5.6-luna']);
    });
});

describe('narrowing a list of models', () => {
    const row = (over: Partial<CatalogEntry>): CatalogEntry => ({
        ref: 'openrouter:a/one',
        id: 'a/one',
        provider: 'openrouter',
        roles: ['chat'],
        source: 'live',
        ...over,
    });

    it('wants every word, so a second one narrows rather than widens', () => {
        const claude = row({ name: 'Anthropic: Claude Haiku 4.5' });
        expect(matches(claude, 'claude haiku')).toBe(true);
        expect(matches(claude, 'claude sonnet')).toBe(false);
    });

    it('matches the ref as well as the name', () => {
        expect(matches(row({}), 'a/one')).toBe(true);
    });

    it('keeps a row only if it holds one of the roles asked for', () => {
        const embed = row({ roles: ['embedding'] });
        expect(matches(embed, '', { roles: ['embedding'] })).toBe(true);
        expect(matches(embed, '', { roles: ['chat'] })).toBe(false);
        expect(matches(embed, '', { roles: [] })).toBe(true);
    });

    it('treats an unknown context length as too small rather than as a match', () => {
        expect(matches(row({}), '', { minContext: 1000 })).toBe(false);
        expect(matches(row({ contextLength: 2000 }), '', { minContext: 1000 })).toBe(true);
    });
});

describe('telling a blocked account from a bad key', () => {
    const fails = (message: string, status?: number): Error =>
        Object.assign(new Error(message), status === undefined ? {} : { status });

    // The case this whole verdict exists for: a perfectly good service-account
    // key against a project where the API was never switched on. It arrives as
    // a 403, and calling it `dead` sends someone off to rotate a working key.
    it('calls a disabled API blocked, and says which one in which project', () => {
        const check = classify(
            fails(
                '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Vertex AI API has ' +
                    'not been used in project my-proj before or it is disabled. Enable it by ' +
                    'visiting https://console.developers.google.com/apis/api/aiplatform.googleapis' +
                    '.com/overview?project=my-proj then retry."}}',
                403,
            ),
        );
        expect(check.state).toBe('blocked');
        expect(check.fix).toBe(
            'gcloud services enable aiplatform.googleapis.com --project my-proj',
        );
        // The sentence, not the JSON envelope it arrived in.
        expect(check.detail).toMatch(/^Vertex AI API has not been used/);
    });

    it('still calls a rejected credential dead', () => {
        expect(classify(fails('invalid_api_key', 401)).state).toBe('dead');
        expect(classify(fails('403 permission_denied on this resource', 403)).state).toBe('dead');
    });

    it('calls an empty balance blocked, and a rate limit live', () => {
        expect(classify(fails('Your credit balance is too low', 400)).state).toBe('blocked');
        // 429 is this minute's problem; the account is fine.
        expect(classify(fails('Rate limit exceeded, quota exceeded', 429)).state).toBe('live');
        // Unless the vendor named the account: this one is also a 429, and no
        // amount of waiting turns it into a working key.
        const empty = Object.assign(fails('You have no credits remaining.', 429), {
            code: 'credit_balance_exhausted',
        });
        expect(classify(empty).state).toBe('blocked');
    });

    it('keeps an unreachable provider out of both', () => {
        expect(classify(fails('fetch failed')).state).toBe('unknown');
    });

    // A misspelt vertex location makes up a hostname, and the reply is a
    // Google error page whose first line, `<!DOCTYPE html>`, names no cause.
    it('reads a web page as a wrong endpoint', () => {
        const check = classify(fails('<!DOCTYPE html>\n<html lang=en>\n  <title>Error 404'));
        expect(check.state).toBe('unknown');
        expect(check.detail).toMatch(/web page/);
        expect(check.fix).toMatch(/location/);
    });
});

// ---------------------------------------------------------------------------
// zen meta
// ---------------------------------------------------------------------------

describe('which model the meta agent runs on', () => {
    it('takes the first answer in order', () => {
        expect(chooseModel({ flag: 'a', shell: 'b', stored: 'c' })).toEqual({
            ref: 'a',
            from: 'flag',
        });
        expect(chooseModel({ stored: 'c', project: 'd' })).toEqual({ ref: 'c', from: 'store' });
        expect(chooseModel({ project: 'd' })).toEqual({ ref: 'd', from: 'project' });
        expect(chooseModel({})).toBeUndefined();
    });

    // `.env` only fills gaps, so by the time the variable is read the two
    // sources are indistinguishable - unless the shell's value was kept from
    // before the file was folded in, which is the only reason it is.
    it('tells the shell apart from the project file', () => {
        expect(chooseModel({ shell: 'x', env: 'x' })).toEqual({ ref: 'x', from: 'shell' });
        expect(chooseModel({ env: 'y' })).toEqual({ ref: 'y', from: 'env' });
    });

    it('reads a provider prefix but not a publisher one', () => {
        expect(splitRef('vertex/gemini-2.5-pro')).toEqual({
            provider: 'vertex',
            id: 'gemini-2.5-pro',
        });
        expect(splitRef('gpt-5.4')).toEqual({ id: 'gpt-5.4' });
        // `google/` here is the publisher Vertex expects, not zen's provider.
        expect(splitRef('anthropic/claude-sonnet-4.5').provider).toBe('anthropic');
        expect(splitRef('meta-llama/llama-4').provider).toBeUndefined();
    });

    // The colon form is what arrives from `agents.yaml`, api selector and all.
    it('reads the library ref form too', () => {
        expect(splitRef('openai:gpt-5.6-sol')).toEqual({ provider: 'openai', id: 'gpt-5.6-sol' });
        expect(splitRef('openai/responses:gpt-5.6-sol')).toEqual({
            provider: 'openai',
            id: 'gpt-5.6-sol',
        });
        expect(splitRef('openrouter:anthropic/claude-opus-5')).toEqual({
            provider: 'openrouter',
            id: 'anthropic/claude-opus-5',
        });
        // A colon inside an id is not a prefix: this one is an OpenRouter variant.
        expect(splitRef('inclusionai/ling-3.0-flash-fin:free')).toEqual({
            id: 'inclusionai/ling-3.0-flash-fin:free',
        });
    });

    // The prefix that is nearly right is the dangerous one: it parses as a bare
    // id and gets sent, whole, to whichever provider the default picks.
    it('catches a misspelt provider without accusing a publisher', () => {
        expect(misspelledProvider('vertes/gemini-3.5-flash')).toBe('vertex');
        expect(misspelledProvider('opeani/gpt-5.6-sol')).toBe('openai');
        expect(misspelledProvider('antropic/claude-opus-5')).toBe('anthropic');
        expect(misspelledProvider('vertex/gemini-3.8-flash')).toBeUndefined();
        expect(misspelledProvider('gpt-5.6-sol')).toBeUndefined();
        // Real OpenRouter ids, which are shaped the same way.
        expect(misspelledProvider('meta-llama/llama-4')).toBeUndefined();
        expect(misspelledProvider('inclusionai/ling-3.0-flash-fin:free')).toBeUndefined();
        expect(misspelledProvider('x-ai/grok-5')).toBeUndefined();
        expect(misspelledProvider('deepseek/deepseek-v4')).toBeUndefined();
        expect(misspelledProvider('qwen/qwen4-max')).toBeUndefined();
        expect(misspelledProvider('mistralai/mistral-large')).toBeUndefined();
    });

    // A machine with a key and nothing else should still run, so the last
    // resort is a recommendation rather than an error.
    it('falls back to what a held key recommends, and loses to anything set', () => {
        expect(chooseModel({ fallback: 'vertex/gemini-3.8-flash' })).toEqual({
            ref: 'vertex/gemini-3.8-flash',
            from: 'default',
        });
        expect(chooseModel({ project: 'd', fallback: 'vertex/gemini-3.8-flash' })?.from).toBe(
            'project',
        );
    });

    it('recommends for the first provider holding a key, or for the one named', () => {
        const held = (...list: Provider[]): KeyStore =>
            ({
                active: (p: Provider) => (list.includes(p) ? {} : undefined),
            }) as unknown as KeyStore;

        expect(defaultRef(held('openai', 'vertex'))).toBe('openai/gpt-5.6-sol');
        expect(defaultRef(held('vertex'))).toBe('vertex/gemini-3.8-flash');
        expect(defaultRef(held('openai', 'vertex'), 'vertex')).toBe('vertex/gemini-3.8-flash');
        expect(defaultRef(held('openai'), 'vertex')).toBeUndefined();
        expect(defaultRef(held())).toBeUndefined();
        expect(defaultRef(held(), undefined, true)).toBe('anthropic/claude-opus-5');
        expect(defaultRef(held(), 'vertex', true)).toBe('vertex/gemini-3.8-flash');
    });
});

describe('wiring a zen key into copilot', () => {
    const store = {
        reveal: () => 'sk-secret-value',
        fileOf: () => '/keys/vertex.json',
        projectOf: () => ({ id: 'acme-ai', from: 'stored' as const }),
    } as unknown as KeyStore;

    const entry = (over: Partial<KeyEntry>): KeyEntry =>
        ({
            provider: 'openai',
            name: 'default',
            holds: 'secret',
            value: 'k',
            addedAt: '2026-01-01T00:00:00.000Z',
            ...over,
        }) as KeyEntry;

    // Nothing else turns BYOK on, so a provider whose url copilot already
    // knows still needs one, or the run quietly goes to a GitHub account.
    it('always sets a base url, because that is what activates BYOK', () => {
        for (const provider of ['openai', 'anthropic', 'google', 'openrouter'] as const) {
            const out = wire(store, entry({ provider }), 'some-model');
            expect(out.env.COPILOT_PROVIDER_BASE_URL).toMatch(/^https:\/\//);
        }
    });

    it('builds the vertex endpoint from the project and location on the key', () => {
        const out = wire(
            store,
            entry({ provider: 'vertex', holds: 'file', location: 'europe-west4' }),
            'gemini-2.5-pro',
        );
        expect(out.env.COPILOT_PROVIDER_BASE_URL).toBe(
            'https://aiplatform.googleapis.com/v1/projects/acme-ai/locations/europe-west4/endpoints/openapi',
        );
        // Vertex speaks publisher names; the bare id stays as the catalogue key.
        expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBe('google/gemini-2.5-pro');
        expect(out.env.COPILOT_PROVIDER_MODEL_ID).toBe('gemini-2.5-pro');
        expect(out.warnings).toEqual([]);
    });

    // Vertex's completions endpoint takes `function` tools only, and a bare
    // `gpt-oss-…` id gets copilot's GPT tool set with a custom `apply_patch`.
    it('keeps a partner publisher on the model id so copilot falls back to function tools', () => {
        const out = wire(
            store,
            entry({ provider: 'vertex', holds: 'file', location: 'us' }),
            'openai/gpt-oss-120b-maas',
        );
        expect(out.env.COPILOT_PROVIDER_BASE_URL).toContain('/locations/global/');
        expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBe('openai/gpt-oss-120b-maas');
        expect(out.env.COPILOT_PROVIDER_MODEL_ID).toBe('openai/gpt-oss-120b-maas');
        expect(
            wire(store, entry({ provider: 'vertex', holds: 'file' }), 'google/gemini-2.5-pro').env
                .COPILOT_PROVIDER_MODEL_ID,
        ).toBe('gemini-2.5-pro');
    });

    it('says so when the location will be the slow one', () => {
        const out = wire(store, entry({ provider: 'vertex', holds: 'file' }), 'gemini-2.5-pro');
        expect(out.env.COPILOT_PROVIDER_BASE_URL).toContain('/locations/global/');
        expect(out.warnings.join(' ')).toMatch(/cold start/);
    });

    // An access token lives an hour and a session does not, so the file form
    // hands over a command rather than a credential.
    it('mints a token per request for a file-shaped key, and holds no secret', () => {
        const out = wire(store, entry({ provider: 'vertex', holds: 'file' }), 'gemini-2.5-pro');
        expect(out.env.COPILOT_PROVIDER_API_KEY_COMMAND).toMatch(/key token vertex$/);
        expect(out.env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
        expect(out.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/keys/vertex.json');
        expect(out.secret).toEqual([]);
    });

    // Copilot offers its tools as OpenAI custom tools, which only the responses
    // API accepts - a completions model refuses the very first call.
    it('picks the wire api the model can actually serve', () => {
        expect(wireApi('openai', 'gpt-5-mini')).toBe('responses');
        expect(wireApi('openai', 'o4-mini')).toBe('responses');
        expect(wireApi('openai', 'gpt-6-sol')).toBe('responses');
        expect(wireApi('openai', 'gpt-4o')).toBeUndefined();
        expect(wireApi('anthropic', 'claude-sonnet-4.5')).toBeUndefined();
    });

    it('knows which models cannot carry its tools', () => {
        expect(metaCompatible('openai', 'gpt-5-mini')).toBe(true);
        expect(metaCompatible('openai', 'gpt-4o')).toBe(false);
        expect(metaCompatible('openai', 'chatgpt-4o-latest')).toBe(false);
        expect(metaCompatible('anthropic', 'claude-opus-5')).toBe(true);
        expect(metaCompatible('vertex', 'gemini-3.8-flash')).toBe(true);
    });

    it('never lets a secret into something printable', () => {
        const out = wire(store, entry({ provider: 'openai' }), 'gpt-5.4');
        expect(out.secret).toEqual(['COPILOT_PROVIDER_API_KEY']);
        const shown = masked(out.env, out.secret).join('\n');
        expect(shown).not.toContain('sk-secret-value');
        expect(shown).toContain('COPILOT_PROVIDER_API_KEY=');
    });

    // The openapi endpoint answers a Claude id with a bare 404.
    it('sends Claude on vertex through the relay as an anthropic provider', () => {
        const out = wire(
            store,
            entry({ provider: 'vertex', holds: 'file', location: 'us' }),
            'anthropic/claude-sonnet-5-5',
        );
        expect(out.env.COPILOT_PROVIDER_TYPE).toBe('anthropic');
        expect(out.env.COPILOT_MODEL).toBe('claude-sonnet-5-5');
        expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBeUndefined();
        expect(out.env.COPILOT_PROVIDER_API_KEY_COMMAND).toBeUndefined();
        expect(out.relay).toMatchObject({
            project: 'acme-ai',
            location: 'us',
            keyFile: '/keys/vertex.json',
            key: out.env.COPILOT_PROVIDER_API_KEY,
        });
        expect(out.secret).toEqual(['COPILOT_PROVIDER_API_KEY']);
    });

    it('refuses Claude on vertex with an express-mode key', () => {
        expect(() =>
            wire(store, entry({ provider: 'vertex', holds: 'secret' }), 'claude-sonnet-5-5'),
        ).toThrow(/service account/);
    });

    describe('through a gateway', () => {
        const at = { baseURL: 'http://bifrost:8080', apiKey: 'sk-bf-secret' };

        it('sends OpenAI models to the openai drop-in, qualified, on the responses api', () => {
            const out = wireGateway(at, 'openai', 'gpt-6-sol');
            expect(out.env).toMatchObject({
                COPILOT_PROVIDER_TYPE: 'openai',
                COPILOT_PROVIDER_BASE_URL: 'http://bifrost:8080/openai/v1',
                COPILOT_PROVIDER_MODEL_ID: 'gpt-6-sol',
                COPILOT_PROVIDER_WIRE_MODEL: 'openai/gpt-6-sol',
                COPILOT_PROVIDER_WIRE_API: 'responses',
            });
            expect(masked(out.env, out.secret).join('\n')).not.toContain('sk-bf-secret');
        });

        it('sends Claude to the anthropic drop-in, wherever it is hosted', () => {
            for (const [provider, id] of [
                ['anthropic', 'claude-opus-5'],
                ['vertex', 'anthropic/claude-opus-5'],
            ] as const) {
                const out = wireGateway(at, provider, id);
                expect(out.env.COPILOT_PROVIDER_TYPE).toBe('anthropic');
                expect(out.env.COPILOT_PROVIDER_BASE_URL).toBe('http://bifrost:8080/anthropic');
                expect(out.env.COPILOT_PROVIDER_MODEL_ID).toBe('claude-opus-5');
                expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBe(`${provider}/claude-opus-5`);
                expect(out.relay).toBeUndefined();
            }
        });

        it('names the upstream for everything else, and holds no key it was not given', () => {
            const out = wireGateway(
                { baseURL: 'http://bifrost:8080' },
                'google',
                'gemini-3.8-flash',
            );
            expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBe('gemini/gemini-3.8-flash');
            expect(out.env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
            expect(out.secret).toEqual([]);
        });
    });
});

describe('the vertex Claude relay', () => {
    const seen: { url: string; auth?: string; apiKey?: string; body: Record<string, unknown> }[] =
        [];
    let upstream: Server;
    let base = '';

    beforeEach(async () => {
        seen.length = 0;
        upstream = createServer((req, res) => {
            let text = '';
            req.on('data', (c: Buffer) => (text += c.toString()));
            req.on('end', () => {
                seen.push({
                    url: req.url ?? '',
                    auth: req.headers.authorization,
                    apiKey: req.headers['x-api-key'] as string | undefined,
                    body: JSON.parse(text) as Record<string, unknown>,
                });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"ok":true}');
            });
        });
        await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
        base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/projects/p/locations/global`;
    });
    afterEach(() => {
        upstream.closeAllConnections();
        upstream.close();
    });

    const post = (url: string, key: string, body: object): Promise<Response> =>
        fetch(`${url}/v1/messages`, {
            method: 'POST',
            headers: { 'x-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });

    it('moves the model into the path and adds the vertex version', async () => {
        const relay = await startRelay({ key: 'k', base, token: async () => 'tok' });
        try {
            const res = await post(relay.url, 'k', { model: 'claude-x', max_tokens: 5 });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ok: true });
            await post(relay.url, 'k', { model: 'claude-x', stream: true });
        } finally {
            await relay.close();
        }
        expect(seen.map((s) => s.url)).toEqual([
            '/v1/projects/p/locations/global/publishers/anthropic/models/claude-x:rawPredict',
            '/v1/projects/p/locations/global/publishers/anthropic/models/claude-x:streamRawPredict',
        ]);
        expect(seen[0]).toMatchObject({
            auth: 'Bearer tok',
            apiKey: undefined,
            body: { max_tokens: 5, anthropic_version: 'vertex-2023-10-16' },
        });
        expect(seen[0].body.model).toBeUndefined();
    });

    // Loopback is open to every process on the machine, and the relay mints GCP tokens.
    it('refuses anyone without the session key', async () => {
        const relay = await startRelay({ key: 'k', base, token: async () => 'tok' });
        try {
            expect((await post(relay.url, 'nope', { model: 'claude-x' })).status).toBe(401);
        } finally {
            await relay.close();
        }
        expect(seen).toEqual([]);
    });
});

describe('a stored command', () => {
    it('accepts the four ways one gets named', () => {
        expect(promptPath('/p', '/review')).toBe('/p/.github/skills/review/SKILL.md');
        expect(promptPath('/p', 'review')).toBe('/p/.github/skills/review/SKILL.md');
        expect(promptPath('/p', 'notes.md')).toBe('/p/notes.md');
        expect(promptPath('/p', 'agents/prompts/x.md')).toBe('/p/agents/prompts/x.md');
    });

    // A project's own prompt file still runs, unless a skill has taken its name.
    it('falls back to a legacy prompt file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-prompt-'));
        try {
            mkdirSync(join(dir, '.github', 'prompts'), { recursive: true });
            writeFileSync(join(dir, '.github', 'prompts', 'mine.prompt.md'), 'x\n');
            expect(promptPath(dir, '/mine')).toBe(`${dir}/.github/prompts/mine.prompt.md`);

            mkdirSync(join(dir, '.github', 'skills', 'mine'), { recursive: true });
            writeFileSync(join(dir, '.github', 'skills', 'mine', 'SKILL.md'), 'y\n');
            expect(promptPath(dir, '/mine')).toBe(`${dir}/.github/skills/mine/SKILL.md`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reads user-invocable: false as the model’s, not a command', () => {
        const hidden = readPrompt(
            '/p/s/SKILL.md',
            's',
            '---\nname: s\nuser-invocable: false\n---\nx\n',
        );
        expect(hidden.invocable).toBe(false);
        expect(readPrompt('/p/s/SKILL.md', 's', 'x\n').invocable).toBe(true);
    });

    // Frontmatter is the editor's business; copilot is handed the body alone.
    it('sends the body and keeps the description for the narration', () => {
        const found = readPrompt(
            '/p/x.prompt.md',
            'x',
            '---\nmode: agent\ndescription: Review it.\n---\n\nDo the thing.\n',
        );
        expect(found.body).toBe('Do the thing.');
        expect(found.description).toBe('Review it.');
    });

    it('leaves a file without frontmatter alone', () => {
        const found = readPrompt('/p/x.prompt.md', 'x', 'Just this.\n');
        expect(found.body).toBe('Just this.');
        expect(found.description).toBeUndefined();
    });
});

// The spans below are trimmed from a real `COPILOT_OTEL_FILE_EXPORTER_PATH` file.
describe('counting the meta agent’s tokens', () => {
    const chat = (attrs: Record<string, unknown>) =>
        JSON.stringify({
            type: 'span',
            traceId: 't1',
            spanId: 's1',
            parentSpanId: 'p1',
            name: 'chat google/gemini-3.8-flash',
            startTime: [1790939995, 154000000],
            endTime: [1790939998, 922000000],
            attributes: {
                'gen_ai.operation.name': 'chat',
                'gen_ai.request.model': 'google/gemini-3.8-flash',
                'gen_ai.response.model': 'google/gemini-3.8-flash',
                'gen_ai.conversation.id': 'sess-1',
                'gen_ai.usage.input_tokens': 43828,
                'gen_ai.usage.output_tokens': 49,
                ...attrs,
            },
        });

    it('reads a chat span, folding reasoning into output as zen counts it', () => {
        const span = readSpan(
            chat({
                'gen_ai.usage.reasoning.output_tokens': 415,
                'gen_ai.usage.cache_read.input_tokens': 40000,
            }),
        );
        expect(span).toMatchObject({
            model: 'google/gemini-3.8-flash',
            session: 'sess-1',
            durationMs: 3768,
            usage: {
                inputTokens: 43828,
                cachedInputTokens: 40000,
                outputTokens: 464,
                reasoningTokens: 415,
            },
        });
    });

    it('ignores tools, metrics, agent spans and broken lines', () => {
        expect(readSpan(chat({ 'gen_ai.operation.name': 'execute_tool' }))).toBeUndefined();
        expect(readSpan(JSON.stringify({ type: 'metric', name: 'x' }))).toBeUndefined();
        expect(
            readSpan(
                JSON.stringify({
                    type: 'span',
                    attributes: {
                        'gen_ai.operation.name': 'invoke_agent',
                        'gen_ai.agent.name': 'explore',
                    },
                }),
            ),
        ).toBeUndefined();
        expect(readSpan('{"type":"span",')).toBeUndefined();
    });

    it('carries a line that has not finished arriving', () => {
        const first = splitLines('', '{"a":1}\n{"b":');
        expect(first).toEqual({ lines: ['{"a":1}'], carry: '{"b":' });
        expect(splitLines(first.carry, '2}\n')).toEqual({ lines: ['{"b":2}'], carry: '' });
    });

    it('sums calls into one line', () => {
        const tally = new Tally();
        const call = readSpan(chat({ 'gen_ai.usage.cache_read.input_tokens': 1_500_000 }));
        if (call) {
            tally.add({ ...call, usage: { ...call.usage, inputTokens: 1_800_000 } });
            tally.add(call);
        }
        expect(tally.toString()).toBe('2 calls · 1.84M in (3.00M cached) · 98 out');
    });

    it("takes copilot's own totals from the last shutdown, reasoning folded in", () => {
        const shutdown = (input: number) =>
            JSON.stringify({
                type: 'session.shutdown',
                data: {
                    modelMetrics: {
                        'google/gemini-3.8-flash': {
                            requests: { count: 2 },
                            usage: {
                                inputTokens: input,
                                outputTokens: 3,
                                cacheReadTokens: 39364,
                                cacheWriteTokens: 0,
                                reasoningTokens: 27,
                            },
                        },
                    },
                },
            });
        const events = [shutdown(43824), '{"type":"user.message"}', shutdown(87695)].join('\n');
        expect(shutdownModels(events)).toEqual([
            {
                model: 'google/gemini-3.8-flash',
                calls: 2,
                usage: {
                    inputTokens: 87695,
                    cachedInputTokens: 39364,
                    outputTokens: 30,
                    reasoningTokens: 27,
                },
            },
        ]);
        expect(shutdownModels('{"type":"user.message"}')).toBeUndefined();
    });

    it('knows the model a session was written by, so a resume on another starts afresh', () => {
        const home = mkdtempSync(join(tmpdir(), 'zen-copilot-'));
        const kept = process.env.COPILOT_HOME;
        process.env.COPILOT_HOME = home;
        try {
            const write = (id: string, ...events: object[]) => {
                mkdirSync(join(home, 'session-state', id), { recursive: true });
                writeFileSync(
                    join(home, 'session-state', id, 'events.jsonl'),
                    events.map((e) => JSON.stringify(e)).join('\n'),
                );
            };
            write(
                'answered',
                { type: 'session.start', data: { selectedModel: 'gemini-3.8-flash' } },
                { type: 'assistant.message', data: { model: 'google/gemini-3.8-flash' } },
                // A resume on another model that failed before answering.
                { type: 'session.start', data: { selectedModel: 'claude-sonnet-5-5' } },
            );
            write('silent', { type: 'session.start', data: { selectedModel: 'gpt-5' } });
            expect(sessionModel('answered')).toBe('google/gemini-3.8-flash');
            expect(sessionModel('silent')).toBe('gpt-5');
            expect(sessionModel('missing')).toBeUndefined();
            expect(sameModel('google/gemini-3.8-flash', 'gemini-3.8-flash')).toBe(true);
            expect(sameModel('gemini-3.8-flash', 'claude-sonnet-5-5')).toBe(false);
        } finally {
            if (kept === undefined) {
                delete process.env.COPILOT_HOME;
            } else {
                process.env.COPILOT_HOME = kept;
            }
            rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('where usage is recorded', () => {
    const kept = process.env[LEDGER_ENV];
    afterEach(() => {
        if (kept === undefined) {
            delete process.env[LEDGER_ENV];
        } else {
            process.env[LEDGER_ENV] = kept;
        }
    });

    it('records only in a project being tuned, unless told where', () => {
        delete process.env[LEDGER_ENV];
        const dir = mkdtempSync(join(tmpdir(), 'zen-ledger-'));
        try {
            expect(ledgerPath(dir)).toBeUndefined();
            mkdirSync(join(dir, 'finetune'));
            expect(ledgerPath(dir)).toBe(join(dir, 'finetune', 'usage', 'ledger.jsonl'));
            process.env[LEDGER_ENV] = '/tmp/elsewhere.jsonl';
            expect(ledgerPath(dir)).toBe('/tmp/elsewhere.jsonl');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('re-rendering copilot output', () => {
    const run = (
        events: object[],
    ): { out: Outcome; said: string[]; kept: string[]; shown: string[] } => {
        const said: string[] = [];
        const kept: string[] = [];
        const shown: string[] = [];
        const sink: Sink = {
            answer: (t) => shown.push(t),
            narrate: (l) => said.push(l),
            detail: (l) => kept.push(l),
            warn: (l) => said.push(l),
        };
        const out: Outcome = { answer: '', exitCode: 0, events: [] };
        for (const event of events) {
            absorb(event as never, out, sink, 80);
        }
        return { out, said, kept, shown };
    };

    // `assistant.message` carries both the running commentary and the last
    // word. What separates them is whether it asked for a tool.
    it('keeps the message that asked for no tool as the answer', () => {
        const { out, said, kept } = run([
            { type: 'assistant.message', data: { content: 'Looking.', toolRequests: [{ a: 1 }] } },
            {
                type: 'tool.execution_start',
                data: { toolName: 'bash', arguments: { command: 'ls' } },
            },
            { type: 'assistant.message', data: { content: 'Three files.', toolRequests: [] } },
            { type: 'result', exitCode: 0, sessionId: 's1' },
        ]);
        expect(out.answer).toBe('Three files.');
        expect(out.sessionId).toBe('s1');
        expect(said.join('\n')).toContain('Looking.');
        // A step is for the log, not the screen, where it is a wall of `$`.
        expect(kept.join('\n')).toContain('ls');
        expect(said.join('\n')).not.toContain('ls');
        // The answer is never narrated; it is the thing stdout is for.
        expect(said.join('\n')).not.toContain('Three files.');
    });

    it('takes the exit code from the result event', () => {
        const { out } = run([
            { type: 'session.error', data: { message: 'no' } },
            { type: 'result', exitCode: 1 },
        ]);
        expect(out.exitCode).toBe(1);
    });

    it('ignores an event it does not know rather than inventing a line', () => {
        const { out, said } = run([{ type: 'session.something_new', data: { x: 1 } }]);
        expect(said).toEqual([]);
        expect(out.events).toHaveLength(1);
    });

    // Copilot's own retries are fixed; zen resumes the session only when
    // waiting could change the answer.
    describe('which failures are worth resuming', () => {
        const failed = (data: object, sessionId: string | null = 's1') =>
            transient(
                run([
                    { type: 'session.error', data },
                    { type: 'result', exitCode: 1, sessionId: sessionId ?? undefined },
                ]).out,
            );

        it('resumes a rate limit, a provider outage and a timeout', () => {
            expect(
                failed({
                    errorType: 'rate_limit',
                    message: 'Failed to get response from the AI model; retried 5 times',
                    statusCode: 429,
                }),
            ).toContain('429');
            expect(failed({ errorType: 'query', message: '503', statusCode: 503 })).toContain(
                '503',
            );
            expect(
                failed({ errorType: 'query', message: 'Connection timed out to provider at x' }),
            ).toBeDefined();
        });

        it('does not resume what fails the same way every time', () => {
            expect(
                failed({ errorType: 'query', message: '400 Bad Request', statusCode: 400 }),
            ).toBeUndefined();
            expect(failed({ errorType: 'authentication', statusCode: 403 })).toBeUndefined();
        });

        // The sequence recorded when a background `zen run batch` finished under
        // Gemini 3: copilot's own read_bash carries no thought signature.
        it('resumes a 400 on a tool call copilot injected, not one the model made', () => {
            const error = {
                type: 'session.error',
                data: { errorType: 'query', message: '400 Bad Request', statusCode: 400 },
            };
            const tail = [
                { type: 'assistant.turn_end', data: {} },
                error,
                { type: 'result', exitCode: 1, sessionId: 's1' },
            ];
            const modelCall = {
                type: 'assistant.message',
                data: { model: 'google/gemini-3.8-flash', toolRequests: [{ name: 'bash' }] },
            };
            const injectedCall = {
                type: 'assistant.message',
                data: { content: '', toolRequests: [{ name: 'read_bash' }] },
            };
            const notified = { type: 'system.notification', data: { content: 'done' } };

            expect(transient(run([modelCall, notified, injectedCall, ...tail]).out)).toContain(
                '400',
            );
            expect(transient(run([modelCall, ...tail]).out)).toBeUndefined();
            // A resume that fails again sees only its own turn, so it is not retried twice.
            const user = { type: 'user.message', data: { content: 'Continue' } };
            expect(transient(run([notified, user, ...tail]).out)).toBeUndefined();
        });

        it('cannot resume without a session, nor a run that succeeded', () => {
            expect(failed({ errorType: 'rate_limit', statusCode: 429 }, null)).toBeUndefined();
            const ok = run([{ type: 'result', exitCode: 0, sessionId: 's1' }]).out;
            expect(transient(ok)).toBeUndefined();
        });

        it('waits longer each time, up to a ceiling', () => {
            expect(resumeDelayMs(0)).toBe(30_000);
            expect(resumeDelayMs(1)).toBe(60_000);
            expect(resumeDelayMs(10)).toBe(300_000);
        });
    });

    it('processes progress commentary lines as inline markdown', () => {
        const { said } = run([
            {
                type: 'assistant.message',
                data: {
                    content: 'I am running `snapshot.sh status` and checking **status**.',
                    toolRequests: [{ a: 1 }],
                },
            },
        ]);
        expect(said).toHaveLength(1);
        const line = said[0]!;
        expect(line).not.toContain('`snapshot.sh status`');
        expect(line).toContain('snapshot.sh status');
        expect(term.plain(line)).toBe('I am running snapshot.sh status and checking status.');
    });
});

describe('formatting the answer box', () => {
    let originalIsTTY: boolean | undefined;

    beforeEach(() => {
        originalIsTTY = process.stdout.isTTY;
        process.stdout.isTTY = true;
    });

    afterEach(() => {
        if (originalIsTTY !== undefined) {
            process.stdout.isTTY = originalIsTTY;
        } else {
            delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
    });

    it('returns raw lines when not on a TTY', () => {
        process.stdout.isTTY = false;
        const text = 'line 1\nline 2';
        expect(answerBox(text)).toEqual(['line 1', 'line 2']);
    });

    it('wraps and styles markdown paragraphs with bold, italic, code, and links', () => {
        const text = 'Here is **bold**, *italic*, `code`, and [link](https://example.com).';
        const lines = answerBox(text, 60);
        expect(lines[0]).toBe('');
        // Top and bottom rules have box-drawing characters
        expect(term.plain(lines[1]!)).toMatch(/^╭─+╮$/);
        expect(term.plain(lines[lines.length - 2]!)).toMatch(/^╰─+╯$/);
        // Interior lines contain styled text within borders
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('bold');
        expect(body).toContain('italic');
        expect(body).toContain('code');
        expect(body).toContain('link');
    });

    it('formats headings with bold weight', () => {
        const text = '## Section Title\n\nSome body text.';
        const lines = answerBox(text, 60);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('Section Title');
    });

    it('formats list items with hanging indentation', () => {
        const text = '- first point with enough text to wrap onto another line\n- second point';
        const lines = answerBox(text, 40);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('•');
        expect(body).toContain('first point');
    });

    it('formats quotes with a left bar', () => {
        const text = '> Important notice quoted here';
        const lines = answerBox(text, 50);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('│');
        expect(body).toContain('Important notice');
    });

    it('formats fenced code blocks within inner chrome', () => {
        const text = '```ts\nconst x = 42;\n```';
        const lines = answerBox(text, 50);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('┌─ ts');
        expect(body).toContain('const x = 42;');
        expect(body).toContain('└─');
    });

    it('formats tables with headers and aligned columns', () => {
        const text = '| Name | Status |\n| - | - |\n| web | ok |';
        const lines = answerBox(text, 50);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('Name');
        expect(body).toContain('Status');
        expect(body).toContain('web');
        expect(body).toContain('ok');
    });

    it('ensures every row of the box matches the same outer width', () => {
        const text =
            '# Heading\n\nA paragraph with **bold** and `code`.\n\n- item 1\n- item 2\n\n```sh\necho hi\n```';
        const lines = answerBox(text, 50);
        const outer = term.plain(lines[1]!).length;
        expect(outer).toBeGreaterThan(20);
        for (const line of lines.slice(1, -1)) {
            // plain visible length of every border row must be identical
            expect(term.plain(line).length).toBe(outer);
        }
    });

    it('formats markdown directly via formatMarkdown', () => {
        const text = 'A paragraph with **bold** and `code`.';
        const lines = formatMarkdown(text, 50);
        expect(lines).toHaveLength(1);
        expect(term.plain(lines[0]!)).toBe('A paragraph with bold and code.');
        expect(lines[0]!).toContain('\u001b[1mbold\u001b[22m');
        expect(lines[0]!).toContain('\u001b[32mcode\u001b[39m');
    });

    it('formats inline markdown via formatInline', () => {
        const text = 'Running `zen check` on **acme** with [link](https://acme.dev).';
        const formatted = formatInline(text);
        expect(formatted).not.toContain('`zen check`');
        expect(formatted).not.toContain('**acme**');
        expect(term.plain(formatted)).toBe('Running zen check on acme with link.');
    });
});
