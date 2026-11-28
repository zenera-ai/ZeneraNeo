import type { Model, ModelRequest, ModelResponse, ToolCall } from '@zenera/neo';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bindings } from '../src/bindings.ts';
import { Box } from '../src/box.ts';
import { Cache, type CacheOptions } from '../src/cache.ts';
import { Catalog } from '../src/catalog.ts';
import { withPageCount, loadSpec, type Operation } from '../src/spec.ts';
import { WorldStore } from '../src/store.ts';
import { NO_STORY, type Knowledge } from '../src/knowledge.ts';
import { World } from '../src/synth.ts';
import { Checks } from '../src/validate.ts';

// ---------------------------------------------------------------------------
// One model, two agents, no network
//
// The server hands one model to both of its agents, so a test does too: the
// scripted model reads the system prompt to tell the handler writer from the
// world writer and answers each from its own script.
// ---------------------------------------------------------------------------

export const here = dirname(fileURLToPath(import.meta.url));
export const spec = (name: string): string => join(here, 'specs', name);

export interface Turn {
    req: ModelRequest;
    /** the first user message: the brief the agent was started with */
    brief: string;
    /** tool results so far, newest last */
    results: { name: string; content: string }[];
    /** how many times this agent has been called in this run */
    call: number;
}

export type Script = (turn: Turn) => ModelResponse | Promise<ModelResponse>;

export const call = (name: string, args: unknown): ModelResponse => ({
    text: '',
    toolCalls: [
        {
            id: `c${Math.random().toString(36).slice(2, 10)}`,
            name,
            args: JSON.stringify(args),
        } satisfies ToolCall,
    ],
});

export const say = (text: string): ModelResponse => ({ text, toolCalls: [] });

export interface Scripted extends Model {
    builder: Turn[];
    world: Turn[];
}

export function scripted(scripts: { builder?: Script; world?: Script }): Scripted {
    const builder: Turn[] = [];
    const world: Turn[] = [];
    return {
        id: 'scripted',
        builder,
        world,
        async generate(req) {
            const isWorld = (req.system ?? '').startsWith('You populate the world');
            const log = isWorld ? world : builder;
            const script = isWorld ? scripts.world : scripts.builder;
            const first = req.messages.find((m) => m.role === 'user');
            const turn: Turn = {
                req,
                brief: text(first?.content),
                results: req.messages
                    .filter((m) => m.role === 'tool')
                    .map((m) => ({
                        name: (m as { name?: string }).name ?? '',
                        content: text(m.content),
                    })),
                call: req.messages.filter((m) => m.role === 'assistant').length + 1,
            };
            log.push(turn);
            if (!script) {
                throw new Error(`no script for the ${isWorld ? 'world' : 'builder'} agent`);
            }
            return await script(turn);
        },
    };
}

function text(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
            .join('');
    }
    return '';
}

/** A builder that tests each of these modules in turn, then says it is done. */
export function writes(...sources: string[]): Script {
    return (turn) => {
        const tested = turn.results.filter((r) => r.name === 'test_handler').length;
        return tested < sources.length
            ? call('test_handler', { source: sources[tested] })
            : say('done');
    };
}

/** The ids a world brief asks for, when it names any. */
export function idsAsked(brief: string): string[] {
    const m = /values: (\[[^\n]*\])\./.exec(brief);
    return m ? (JSON.parse(m[1]!) as unknown[]).map(String) : [];
}

/** What the agents know, for a test: a story, and optionally docs that answer anything. */
export function knowing(story = NO_STORY, over: Partial<Knowledge> = {}): Knowledge {
    return {
        story,
        storyDigest: '',
        storyFiles: 0,
        tools: [],
        recall: () => Promise.resolve(''),
        close: () => {},
        ...over,
    };
}

export interface Rig {
    root: string;
    bindings: Bindings;
    operations: Operation[];
    store: WorldStore;
    world: World;
    box: Box;
    checks: Checks;
    catalog: Catalog;
    cache: Cache;
    close(): Promise<void>;
}

export async function rig(
    file: string,
    model: Model,
    opts: Partial<CacheOptions> & {
        knowledge?: Knowledge;
        timeout?: number;
        root?: string;
        pageCount?: number;
    } = {},
): Promise<Rig> {
    const root = opts.root ?? mkdtempSync(join(tmpdir(), 'gym-'));
    const operations = (await loadSpec(spec(file))).map((op) =>
        opts.pageCount !== undefined && op.operationId === 'listMachines'
            ? withPageCount(op, opts.pageCount)
            : op,
    );
    const catalog = await Catalog.open([spec(file)]);
    const checks = new Checks();
    const store = new WorldStore(join(root, 'world.sqlite'));
    const bindings = new Bindings(Object.keys(catalog.types), {
        cacheDir: opts.cacheDir ?? join(root, 'store'),
    });
    const world = new World({
        model,
        knowledge: opts.knowledge ?? knowing(),
        catalog,
        bindings,
        store,
    });
    const box = new Box({
        root,
        db: store.path,
        timeout: opts.timeout ?? 10,
        synthesize: world.synthesize,
        bindings: () => bindings.all(),
    });
    const cache = new Cache({
        box,
        checks,
        model,
        catalog,
        world,
        bindings,
        operations,
        cacheDir: join(root, 'store'),
        ...opts,
    });
    return {
        root,
        bindings,
        operations,
        store,
        world,
        box,
        checks,
        catalog,
        cache,
        close: async () => {
            await box.dispose();
            world.close();
            store.close();
            if (!opts.root) {
                rmSync(root, { recursive: true, force: true });
            }
        },
    };
}

export const op = (r: Rig, id: string): Operation => {
    const found = r.operations.find((o) => o.operationId === id);
    if (!found) {
        throw new Error(`no operation ${id}`);
    }
    return found;
};

// ---------------------------------------------------------------------------
// Handlers the tests reuse
// ---------------------------------------------------------------------------

/** getUserById done right: the user, from the world, keyed by the path. */
export const GET_USER = `
interface User { user_id: number; email: string }
export default async function handle(req: any, ctx: any): Promise<User> {
    return await ctx.lookup('User', req.pathParams.user_id, { idField: 'user_id' });
}`;

/** The same, forgetting the required email. */
export const GET_USER_NO_EMAIL = `
export default async function handle(req: any, ctx: any) {
    const u = await ctx.lookup('User', req.pathParams.user_id, { idField: 'user_id' });
    return { user_id: u.user_id };
}`;

/** Validates, and is about somebody else. */
export const GET_USER_CONSTANT = `
export default async function handle() {
    return { user_id: 999, email: 'someone@example.com' };
}`;

export const CREATE_USER = `
export default async function handle(req: any, ctx: any) {
    ctx.db.collection('User').put(req.body.user_id, req.body);
    return req.body;
}`;

export const GET_SELF = `
export default async function handle(req: any, ctx: any) {
    const me = await ctx.owner();
    return { user_id: 1, email: me.email };
}`;

export const STOP_PING = `
export default async function handle(req: any, ctx: any) {
    ctx.db.collection('pings').put('stopped', { id: 'stopped', at: ctx.now() });
    return null;
}`;
