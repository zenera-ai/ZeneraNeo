// packages/meta/src/chat/permissions.ts
//
// Whether `zen meta chat` lets the agent use a tool: the same three answers `zen meta run` gives copilot's flags
// (every tool, the ones `--allow-tool` names, or ask), decided in-process for the SDK's permission callback.
// Main: `permissionPolicy(opts)`, which returns the callback; also `parseRules`, `allows` and `describe`.
// Used by: `chat/run.ts`, which hands the callback to `openChat` and the asking to the chat screen.

import type { PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk';

/** One entry of `--allow-tool`: `read`, `shell(git:*)`, `write(README.md)`, `url(github.com)`. */
export interface Rule {
    kind: string;
    pattern?: string;
}

/** What the person at the chat said to one request. */
export type Answer = 'yes' | 'no' | 'always';

/** A request as a person reads it: which kind of tool, and on what. */
export interface Described {
    kind: string;
    subject: string;
    intention?: string;
}

/**
 * Copilot's own list syntax, so a flag copied from a `zen meta run` line means
 * the same thing here. Separators inside a pattern's parentheses do not split it.
 */
export function parseRules(list: string | undefined): Rule[] {
    const rules: Rule[] = [];
    let depth = 0;
    let word = '';
    const push = (): void => {
        const text = word.trim();
        word = '';
        if (!text) {
            return;
        }
        const m = /^([\w-]+)\s*(?:\((.*)\))?$/s.exec(text);
        rules.push(m ? { kind: m[1], pattern: m[2]?.trim() || undefined } : { kind: text });
    };
    for (const ch of list ?? '') {
        if (ch === '(') {
            depth += 1;
        } else if (ch === ')') {
            depth = Math.max(0, depth - 1);
        }
        if ((ch === ',' || ch === ' ') && depth === 0) {
            push();
        } else {
            word += ch;
        }
    }
    push();
    return rules;
}

export function describe(request: PermissionRequest): Described {
    const intention =
        'intention' in request && typeof request.intention === 'string'
            ? request.intention
            : undefined;
    switch (request.kind) {
        case 'shell':
            return { kind: 'shell', subject: request.fullCommandText, intention };
        case 'write':
            return { kind: 'write', subject: request.fileName, intention };
        case 'read':
            return { kind: 'read', subject: request.path, intention };
        case 'url':
            return { kind: 'url', subject: request.url, intention };
        case 'mcp':
            return { kind: 'mcp', subject: `${request.serverName}/${request.toolName}`, intention };
        default: {
            const r = request as { toolName?: unknown; name?: unknown };
            return { kind: request.kind, subject: String(r.toolName ?? r.name ?? ''), intention };
        }
    }
}

/** `git:*` is "git, with anything after"; a trailing `*` is a prefix; otherwise the whole of it. */
function matches(pattern: string, value: string): boolean {
    if (pattern.endsWith(':*')) {
        const head = pattern.slice(0, -2);
        return value === head || value.startsWith(`${head} `);
    }
    if (pattern.endsWith('*')) {
        return value.startsWith(pattern.slice(0, -1));
    }
    return value === pattern;
}

const pathMatches = (pattern: string, path: string): boolean =>
    matches(pattern, path) ||
    matches(pattern, path.split('/').pop() ?? path) ||
    path.endsWith(`/${pattern}`);

/** Whether any rule covers the request. A compound shell line needs every command covered. */
export function allows(rules: readonly Rule[], request: PermissionRequest): boolean {
    return rules.some((rule) => {
        if (rule.kind !== request.kind) {
            return false;
        }
        const pattern = rule.pattern;
        if (!pattern) {
            return true;
        }
        switch (request.kind) {
            case 'shell': {
                const segments = request.commandSegments?.map((s) => s.fullCommandText.trim());
                const lines = segments?.length ? segments : [request.fullCommandText.trim()];
                return lines.every((line) => matches(pattern, line));
            }
            case 'write':
                return pathMatches(pattern, request.fileName);
            case 'read':
                return pathMatches(pattern, request.path);
            case 'url': {
                let host = request.url;
                try {
                    host = new URL(request.url).hostname;
                } catch {
                    // Not a url the parser takes: the pattern is matched against it as written.
                }
                return matches(pattern, host) || host.endsWith(`.${pattern}`);
            }
            case 'mcp':
                return pattern === request.serverName || pattern === request.toolName;
            default:
                return false;
        }
    });
}

export interface PolicyOptions {
    allowAll?: boolean;
    ask?: boolean;
    allowTool?: string;
    /** asks the person at the chat; only called with `ask` */
    prompt?: (request: Described) => Promise<Answer>;
}

/**
 * The callback for the SDK, with `zen meta run`'s defaults: every tool unless
 * `--allow-tool` narrows it or `--ask` restores the asking. Named tools win over
 * asking, and anything they leave out is asked about with `--ask` and refused
 * without it. "Always" covers that kind of tool for the rest of the session.
 */
export function permissionPolicy(
    opts: PolicyOptions,
): (request: PermissionRequest) => Promise<PermissionRequestResult> {
    const rules = parseRules(opts.allowTool);
    const everything = opts.allowAll || (!opts.ask && rules.length === 0);
    const granted = new Set<string>();
    return async (request) => {
        if (request.managedApprovalRequired) {
            return { kind: 'no-result' };
        }
        if (everything || granted.has(request.kind) || allows(rules, request)) {
            return { kind: 'approve-once' };
        }
        if (!opts.ask || !opts.prompt) {
            return {
                kind: 'reject',
                feedback: `Not allowed: this chat only allows ${opts.allowTool}.`,
            };
        }
        const answer = await opts.prompt(describe(request));
        if (answer === 'always') {
            granted.add(request.kind);
        }
        // Copilot tells the model a person said no; there is nothing to add to that.
        return answer === 'no' ? { kind: 'reject' } : { kind: 'approve-once' };
    };
}
