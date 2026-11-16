import { frontmatter, toList } from '@zenera/neo';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { refreshShared, scaffold } from '../src/scaffold.ts';
import { validateProject, type Finding } from '../src/validate.ts';

// ---------------------------------------------------------------------------
// The file house rules
//
// `agents/files-instructions.md` is the place file operations are explained
// to a model: reading ranges, applying patches, discovery, and path containment.
// ---------------------------------------------------------------------------

const TEMPLATE = fileURLToPath(
    new URL('../templates/project/agents/files-instructions.md', import.meta.url),
);

const rules = readFileSync(TEMPLATE, 'utf8');

describe('the condition that delivers the files house rules', () => {
    it('requires the capability the document is about, and nothing else', () => {
        const { data } = frontmatter(rules);
        expect(toList(data.requires)).toEqual(['files']);
    });

    it('names the file tools so an author sees the full set', () => {
        for (const name of [
            'read_file',
            'view_image',
            'list_dir',
            'find_files',
            'write_file',
            'apply_patch',
            'move_file',
            'delete_file',
        ]) {
            expect(rules).toContain(`\`${name}\``);
        }
    });

    it('mentions patch syntax and boundary markers', () => {
        expect(rules).toContain('*** Begin Patch');
        expect(rules).toContain('*** End Patch');
    });
});

describe('the copy a scaffold leaves behind', () => {
    const dirs: string[] = [];

    afterAll(() => {
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /** A scaffolded project using the default file tools. */
    function project(prefix: string): string {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small' });
        return dir;
    }

    it('is byte-identical to the template', () => {
        const dir = project('zen-files-rules-');
        expect(readFileSync(join(dir, 'agents', 'files-instructions.md'), 'utf8')).toBe(rules);
    });

    it('is what stops `zen check` failing on an uninstructed file-enabled project', async () => {
        const dir = project('zen-files-check-');

        const uninstructed = async (): Promise<Finding | undefined> => {
            const report = await validateProject({ dir });
            return report.findings.find((f) => f.code === 'files.uninstructed');
        };

        expect(await uninstructed()).toBeUndefined();

        rmSync(join(dir, 'agents', 'files-instructions.md'));
        expect((await uninstructed())?.severity).toBe('error');

        writeFileSync(join(dir, 'agents', 'files-instructions.md'), '');
        expect((await uninstructed())?.severity).toBe('error');
    });

    it('reaches the prompt of an agent that uses file tools, and no other', async () => {
        const dir = project('zen-files-reach-');
        const report = await validateProject({ dir });
        const agent = report.agents.find((a) => a.name === 'default');
        expect(agent?.instructions).toContain('agents/files-instructions.md');

        // An agent without file tools does not receive them
        const noFiles = mkdtempSync(join(tmpdir(), 'zen-files-none-'));
        dirs.push(noFiles);
        scaffold({
            dir: noFiles,
            model: 'openai:gpt-5',
            embedding: 'openai:text-embedding-3-small',
        });
        const config = join(noFiles, 'agents.yaml');
        writeFileSync(
            config,
            readFileSync(config, 'utf8').replace(
                'tools:\n          - files:*\n          - sandbox:*',
                'tools: [sandbox:*]',
            ),
        );
        const quiet = await validateProject({ dir: noFiles });
        expect(quiet.agents.length).toBeGreaterThan(0);
        expect(quiet.agents[0]?.instructions).not.toContain('agents/files-instructions.md');
        expect(quiet.findings.some((f) => f.code === 'rules.unreached')).toBe(false);
    });

    it('is restored by refreshShared', () => {
        const dir = project('zen-files-restore-');
        const path = join(dir, 'agents', 'files-instructions.md');
        writeFileSync(path, 'corrupted');
        refreshShared(dir);
        expect(readFileSync(path, 'utf8')).toBe(rules);
    });

    it('requires file instructions for an agent granted only view_image', async () => {
        const dir = project('zen-image-rules-');
        writeFileSync(
            join(dir, 'agents.yaml'),
            'agents:\n  - name: viewer\n    tools: [files:view_image]\n',
        );
        const withRules = await validateProject({ dir });
        expect(withRules.agents.find((a) => a.name === 'viewer')?.instructions).toContain(
            'agents/files-instructions.md',
        );
        rmSync(join(dir, 'agents', 'files-instructions.md'));
        const withoutRules = await validateProject({ dir });
        expect(withoutRules.findings.some((f) => f.code === 'files.uninstructed')).toBe(true);
    });
});
