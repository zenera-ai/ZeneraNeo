import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Model, ModelRequest, ModelResponse } from '../src/model.ts';
import {
    AgentProject,
    loadProject,
    memoryDir,
    parseConfig,
    projectPath,
} from '../src/project/index.ts';
import { fileTools } from '../src/tools/files.ts';
import { tool, zeroUsage } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
//
// Projects are written to a temp directory rather than committed, so each test
// can show the one file it is about instead of the reader having to hold a
// shared fixture tree in their head.
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
    for (const r of roots.splice(0)) {
        rmSync(r, { recursive: true, force: true });
    }
});

/** Writes a project tree; keys are paths relative to the root. */
function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'zn-project-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
        const path = join(root, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, 'utf8');
    }
    return root;
}

const MINIMAL = {
    'agents/instructions.md': 'Be terse.',
    'agents.yaml': `
agents:
  - name: solo
    system: agents/prompts/solo.md
`,
    'agents/prompts/solo.md': 'You answer questions.',
};

const lookup = tool({
    name: 'lookup',
    description: 'Looks something up.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
});

const quote = tool({
    name: 'quote',
    description: 'Quotes a price.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ eur: 42 }),
});

/** A group, so a config can name the set rather than count its members. */
const grouped = ['fs_read', 'fs_write', 'fs_delete'].map((name) =>
    tool({
        name,
        group: 'files',
        description: name,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => 'ok',
    }),
);

const SKILL = `---
name: pricing
description: How things are priced.
tools: [quote]
---
Quote with the tool.
`;

const STYLE = `---
name: style
description: How to write.
---
Be brief.
`;

// ---------------------------------------------------------------------------

describe('project layout', () => {
    it('assembles agents, prompts and the shared house rules', async () => {
        const p = await loadProject(project(MINIMAL));

        expect(p.registry.names()).toEqual(['solo']);
        const instructions = p.registry.get('solo').instructions as { src: string }[];
        expect(instructions.map((i) => i.src)).toEqual([
            'agents/instructions.md',
            'agents/prompts/solo.md',
        ]);
    });

    /**
     * Filename order, because it is the only order that is the same on every
     * machine and is visible without opening another file.
     */
    it('prepends every agents/<topic>-instructions.md, in filename order', async () => {
        const p = await loadProject(
            project({
                ...MINIMAL,
                'agents/memory-instructions.md': 'Never grep /memory.',
                'agents/aaa-instructions.md': 'First.',
                // Neither of these is an instructions file, and a walk that
                // took the directory rather than the suffix would swallow both.
                'agents/prompts/ignored-instructions.md': 'Not mine.',
                'agents/notes.md': 'Not mine either.',
            }),
        );
        const instructions = p.registry.get('solo').instructions as { src: string }[];
        expect(instructions.map((i) => i.src)).toEqual([
            'agents/instructions.md',
            'agents/aaa-instructions.md',
            'agents/memory-instructions.md',
            'agents/prompts/solo.md',
        ]);
    });

    it('falls back to agents/prompts/<name>.md when `system` is absent', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': 'agents:\n  - name: solo\n',
                'agents/prompts/solo.md': 'You answer questions.',
            }),
        );
        const instructions = p.registry.get('solo').instructions as { path: string }[];
        expect(instructions).toHaveLength(1);
        expect(instructions[0].path.endsWith('solo.md')).toBe(true);
    });

    it('shares one house-rules object across every agent', async () => {
        const p = await loadProject(
            project({
                ...MINIMAL,
                'agents.yaml':
                    'agents:\n  - name: solo\n    system: agents/prompts/solo.md\n' +
                    '  - name: other\n    system: agents/prompts/solo.md\n',
            }),
        );
        const a = (p.registry.get('solo').instructions as unknown[])[0];
        const b = (p.registry.get('other').instructions as unknown[])[0];
        // Same object, so the same bytes hash once and the report shows one
        // document feeding two prompts.
        expect(a).toBe(b);
    });

    it('resolves tool names against ProjectOptions.tools', async () => {
        const p = await loadProject(
            project({
                ...MINIMAL,
                'agents.yaml':
                    'agents:\n  - name: solo\n    system: agents/prompts/solo.md\n' +
                    '    tools: [lookup]\n',
            }),
            { tools: [lookup] },
        );
        expect(p.registry.get('solo').tools.map((t) => t.name)).toEqual(['lookup']);
    });

    it('builds a skill catalog and binds it', async () => {
        const p = await loadProject(
            project({
                ...MINIMAL,
                'agents.yaml':
                    'agents:\n  - name: solo\n    system: agents/prompts/solo.md\n' +
                    '    skills:\n      discovery: search\n      preload: [style]\n',
                'agents/skills/pricing/SKILL.md': SKILL,
                'agents/skills/style/SKILL.md': STYLE,
            }),
            { tools: [quote] },
        );

        expect(p.skillProviders.map((s) => s.id)).toEqual(['project']);
        expect(p.registry.get('solo').skills).toEqual({
            provider: 'project',
            discovery: 'search',
            allow: undefined,
            preload: ['style'],
            maxIndexEntries: undefined,
        });
        // The skill's tool resolved from the same registry the agents use.
        expect(p.skillProviders[0].tool('quote')?.name).toBe('quote');
    });

    it('binds fork, and leaves an agent that never mentions it unable to', async () => {
        const p = await loadProject(
            project({
                'agents.yaml':
                    'agents:\n  - name: trunk\n    fork:\n' +
                    '      agents: [trunk, lens]\n      maxBranches: 4\n' +
                    '  - name: opener\n    fork: true\n' +
                    '  - name: lens\n',
            }),
        );

        expect(p.registry.get('trunk').fork).toEqual({ agents: ['trunk', 'lens'], maxBranches: 4 });
        // `true` is the unrestricted form, and the kernel offers the tool on the
        // binding's presence alone — so an empty object is the whole opt-in.
        expect(p.registry.get('opener').fork).toEqual({});
        expect(p.registry.get('lens').fork).toBeUndefined();
    });
});

describe('conditional house rules', () => {
    const TWO_AGENTS =
        'agents:\n  - name: trunk\n    fork: true\n    memory: true\n  - name: lens\n';

    const srcs = (p: AgentProject, name: string): string[] =>
        (p.registry.get(name).instructions as { src: string }[]).map((i) => i.src);

    it('reaches only the agents that have what the document requires', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': TWO_AGENTS,
                'agents/instructions.md': 'Be terse.',
                'agents/fork-instructions.md': '---\nrequires: [fork]\n---\nBranches are runs.',
                'agents/memory-instructions.md': '---\nrequires: [memory]\n---\nNever grep it.',
            }),
        );
        expect(srcs(p, 'trunk')).toEqual([
            'agents/instructions.md',
            'agents/fork-instructions.md',
            'agents/memory-instructions.md',
        ]);
        expect(srcs(p, 'lens')).toEqual(['agents/instructions.md']);
    });

    it('holds every condition a document names, not just the first', async () => {
        const p = await loadProject(
            project({
                'agents.yaml':
                    'agents:\n  - name: writer\n    memory: true\n' +
                    '  - name: reader\n    memory:\n      access: read\n',
                'agents/commit-instructions.md':
                    '---\nrequires: [memory, memory-write]\n---\nSay what changed.',
            }),
        );
        expect(srcs(p, 'writer')).toEqual(['agents/commit-instructions.md']);
        expect(srcs(p, 'reader')).toEqual([]);
    });

    it('conditions files instructions on agent tool selectors', async () => {
        const dummySandbox = tool({
            name: 'run_command',
            group: 'sandbox',
            description: 'run',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: () => 'ok',
        });
        const tools = [...fileTools({ root: tmpdir() }), dummySandbox];
        const p = await loadProject(
            project({
                'agents.yaml':
                    'agents:\n' +
                    '  - name: full\n    tools: [files:*]\n' +
                    '  - name: readonly\n    tools: [files:*, -write_file, -apply_patch, -copy_file, -move_file, -delete_file]\n' +
                    '  - name: legacy\n    tools: [workspace:*]\n' +
                    '  - name: none\n    tools: [sandbox:*]\n',
                'agents/files-instructions.md': '---\nrequires: [files]\n---\nRead carefully.',
                'agents/write-instructions.md': '---\nrequires: [files-write]\n---\nPatch cleanly.',
            }),
            { tools },
        );
        expect(srcs(p, 'full')).toEqual([
            'agents/files-instructions.md',
            'agents/write-instructions.md',
        ]);
        expect(srcs(p, 'readonly')).toEqual(['agents/files-instructions.md']);
        expect(srcs(p, 'legacy')).toEqual([
            'agents/files-instructions.md',
            'agents/write-instructions.md',
        ]);
        expect(srcs(p, 'none')).toEqual([]);
    });

    it('conditions a tools:<group> document on any grant of that group', async () => {
        const mcp = ['mcp_servers', 'mcp_tools', 'mcp_describe', 'mcp_call'].map((name) =>
            tool({
                name,
                group: 'mcp',
                description: name,
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                execute: () => 'ok',
            }),
        );
        const tools = [...fileTools({ root: tmpdir() }), ...mcp];
        const p = await loadProject(
            project({
                'agents.yaml':
                    'agents:\n' +
                    '  - name: group\n    tools: [mcp:*]\n' +
                    '  - name: lookonly\n    tools: [mcp:*, -mcp_call]\n' +
                    '  - name: bare\n    tools: [mcp_call]\n' +
                    '  - name: all\n    tools: ["*"]\n' +
                    '  - name: withdrawn\n    tools: ["*", "-mcp:*"]\n' +
                    '  - name: none\n    tools: [files:*]\n',
                'agents/mcp-instructions.md': '---\nrequires: [tools:mcp]\n---\nDescribe first.',
            }),
            { tools },
        );
        for (const name of ['group', 'lookonly', 'bare', 'all']) {
            expect(srcs(p, name)).toContain('agents/mcp-instructions.md');
        }
        for (const name of ['withdrawn', 'none']) {
            expect(srcs(p, name)).not.toContain('agents/mcp-instructions.md');
        }
    });

    it('refuses tools: with no group', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': TWO_AGENTS,
                    'agents/odd-instructions.md': '---\nrequires: ["tools:"]\n---\nHm.',
                }),
            ),
        ).rejects.toThrow(/agents\/odd-instructions\.md.*tools:/s);
    });

    it('leaves a document without frontmatter unconditional, header and all', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': TWO_AGENTS,
                'agents/instructions.md': '# Rules\n\nBe terse.',
            }),
        );
        const part = (p.registry.get('lens').instructions as { text: string }[])[0];
        expect(part.text).toBe('# Rules\n\nBe terse.');
    });

    it('strips the frontmatter from what the model reads', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': TWO_AGENTS,
                'agents/fork-instructions.md': '---\nrequires: [fork]\n---\n\nBranches are runs.',
            }),
        );
        const part = (p.registry.get('trunk').instructions as { text: string }[])[0];
        expect(part.text).toBe('Branches are runs.');
    });

    it('refuses a capability nothing can grant, naming the file', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': TWO_AGENTS,
                    'agents/odd-instructions.md': '---\nrequires: [telepathy]\n---\nHm.',
                }),
            ),
        ).rejects.toThrow(/agents\/odd-instructions\.md.*telepathy/s);
    });

    /**
     * The other half of the fork gate. The binding is a property of the config
     * and settles at load; the depth cap is a property of the run, and takes
     * the tool away without the config changing — so the prose has to go with
     * it, or the model is told how to use something it has not got.
     */
    it('drops the fork rules once the depth cap has taken the tool away', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': 'agents:\n  - name: trunk\n    fork: true\n',
                'agents/instructions.md': 'Be terse.',
                'agents/fork-instructions.md': '---\nrequires: [fork]\n---\nBranches are runs.',
            }),
        );
        expect(await systemOf(p)).toContain('Branches are runs.');
        expect(await systemOf(p, { maxForkDepth: 0 })).not.toContain('Branches are runs.');
    });
});

describe('entrypoint', () => {
    const two = (extra = '') => `${extra}agents:\n  - name: first\n  - name: second\n`;

    it('prefers an explicit top-level default', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': two('default: second\n'),
                'agents/prompts/first.md': 'a',
                'agents/prompts/second.md': 'b',
            }),
        );
        expect(p.entry).toBe('second');
    });

    it('then an agent that claims it', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': 'agents:\n  - name: first\n  - name: second\n    default: true\n',
            }),
        );
        expect(p.entry).toBe('second');
    });

    it('then the first declared', async () => {
        const p = await loadProject(project({ 'agents.yaml': two() }));
        expect(p.entry).toBe('first');
    });

    it('rejects two claimants', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml':
                        'agents:\n  - name: first\n    default: true\n' +
                        '  - name: second\n    default: true\n',
                }),
            ),
        ).rejects.toThrow(/more than one agent claims/);
    });

    it('rejects a default naming nobody', async () => {
        await expect(
            loadProject(project({ 'agents.yaml': two('default: third\n') })),
        ).rejects.toThrow(/unknown agent "third"/);
    });
});

describe('tool selectors', () => {
    /** Loads a one-agent project whose `tools:` is the given yaml list. */
    async function chosen(list: string, available = [...grouped, lookup]): Promise<string[]> {
        const p = await loadProject(
            project({ 'agents.yaml': `agents:\n  - name: solo\n    tools: ${list}\n` }),
            { tools: available },
        );
        return p.registry.get('solo').tools.map((t) => t.name);
    }

    it('takes a whole group with <group>:*', async () => {
        expect(await chosen('[files:*]')).toEqual(['fs_read', 'fs_write', 'fs_delete']);
    });

    it("takes everything with '*'", async () => {
        expect(await chosen("['*']")).toEqual(['fs_read', 'fs_write', 'fs_delete', 'lookup']);
    });

    it('subtracts what a later entry excludes', async () => {
        expect(await chosen('[files:*, -fs_delete]')).toEqual(['fs_read', 'fs_write']);
    });

    it('applies selectors in order, so a group can be added back', async () => {
        expect(await chosen('[files:*, -fs_delete, fs_delete]')).toEqual([
            'fs_read',
            'fs_write',
            'fs_delete',
        ]);
    });

    it('keeps the first position of a tool a group repeats', async () => {
        expect(await chosen('[fs_delete, files:*]')).toEqual(['fs_delete', 'fs_read', 'fs_write']);
    });

    it('ignores an exclusion that matches nothing selected', async () => {
        expect(await chosen('[fs_read, -lookup]')).toEqual(['fs_read']);
    });

    it('reads a bare name exactly, with no globbing', async () => {
        await expect(chosen('[fs_*]')).rejects.toThrow(/unknown tool "fs_\*"/);
    });

    it('rejects a group nobody is in, and lists the ones that exist', async () => {
        await expect(chosen('[web:*]')).rejects.toThrow(
            /no tools in group "web" \(known groups: files\)/,
        );
    });

    it('rejects a selector that excludes nothing in particular', async () => {
        await expect(chosen("['-', fs_read]")).rejects.toThrow(/empty tool selector/);
    });

    it('survives the round trip through yaml unquoted', async () => {
        expect(await chosen('\n          - files:*\n          - -fs_delete')).toEqual([
            'fs_read',
            'fs_write',
        ]);
    });
});

describe('validation', () => {
    it('names the yaml path in a schema error', () => {
        expect(() =>
            parseConfig(
                'agents:\n  - name: solo\n    skills:\n      discovery: auto\n',
                'agents.yaml',
            ),
        ).toThrow(/agents\[0\]\.skills\.discovery/);
    });

    it('rejects an unknown key rather than ignoring it', () => {
        expect(() =>
            parseConfig('agents:\n  - name: solo\n    colour: blue\n', 'agents.yaml'),
        ).toThrow(/agents\[0\] — Unrecognized key: "colour"/);
    });

    it('rejects a malformed name', () => {
        expect(() => parseConfig('agents:\n  - name: Solo Agent\n', 'agents.yaml')).toThrow(
            /lower-case words/,
        );
    });

    /**
     * A Dockerfile names its own base in its FROM line, so a config that gave
     * both would have one of them quietly win. Refusing is the only reading
     * that cannot be wrong.
     */
    it('rejects an image and a Dockerfile together', () => {
        expect(() =>
            parseConfig(
                'sandbox:\n    image: python:3.14\n    build:\n' +
                    '        dockerfile: sandbox/Dockerfile\n' +
                    'agents:\n  - name: solo\n',
                'agents.yaml',
            ),
        ).toThrow(/image and build cannot both be set/);
    });

    it('takes a Dockerfile with an optional context', () => {
        const config = parseConfig(
            'sandbox:\n    build:\n        dockerfile: docker/Dockerfile\n' +
                '        context: .\n' +
                'agents:\n  - name: solo\n',
            'agents.yaml',
        );
        expect(config.sandbox?.build).toEqual({ dockerfile: 'docker/Dockerfile', context: '.' });
    });

    it('rejects a hand-off to nobody', async () => {
        await expect(
            loadProject(
                project({ 'agents.yaml': 'agents:\n  - name: solo\n    handoffs: [ghost]\n' }),
            ),
        ).rejects.toThrow(/unknown agent "ghost"/);
    });

    it('rejects a hand-off to self', async () => {
        await expect(
            loadProject(
                project({ 'agents.yaml': 'agents:\n  - name: solo\n    handoffs: [solo]\n' }),
            ),
        ).rejects.toThrow(/cannot hand off to itself/);
    });

    it('rejects an unregistered tool name', async () => {
        await expect(
            loadProject(
                project({ 'agents.yaml': 'agents:\n  - name: solo\n    tools: [missing]\n' }),
            ),
        ).rejects.toThrow(/unknown tool "missing"/);
    });

    it('rejects a fork branch running nobody', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    fork:\n      agents: [ghost]\n',
                }),
            ),
        ).rejects.toThrow(/fork\.agents: unknown agent "ghost"/);
    });

    it('lets a fork branch run the agent that forked it', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': 'agents:\n  - name: solo\n    fork:\n      agents: [solo]\n',
            }),
        );
        expect(p.registry.get('solo').fork?.agents).toEqual(['solo']);
    });

    it('takes a branch cap of one as delegation without fan-out', async () => {
        const p = await loadProject(
            project({
                'agents.yaml': 'agents:\n  - name: solo\n    fork:\n      maxBranches: 1\n',
            }),
        );
        expect(p.registry.get('solo').fork?.maxBranches).toBe(1);
    });

    it('rejects a branch cap no call could satisfy', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    fork:\n      maxBranches: 0\n',
                }),
            ),
        ).rejects.toThrow(/fork\.maxBranches/);
    });

    it('rejects a preload naming a skill the catalog does not have', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    skills:\n      preload: [ghost]\n',
                    'agents/skills/style/SKILL.md': STYLE,
                }),
            ),
        ).rejects.toThrow(/skills\.preload: unknown skill "ghost"/);
    });

    it('rejects a preload the allow list would hide', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml':
                        'agents:\n  - name: solo\n    skills:\n' +
                        '      allow: [pricing]\n      preload: [style]\n',
                    'agents/skills/pricing/SKILL.md': SKILL,
                    'agents/skills/style/SKILL.md': STYLE,
                }),
                { tools: [quote] },
            ),
        ).rejects.toThrow(/"style" is not in `allow`/);
    });

    it('rejects skills without a catalog to bind to', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    skills:\n      discovery: index\n',
                }),
            ),
        ).rejects.toThrow(/no skill provider/);
    });

    it('reports a missing configuration file', async () => {
        await expect(loadProject(project({ 'README.md': 'x' }))).rejects.toThrow(
            /no project configuration/,
        );
    });
});

describe('model configuration', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // Every provider in this suite is an OpenAI one; `ProviderClient` is a
    // union across three SDKs, so the assertions say which.
    const openai = (client: unknown): { apiKey?: string; baseURL?: string } =>
        client as { apiKey?: string; baseURL?: string };

    const YAML = `
providers:
  house:
    apiKey: \${ZN_HOUSE_KEY}
  house-eu:
    apiKey: \${ZN_EU_KEY}
    baseURL: https://eu.example/v1
models:
  fast: house:gpt-4o-mini
  local:
    provider: house-eu
    api: responses
    model: o3
provider: house
model: fast
agents:
  - name: solo
  - name: eu
    model: local
`;

    it('declares providers, resolves aliases, and shares one client per name', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_EU_KEY', 'sk-eu');

        const p = await loadProject(project({ 'agents.yaml': YAML }));

        expect(p.registry.get('solo').model?.id).toBe('gpt-4o-mini');
        expect(p.registry.get('eu').model?.id).toBe('o3');
        expect(openai(p.models.client('house')).apiKey).toBe('sk-house');
        expect(openai(p.models.client('house-eu')).apiKey).toBe('sk-eu');
        expect(openai(p.models.client('house-eu')).baseURL).toBe('https://eu.example/v1');
        expect(p.models.defaultProvider).toBe('house');
    });

    it('hands two agents naming one alias the same model object', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_EU_KEY', 'sk-eu');

        const p = await loadProject(
            project({ 'agents.yaml': `${YAML}  - name: twin\n    model: fast\n` }),
        );
        expect(p.registry.get('twin').model).toBe(p.registry.get('solo').model);
    });

    it('never touches a provider no agent reaches for', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_UNUSED_KEY', '');

        // `gemini` has no resolvable key, and loading does not care: nothing
        // points at it. A project may name a vendor this deployment lacks.
        const p = await loadProject(
            project({
                'agents.yaml':
                    'providers:\n  house:\n    apiKey: ${ZN_HOUSE_KEY}\n' +
                    '  gemini:\n    kind: google\n    apiKey: ${ZN_UNUSED_KEY}\n' +
                    'provider: house\nmodel: gpt-4o\nagents:\n  - name: solo\n',
            }),
        );
        expect(p.registry.get('solo').model?.id).toBe('gpt-4o');
        expect(() => p.models.client('gemini')).toThrow('${ZN_UNUSED_KEY} is not set');
    });

    it('lets ProjectOptions override a declared provider', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_EU_KEY', 'sk-eu');

        const p = await loadProject(project({ 'agents.yaml': YAML }), {
            providers: { house: { apiKey: 'sk-from-host' } },
        });
        expect(openai(p.models.client('house')).apiKey).toBe('sk-from-host');
    });

    it('lets ProjectOptions.models win over the config alias', async () => {
        vi.stubEnv('ZN_HOUSE_KEY', 'sk-house');
        vi.stubEnv('ZN_EU_KEY', 'sk-eu');

        const p = await loadProject(project({ 'agents.yaml': YAML }), {
            models: { fast: 'house:gpt-5-nano' },
        });
        expect(p.registry.get('solo').model?.id).toBe('gpt-5-nano');
    });

    it('names the agent whose model ref does not resolve', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    model: ghost:gpt-4o\n',
                }),
            ),
        ).rejects.toThrow(/agents\.solo\.model: unknown provider "ghost"/);
    });

    it('catches a bad provider name in an alias nothing uses', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml':
                        'models:\n  spare:\n    provider: ghost\n    model: gpt-4o\n' +
                        'agents:\n  - name: solo\n',
                }),
            ),
        ).rejects.toThrow(/models\.spare\.provider: unknown provider "ghost"/);
    });

    it('rejects a default provider that is not declared', async () => {
        await expect(
            loadProject(project({ 'agents.yaml': 'provider: ghost\nagents:\n  - name: solo\n' })),
        ).rejects.toThrow(/default provider "ghost" is not declared/);
    });
});

describe('path safety', () => {
    it('refuses a reference that escapes the root', () => {
        expect(() => projectPath('/srv/app', '../../etc/passwd', 'agents.solo.system')).toThrow(
            /resolves outside the project root/,
        );
    });

    it('refuses an absolute reference outside the root', () => {
        expect(() => projectPath('/srv/app', '/etc/passwd', 'agents.solo.system')).toThrow(
            /resolves outside the project root/,
        );
    });

    it('allows a plain relative reference', () => {
        expect(projectPath('/srv/app', 'agents/prompts/solo.md', 'x')).toBe(
            '/srv/app/agents/prompts/solo.md',
        );
    });

    it('refuses a file:// url naming a host', () => {
        expect(() => projectPath('/srv/app', 'file://elsewhere/x.md', 'x')).toThrow(/names a host/);
    });

    it('stops a `system` reference from reading outside the project', async () => {
        await expect(
            loadProject(
                project({
                    'agents.yaml': 'agents:\n  - name: solo\n    system: ../../secrets.md\n',
                }),
            ),
        ).rejects.toThrow(/resolves outside the project root/);
    });
});

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

class Fixed implements Model {
    readonly id = 'fixed';
    calls = 0;

    generate(): Promise<ModelResponse> {
        this.calls++;
        return Promise.resolve({
            text: 'answered',
            toolCalls: [],
            stopReason: 'stop',
            usage: zeroUsage(),
        });
    }
}

/** What the model was actually offered — the only honest measure of a binding. */
async function toolNames(p: AgentProject): Promise<string[]> {
    let seen: string[] = [];
    const model: Model = {
        id: 'spy',
        generate: (req: ModelRequest) => {
            seen = (req.tools ?? []).map((t) => t.name);
            return Promise.resolve({
                text: 'ok',
                toolCalls: [],
                stopReason: 'stop' as const,
                usage: zeroUsage(),
            });
        },
    };
    await p.runner({ model, stream: false }).run(p.entry, 'hello');
    return seen;
}

/** The system prompt the provider would have seen, for the entry agent. */
async function systemOf(p: AgentProject, opts: { maxForkDepth?: number } = {}): Promise<string> {
    let seen = '';
    const model: Model = {
        id: 'spy',
        generate: (req: ModelRequest) => {
            seen = req.system ?? '';
            return Promise.resolve({
                text: 'ok',
                toolCalls: [],
                stopReason: 'stop' as const,
                usage: zeroUsage(),
            });
        },
    };
    await p.runner({ model, stream: false }).run(p.entry, 'hello', opts);
    return seen;
}

describe('running a project', () => {
    it('runs the entry agent end to end', async () => {
        const p = await loadProject(project(MINIMAL));
        const res = await p.runner({ model: new Fixed(), stream: false }).run(p.entry, 'hello');

        expect(res.output).toBe('answered');
        expect(res.state.agentName).toBe('solo');
    });

    it('memoizes the shared runner but not an overridden one', async () => {
        const p = await loadProject(project(MINIMAL));
        expect(p.runner()).toBe(p.runner());
        expect(p.runner({ stream: false })).not.toBe(p.runner());
    });

    it('keeps two chats on one project independent', async () => {
        const p = await loadProject(project(MINIMAL));
        const runner = p.runner({ model: new Fixed(), stream: false });

        const [a, b] = await Promise.all([
            runner.run(p.entry, 'first').final(),
            runner.run(p.entry, 'second').final(),
        ]);

        expect(a.state.runId).not.toBe(b.state.runId);
        // Neither transcript picked up the other's input.
        expect(a.state.trajectory.length).toBe(b.state.trajectory.length);
    });
});

describe('memory in agents.yaml', () => {
    const withMemory = (body: string) => ({
        'agents.yaml': `agents:\n  - name: solo\n${body}`,
    });

    it('opens no memory, and creates no directory, for a project that never mentions it', async () => {
        const root = project(MINIMAL);
        const p = await loadProject(root);
        expect(p.memory).toBeUndefined();
        expect(existsSync(join(root, 'memory'))).toBe(false);
    });

    it('gives `memory: true` the four tools, read-write, with auto-recall on', async () => {
        const root = project(withMemory('    memory: true\n'));
        const p = await loadProject(root);
        try {
            expect(p.memory).toBeDefined();
            expect(p.agents[0]!.memoryBinding(undefined)).toEqual({
                access: 'read-write',
                sees: ['*'],
                writes: ['*'],
                autoRecall: { query: 'last_user_input', limit: 10 },
            });
        } finally {
            p.close();
        }
    });

    it('leaves a read-only agent without the writing tools', async () => {
        const p = await loadProject(project(withMemory('    memory:\n      access: read\n')));
        try {
            const names = await toolNames(p);
            expect(names).toContain('memory_search');
            expect(names).toContain('memory_load');
            expect(names).not.toContain('memory_commit');
            expect(names).not.toContain('memory_forget');
        } finally {
            p.close();
        }
    });

    it('offers memory_forget only at full access', async () => {
        const p = await loadProject(project(withMemory('    memory:\n      access: full\n')));
        try {
            expect(await toolNames(p)).toContain('memory_forget');
        } finally {
            p.close();
        }
    });

    it('clamps every agent to recall when the host opens the memory read-only', async () => {
        const root = project(withMemory('    memory:\n      access: full\n'));
        // A read-only open has to find a memory, so make one the ordinary way.
        const made = await loadProject(root);
        await made.memory!.commit(
            { nodes: [{ ref: 'a', kind: 'fact', text: 'the invoice threshold is 500' }] },
            {
                writes: ['*'],
                sees: ['*'],
                clock: { newId: () => 'ID1', now: () => '2026-01-01T00:00:00.000Z' },
            },
        );
        made.close();

        const p = await loadProject(root, { memoryReadOnly: true });
        try {
            expect(p.agents[0]!.memoryBinding(undefined)?.access).toBe('read');
            const names = await toolNames(p);
            expect(names).toContain('memory_search');
            expect(names).toContain('memory_load');
            expect(names).not.toContain('memory_commit');
            expect(names).not.toContain('memory_forget');
        } finally {
            p.close();
        }
    });

    it('adds the public slice to `sees` rather than replacing it', async () => {
        const p = await loadProject(
            project(withMemory('    memory:\n      sees: [triage]\n      writes: [triage]\n')),
        );
        try {
            expect(p.agents[0]!.memoryBinding(undefined)).toMatchObject({
                sees: ['*', 'triage'],
                writes: ['triage'],
            });
        } finally {
            p.close();
        }
    });

    it('turns auto-recall off without giving up the tools', async () => {
        const p = await loadProject(project(withMemory('    memory:\n      autoRecall: false\n')));
        try {
            expect(p.agents[0]!.memoryBinding(undefined)?.autoRecall).toBeUndefined();
            expect(await toolNames(p)).toContain('memory_search');
        } finally {
            p.close();
        }
    });

    it('puts the graph where `memory.dir` says', async () => {
        const root = project({
            'agents.yaml': 'memory:\n  dir: brain\nagents:\n  - name: solo\n    memory: true\n',
        });
        const p = await loadProject(root);
        try {
            expect(memoryDir(root, p.config)).toBe(join(root, 'brain'));
            expect(existsSync(join(root, 'brain', 'files'))).toBe(true);
        } finally {
            p.close();
        }
    });

    it('lets the host name another directory for the graph', async () => {
        const root = project({
            'agents.yaml': 'memory:\n  dir: brain\nagents:\n  - name: solo\n    memory: true\n',
        });
        const away = join(root, 'away');
        const p = await loadProject(root, { memoryDir: away });
        try {
            expect(memoryDir(root, p.config, away)).toBe(away);
            expect(memoryDir(root, p.config, 'rel')).toBe(join(root, 'rel'));
            expect(existsSync(join(away, 'files'))).toBe(true);
            expect(existsSync(join(root, 'brain'))).toBe(false);
        } finally {
            p.close();
        }
    });

    it('takes a named directory as the declaration of memory', async () => {
        const root = project({ 'agents.yaml': 'agents:\n  - name: solo\n' });
        const p = await loadProject(root);
        try {
            expect(memoryDir(root, p.config)).toBeUndefined();
            expect(memoryDir(root, p.config, 'brain')).toBe(join(root, 'brain'));
        } finally {
            p.close();
        }
    });

    it('refuses a key it does not honour', () => {
        expect(() =>
            parseConfig('agents:\n  - name: a\n    memory:\n      scope: user\n', 'agents.yaml'),
        ).toThrow(/scope/);
    });

    it('refuses an access level that is not one of the three', () => {
        expect(() =>
            parseConfig('agents:\n  - name: a\n    memory:\n      access: write\n', 'agents.yaml'),
        ).toThrow(/access/);
    });
});
