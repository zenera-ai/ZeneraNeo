import { frontmatter, toList } from '@zenera/neo';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { refreshShared, scaffold } from '../src/scaffold.ts';
import { validateProject, type Finding } from '../src/validate.ts';

// ---------------------------------------------------------------------------
// The MCP house rules
//
// The `mcp` tools come from Zenera's plugin, not from `zen`, so these two
// files are the only thing that explains them to a model. They are gated on a
// grant of the group, which is a `requires:` the loader resolves from
// `agents.yaml` alone, and `zen check` reports them missing the same way it
// does the memory, fork and file rules.
// ---------------------------------------------------------------------------

const template = (name: string): string =>
    readFileSync(
        fileURLToPath(new URL(`../templates/project/agents/${name}`, import.meta.url)),
        'utf8',
    );

const MCP = 'agents/mcp-instructions.md';
const MCP_MEMORY = 'agents/mcp-memory-instructions.md';

describe('the conditions that deliver the MCP house rules', () => {
    it('gate the call rules on the group, and the memory rules on memory too', () => {
        expect(toList(frontmatter(template('mcp-instructions.md')).data.requires)).toEqual([
            'tools:mcp',
        ]);
        expect(toList(frontmatter(template('mcp-memory-instructions.md')).data.requires)).toEqual([
            'tools:mcp',
            'memory',
        ]);
    });
});

describe('the copies a scaffold leaves behind', () => {
    const dirs: string[] = [];

    afterAll(() => {
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    function project(prefix: string, mcp: boolean): string {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small', mcp });
        return dir;
    }

    const finding = async (dir: string, code: string): Promise<Finding | undefined> =>
        (await validateProject({ dir })).findings.find((f) => f.code === code);

    it('are byte-identical to the templates', () => {
        const dir = project('zen-mcp-rules-', true);
        expect(readFileSync(join(dir, MCP), 'utf8')).toBe(template('mcp-instructions.md'));
        expect(readFileSync(join(dir, MCP_MEMORY), 'utf8')).toBe(
            template('mcp-memory-instructions.md'),
        );
    });

    it('are what stops `zen check` failing on an uninstructed grant, and --fix restores them', async () => {
        const dir = project('zen-mcp-check-', true);
        expect(await finding(dir, 'mcp.uninstructed')).toBeUndefined();
        expect(await finding(dir, 'mcp-memory.uninstructed')).toBeUndefined();

        rmSync(join(dir, MCP));
        writeFileSync(join(dir, MCP_MEMORY), '');
        expect((await finding(dir, 'mcp.uninstructed'))?.severity).toBe('error');
        expect((await finding(dir, 'mcp-memory.uninstructed'))?.severity).toBe('error');

        refreshShared(dir);
        expect(await finding(dir, 'mcp.uninstructed')).toBeUndefined();
        expect(await finding(dir, 'mcp-memory.uninstructed')).toBeUndefined();
    });

    it('report an edited copy as stale', async () => {
        const dir = project('zen-mcp-stale-', true);
        writeFileSync(join(dir, MCP), `${template('mcp-instructions.md')}\nMy own rule.\n`);
        expect((await finding(dir, 'rules.stale'))?.where).toBe(MCP);
    });

    it('reach an agent granted the group, and in a project without it say nothing', async () => {
        const report = await validateProject({ dir: project('zen-mcp-reach-', true) });
        expect(report.agents[0]?.instructions).toEqual(expect.arrayContaining([MCP, MCP_MEMORY]));

        const plain = project('zen-mcp-plain-', false);
        const quiet = await validateProject({ dir: plain });
        expect(quiet.agents[0]?.instructions).not.toContain(MCP);
        expect(quiet.findings.some((f) => f.code === 'rules.unreached')).toBe(false);
        expect(quiet.findings.some((f) => f.code.startsWith('mcp'))).toBe(false);

        rmSync(join(plain, MCP));
        expect(await finding(plain, 'mcp.uninstructed')).toBeUndefined();
    });
});
