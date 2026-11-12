import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { usageError } from './host.ts';

// ---------------------------------------------------------------------------
// Stored commands
//
// The editor offers `.github/skills/<name>/SKILL.md` as `/name`. The `zen-*`
// skills are reference the model loads on its own (`user-invocable: false`);
// the rest are commands somebody types (`disable-model-invocation: true`), and
// those are what `zen meta run /<name>` runs. Copilot would expand `/name`
// itself, but reading the file and handing over its body works the same with
// every model and leaves room for `--prompt-file` after it.
//
// `.github/prompts/*.prompt.md` is the format these used to be in. Copilot has
// dropped it, but a project may still have prompt files of its own, so one
// whose name no skill takes is still run.
// ---------------------------------------------------------------------------

export const SKILL_DIR = '.github/skills';
export const PROMPT_DIR = '.github/prompts';
const PROMPT_SUFFIX = '.prompt.md';

/** `/project-review`, `project-review`, `project-review.prompt.md` or a path. */
export function promptPath(dir: string, name: string): string {
    const bare = name.replace(/^\//, '');
    if (bare.includes('/') || bare.endsWith('.md')) {
        return `${dir}/${bare}`;
    }
    const skill = `${dir}/${SKILL_DIR}/${bare}/SKILL.md`;
    const legacy = `${dir}/${PROMPT_DIR}/${bare}${PROMPT_SUFFIX}`;
    return !existsSync(skill) && existsSync(legacy) ? legacy : skill;
}

export interface StoredPrompt {
    name: string;
    path: string;
    description?: string;
    /** False for a skill marked `user-invocable: false` - the model's, not a command. */
    invocable: boolean;
    body: string;
}

/**
 * Frontmatter is the editor's business — `name`, `argument-hint`, the
 * invocation switches — and none of it means anything once the body is the
 * prompt, so only the body is sent. `description` is kept for the one line of
 * narration that says which command is running.
 */
export function readPrompt(path: string, name: string, text: string): StoredPrompt {
    let body = text;
    let description: string | undefined;
    let invocable = true;
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (match) {
        body = text.slice(match[0].length);
        const found = /^description:\s*(.+)$/m.exec(match[1]);
        description = found?.[1].trim().replace(/^['"]|['"]$/g, '');
        invocable = !/^user-invocable:\s*['"]?false['"]?\s*$/m.test(match[1]);
    }
    return { name, path, description, invocable, body: body.trim() };
}

export async function loadPrompt(dir: string, name: string): Promise<StoredPrompt> {
    const path = promptPath(dir, name);
    if (!existsSync(path)) {
        const known = await listPrompts(dir);
        throw usageError(
            `no command named ${name.replace(/^\//, '')}`,
            known.length > 0
                ? `try: ${known.map((p) => `/${p}`).join(', ')}`
                : `put one in ${SKILL_DIR}/<name>/SKILL.md`,
        );
    }
    return readPrompt(path, name.replace(/^\//, ''), await readFile(path, 'utf8'));
}

/** The commands a person may type: every skill not marked for the model only, and any legacy prompt file. */
export async function listPrompts(dir: string): Promise<string[]> {
    const names = new Set<string>();
    for (const entry of entries(`${dir}/${SKILL_DIR}`)) {
        const path = `${dir}/${SKILL_DIR}/${entry}/SKILL.md`;
        if (existsSync(path) && readPrompt(path, entry, readFileSync(path, 'utf8')).invocable) {
            names.add(entry);
        }
    }
    for (const entry of entries(`${dir}/${PROMPT_DIR}`)) {
        if (entry.endsWith(PROMPT_SUFFIX)) {
            names.add(entry.slice(0, -PROMPT_SUFFIX.length));
        }
    }
    return [...names].sort();
}

function entries(path: string): string[] {
    try {
        return readdirSync(path);
    } catch {
        return [];
    }
}
