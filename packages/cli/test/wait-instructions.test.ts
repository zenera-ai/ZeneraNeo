import { frontmatter, toList } from '@zenera/neo';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { refreshShared, scaffold, SHARED_RULES } from '../src/scaffold.ts';
import { validateProject, type Finding } from '../src/validate.ts';

// ---------------------------------------------------------------------------
// The wait house rules
//
// `wait` comes from Zenera's plugin, like the `mcp` tools, so this file is the
// only thing that tells a model when to pause a run, how to give the time, and
// what a Stop or a new message means. It reaches only agents granted the
// group, and `zen check` reports it missing the way it does the MCP rules.
// ---------------------------------------------------------------------------

const template = (name: string): string =>
    readFileSync(
        fileURLToPath(new URL(`../templates/project/agents/${name}`, import.meta.url)),
        'utf8',
    );

const WAIT = 'agents/wait-instructions.md';

describe('the wait house rules', () => {
    const dirs: string[] = [];

    afterAll(() => {
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /** A scaffold whose default agent is granted `wait:*`, or not. */
    function project(prefix: string, wait: boolean): string {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small', wait });
        return dir;
    }

    const finding = async (dir: string, code: string): Promise<Finding | undefined> =>
        (await validateProject({ dir })).findings.find((f) => f.code === code);

    it('are gated on the group, and are among the files zen keeps current', () => {
        expect(toList(frontmatter(template('wait-instructions.md')).data.requires)).toEqual([
            'tools:wait',
        ]);
        expect(SHARED_RULES).toContain(join('agents', 'wait-instructions.md'));
    });

    it('land byte-identical in every scaffold', () => {
        const dir = project('zen-wait-rules-', false);
        expect(readFileSync(join(dir, WAIT), 'utf8')).toBe(template('wait-instructions.md'));
    });

    it('reach an agent granted the group, and stop `zen check` failing on it', async () => {
        const dir = project('zen-wait-check-', true);
        const report = await validateProject({ dir });
        expect(report.agents[0]?.instructions).toContain(WAIT);
        expect(report.findings.some((f) => f.code === 'wait.uninstructed')).toBe(false);

        rmSync(join(dir, WAIT));
        expect((await finding(dir, 'wait.uninstructed'))?.severity).toBe('error');
        writeFileSync(join(dir, WAIT), '');
        expect((await finding(dir, 'wait.uninstructed'))?.severity).toBe('error');

        refreshShared(dir);
        expect(await finding(dir, 'wait.uninstructed')).toBeUndefined();
    });

    it('report an edited copy as stale', async () => {
        const dir = project('zen-wait-stale-', true);
        writeFileSync(join(dir, WAIT), `${template('wait-instructions.md')}\nMy own rule.\n`);
        expect((await finding(dir, 'rules.stale'))?.where).toBe(WAIT);
    });

    it('in a project without the grant, reach no agent and say nothing', async () => {
        const plain = project('zen-wait-plain-', false);
        const quiet = await validateProject({ dir: plain });
        expect(quiet.agents[0]?.instructions).not.toContain(WAIT);
        expect(quiet.findings.some((f) => f.code === 'rules.unreached')).toBe(false);
        expect(quiet.findings.some((f) => f.code.startsWith('wait'))).toBe(false);

        rmSync(join(plain, WAIT));
        expect(await finding(plain, 'wait.uninstructed')).toBeUndefined();
    });
});
