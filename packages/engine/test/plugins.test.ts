import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityTools, loadProject } from '@zenera/neo';
import { afterEach, describe, expect, it } from 'vitest';
import {
    loadPlugins,
    sessionPathsAt,
    tool,
    type AnyTool,
    type PluginContext,
    type ZenPlugin,
} from '../src/index.ts';

const dirs: string[] = [];
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-plugins-'));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const warnings: string[] = [];
const ctx = (): PluginContext => ({
    user: { id: 'u-1', source: 'host' },
    project: { dir: '/project', name: 'acme' },
    session: sessionPathsAt('/data/users/u-1/sessions/t-1'),
    logger: { warn: (m) => warnings.push(m) },
});

const make = (name: string, group?: string): AnyTool =>
    tool({
        name,
        group,
        description: name,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => name,
    });

const builtins = [make('read_file', 'files'), make('run_command', 'sandbox')];

interface Spy extends ZenPlugin {
    closed: number;
    seen?: PluginContext;
}

function plugin(name: string, tools: AnyTool[] | (() => never)): Spy {
    const p: Spy = {
        name,
        closed: 0,
        tools(c) {
            p.seen = c;
            return typeof tools === 'function' ? tools() : tools;
        },
        close() {
            p.closed++;
        },
    };
    return p;
}

describe('loadPlugins', () => {
    it('collects every plugin tool and tells each plugin who the run is for', async () => {
        const mcp = plugin('mcp', [make('mcp_call', 'mcp'), make('mcp_tools', 'mcp')]);
        const other = plugin('other', [make('other_tool')]);
        const c = ctx();
        const loaded = await loadPlugins([mcp, other], c, builtins);
        expect(loaded.tools.map((t) => t.name)).toEqual(['mcp_call', 'mcp_tools', 'other_tool']);
        expect(mcp.seen).toBe(c);
        expect(mcp.seen?.user?.id).toBe('u-1');
    });

    it('adds nothing for no plugins, or a plugin with no tools', async () => {
        expect((await loadPlugins([], ctx(), builtins)).tools).toEqual([]);
        expect((await loadPlugins([plugin('empty', [])], ctx(), builtins)).tools).toEqual([]);
    });

    it('closes plugins latest first, and a failing close is only a warning', async () => {
        const order: string[] = [];
        const a: ZenPlugin = { name: 'a', tools: () => [], close: () => void order.push('a') };
        const b: ZenPlugin = {
            name: 'b',
            tools: () => [],
            close: () => {
                order.push('b');
                throw new Error('boom');
            },
        };
        warnings.length = 0;
        const loaded = await loadPlugins([a, b], ctx(), builtins);
        await loaded.close();
        expect(order).toEqual(['b', 'a']);
        expect(warnings).toEqual(['plugin b: close failed: boom']);
        await loaded.close();
        expect(order).toEqual(['b', 'a']);
    });

    it('refuses a tool named like a built-in, and closes what it asked', async () => {
        const first = plugin('first', [make('fine')]);
        const bad = plugin('bad', [make('read_file')]);
        await expect(loadPlugins([first, bad], ctx(), builtins)).rejects.toThrow(
            'plugin bad: tool read_file is already a built-in tool',
        );
        expect(first.closed).toBe(1);
        expect(bad.closed).toBe(1);
    });

    it('refuses the same tool from two plugins', async () => {
        await expect(
            loadPlugins([plugin('a', [make('x')]), plugin('b', [make('x')])], ctx(), builtins),
        ).rejects.toThrow('plugin b: tool x is already provided by plugin a');
    });

    it('refuses a plugin tool in a built-in group', async () => {
        await expect(
            loadPlugins([plugin('p', [make('my_read', 'files')])], ctx(), builtins),
        ).rejects.toThrow(
            'plugin p: tool my_read is in group files, which belongs to the built-in tools',
        );
    });

    it('refuses plugins without a name or with the same name', async () => {
        await expect(loadPlugins([plugin(' ', [])], ctx(), builtins)).rejects.toThrow(
            'a plugin has no name',
        );
        await expect(
            loadPlugins([plugin('p', []), plugin('p', [])], ctx(), builtins),
        ).rejects.toThrow('two plugins are named p');
    });

    it('names the plugin whose tools() failed, and closes it', async () => {
        const failing = plugin('mcp', () => {
            throw new Error('no broker configured');
        });
        await expect(loadPlugins([failing], ctx(), builtins)).rejects.toThrow(
            'plugin mcp: no broker configured',
        );
        expect(failing.closed).toBe(1);
    });
});

describe('plugin tools in a project', () => {
    async function selected(tools: string): Promise<string[]> {
        const root = scratch();
        writeFileSync(join(root, 'agents.yaml'), `agents:\n  - name: solo\n    tools: ${tools}\n`);
        const loaded = await loadPlugins(
            [plugin('mcp', [make('mcp_call', 'mcp'), make('mcp_tools', 'mcp')])],
            ctx(),
            builtins,
        );
        const p = await loadProject(root, {
            tools: [...builtins, ...loaded.tools],
            alwaysTools: identityTools(),
        });
        return p.registry.get('solo').tools.map((t) => t.name);
    }

    it('are selected by group like built-ins', async () => {
        expect(await selected('[read_file, "mcp:*"]')).toEqual([
            'read_file',
            'mcp_call',
            'mcp_tools',
            'current_user',
        ]);
    });

    it('reach no agent that did not ask for them', async () => {
        expect(await selected('[read_file]')).toEqual(['read_file', 'current_user']);
    });
});
