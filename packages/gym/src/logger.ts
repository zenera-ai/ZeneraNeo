import { bold, cyan, dim, green, red, yellow } from '@zenera/cli/lib';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HandlerRequest } from './runtime.ts';

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

export type ErrorKind =
    | 'CLIENT_ERROR: NOT_FOUND'
    | 'CLIENT_ERROR: METHOD_NOT_ALLOWED'
    | 'CLIENT_ERROR: BAD_REQUEST'
    | 'CLIENT_ERROR: VALIDATION_FAILED'
    | 'CLIENT_ERROR: PAYLOAD_TOO_LARGE'
    | 'HANDLER_FAULT'
    | 'HANDLER_TIMEOUT'
    | 'HANDLER_SCHEMA_MISMATCH'
    | 'HANDLER_BUILD_FAILED'
    | 'WORKER_UNAVAILABLE'
    | 'WORLD_AGENT_FAILED'
    | 'SERVER_INTERNAL_ERROR'
    | 'REGENERATION_LIMIT_HIT'
    | 'REGENERATION_FAILED'
    | 'SUCCESS';

export interface RequestDumpData {
    id: string;
    timestamp: Date;
    durationMs: number;
    method: string;
    url: string;
    pathname: string;
    search: string;
    operationId?: string;
    routePath?: string;
    pathParams?: Record<string, string>;
    query?: Record<string, string>;
    requestHeaders: Record<string, string>;
    requestBody?: unknown;
    status: number;
    responseHeaders?: Record<string, string | number>;
    responseBody?: unknown;
    errorKind?: ErrorKind;
    errorMessage?: string;
    /** what to do about it, when the fix is not in the handler */
    hint?: string;
    stderr?: string;
    /** the build report, when the answer was "there is no handler" */
    buildDump?: string;
    cacheStatus?: 'hit' | 'miss' | 'regenerated';
    regenerated?: boolean;
    regenAttempts?: number;
    regenLimitHit?: boolean;
    regenLimit?: number;
    issues?: readonly unknown[];
    note?: string;
}

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

export function formatTimestamp(d: Date): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    const ms = pad(d.getMilliseconds(), 3);
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}.${ms}`;
}

export function statusText(status: number): string {
    switch (status) {
        case 200:
            return 'OK';
        case 201:
            return 'Created';
        case 202:
            return 'Accepted';
        case 204:
            return 'No Content';
        case 400:
            return 'Bad Request';
        case 401:
            return 'Unauthorized';
        case 403:
            return 'Forbidden';
        case 404:
            return 'Not Found';
        case 405:
            return 'Method Not Allowed';
        case 413:
            return 'Payload Too Large';
        case 500:
            return 'Internal Server Error';
        case 501:
            return 'Not Implemented';
        case 502:
            return 'Bad Gateway';
        case 503:
            return 'Service Unavailable';
        case 504:
            return 'Gateway Timeout';
        default:
            return status < 400 ? 'Success' : status < 500 ? 'Client Error' : 'Server Error';
    }
}

export function colorForStatus(status: number): (s: string) => string {
    if (status < 300) return green;
    if (status < 400) return cyan;
    if (status < 500) return yellow;
    return red;
}

export function colorForErrorKind(kind: ErrorKind): (s: string) => string {
    if (kind.startsWith('CLIENT_ERROR')) return yellow;
    if (kind === 'SUCCESS') return green;
    return (s) => red(bold(s));
}

// ---------------------------------------------------------------------------
// Markdown Request / Response Dump File
// ---------------------------------------------------------------------------

/**
 * Saves a markdown file with all input information and output data for a request.
 * Returns the absolute path of the generated markdown file.
 */
export async function saveRequestDump(dir: string, data: RequestDumpData): Promise<string> {
    mkdirSync(dir, { recursive: true });

    const safePath =
        data.pathname.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    const isoPrefix = data.timestamp.toISOString().replace(/[:.]/g, '-');
    const filename = `${isoPrefix}-${data.method.toUpperCase()}-${safePath}-${data.id}.md`;
    const fullPath = join(dir, filename);

    const lines: string[] = [
        `# Request: ${data.method.toUpperCase()} ${data.pathname}${data.search}`,
        '',
        `- **Request ID**: \`${data.id}\``,
        `- **Timestamp**: ${data.timestamp.toISOString()}`,
        `- **Status**: ${data.status} ${statusText(data.status)}`,
        `- **Duration**: ${data.durationMs}ms`,
        `- **Operation ID**: ${data.operationId ? `\`${data.operationId}\`` : '_None_'}`,
        `- **Route Pattern**: ${data.routePath ? `\`${data.routePath}\`` : '_None_'}`,
        `- **Cache**: ${data.cacheStatus ?? 'n/a'}`,
    ];

    if (data.errorKind) {
        lines.push(`- **Error Kind**: \`${data.errorKind}\``);
    }
    if (data.regenerated) {
        lines.push(`- **Regenerated**: Yes (attempts: ${data.regenAttempts ?? 1})`);
    }
    if (data.regenLimitHit) {
        lines.push(`- **Regeneration Limit**: Hit (limit: ${data.regenLimit})`);
    }
    if (data.note) {
        lines.push(`- **Note**: ${data.note}`);
    }
    if (data.buildDump) {
        lines.push(`- **Build report**: [${data.buildDump}](file://${data.buildDump})`);
    }

    lines.push('', '---', '', '## Request Info', '');
    lines.push(
        '### URL & Method',
        '```http',
        `${data.method.toUpperCase()} ${data.url}`,
        '```',
        '',
    );

    lines.push('### Path Parameters');
    if (data.pathParams && Object.keys(data.pathParams).length > 0) {
        lines.push('```json', JSON.stringify(data.pathParams, null, 2), '```');
    } else {
        lines.push('_None_');
    }
    lines.push('');

    lines.push('### Query Parameters');
    if (data.query && Object.keys(data.query).length > 0) {
        lines.push('```json', JSON.stringify(data.query, null, 2), '```');
    } else {
        lines.push('_None_');
    }
    lines.push('');

    lines.push('### Request Headers');
    if (data.requestHeaders && Object.keys(data.requestHeaders).length > 0) {
        lines.push('```json', JSON.stringify(data.requestHeaders, null, 2), '```');
    } else {
        lines.push('_None_');
    }
    lines.push('');

    lines.push('### Request Body');
    if (data.requestBody !== undefined) {
        lines.push(
            '```json',
            typeof data.requestBody === 'string'
                ? data.requestBody
                : JSON.stringify(data.requestBody, null, 2),
            '```',
        );
    } else {
        lines.push('_Empty_');
    }
    lines.push('');

    lines.push('---', '', '## Response Data', '');
    lines.push(
        '### Status',
        '```http',
        `HTTP/1.1 ${data.status} ${statusText(data.status)}`,
        '```',
        '',
    );

    lines.push('### Response Headers');
    if (data.responseHeaders && Object.keys(data.responseHeaders).length > 0) {
        lines.push('```json', JSON.stringify(data.responseHeaders, null, 2), '```');
    } else {
        lines.push('_None_');
    }
    lines.push('');

    lines.push('### Response Body');
    if (data.responseBody !== undefined) {
        lines.push(
            '```json',
            typeof data.responseBody === 'string'
                ? data.responseBody
                : JSON.stringify(data.responseBody, null, 2),
            '```',
        );
    } else {
        lines.push('_Empty_');
    }
    lines.push('');

    if (data.errorMessage || data.stderr || (data.issues && data.issues.length > 0)) {
        lines.push('---', '', '## Error & Diagnostics', '');
        if (data.errorKind) {
            lines.push(`### Classification`, `\`${data.errorKind}\``, '');
        }
        if (data.errorMessage) {
            lines.push(`### Error Message`, `\`${data.errorMessage}\``, '');
        }
        if (data.hint) {
            lines.push(`### What to do`, data.hint, '');
        }
        if (data.issues && data.issues.length > 0) {
            lines.push(
                '### Validation Issues',
                '```json',
                JSON.stringify(data.issues, null, 2),
                '```',
                '',
            );
        }
        if (data.stderr) {
            lines.push('### Stderr / Traceback', '```', data.stderr, '```', '');
        }
    }

    await writeFile(fullPath, lines.join('\n'), 'utf8');
    return resolve(fullPath);
}

// ---------------------------------------------------------------------------
// Markdown Build Report
//
// The request dump answers "what did this call do". This one answers "why is
// there nothing to call", which is a longer story: every attempt the judge
// threw out, what was wrong with it, and the file itself — because a
// candidate's file is deleted once it is judged, and a handler that merely
// hung leaves no stack behind, so the code is the only evidence there will
// ever be.
//
// One file per build, rewritten as the attempts go by rather than one file per
// attempt: the path is then stable enough to be handed to the request that was
// refused, which is where somebody will be looking.
// ---------------------------------------------------------------------------

export interface BuildAttempt {
    attempt: number;
    at: Date;
    diagnostics: readonly string[];
    source: string;
}

export interface BuildDumpData {
    started: Date;
    operationId?: string;
    method: string;
    path: string;
    /** the operation's cache key, which is also its directory in the box */
    key: string;
    limit: number;
    /** rewriting a handler that already existed rather than writing the first */
    regeneration?: boolean;
    model?: string;
    attempts: readonly BuildAttempt[];
    /** the attempts ran out — no handler was produced */
    gaveUp?: boolean;
    /** the agent's HTML run report */
    report?: string;
}

export async function saveBuildDump(dir: string, data: BuildDumpData): Promise<string> {
    mkdirSync(dir, { recursive: true });

    const safePath = data.path.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    const isoPrefix = data.started.toISOString().replace(/[:.]/g, '-');
    const what = data.regeneration ? 'regen' : 'build';
    const fullPath = join(dir, `${isoPrefix}-${what}-${data.method.toUpperCase()}-${safePath}.md`);

    const outcome = data.gaveUp
        ? `gave up after ${data.attempts.length} of ${data.limit}`
        : `attempt ${data.attempts.length} of ${data.limit} rejected`;

    const lines: string[] = [
        `# ${data.regeneration ? 'Regeneration' : 'Build'}: ` +
            `${data.method.toUpperCase()} ${data.path}`,
        '',
        `- **Operation ID**: ${data.operationId ? `\`${data.operationId}\`` : '_None_'}`,
        `- **Key**: \`${data.key}\``,
        `- **Started**: ${data.started.toISOString()}`,
        `- **Model**: ${data.model ? `\`${data.model}\`` : '_Unknown_'}`,
        `- **Outcome**: ${outcome}`,
        ...(data.report ? [`- **Agent run**: [${data.report}](file://${data.report})`] : []),
        '',
    ];

    for (const a of data.attempts) {
        const elapsed = Math.max(0, a.at.getTime() - data.started.getTime());
        lines.push(
            '---',
            '',
            `## Attempt ${a.attempt} of ${data.limit}`,
            '',
            `_Rejected ${a.at.toISOString()}, ${elapsed}ms into the build._`,
            '',
            '### Why it was rejected',
            '',
            ...(a.diagnostics.length > 0
                ? a.diagnostics.map((d) => (d.trimStart().startsWith('-') ? d : `- ${d}`))
                : ['_No diagnostics._']),
            '',
            '### Handler',
            '',
            '```ts',
            a.source,
            '```',
            '',
        );
    }

    await writeFile(fullPath, lines.join('\n'), 'utf8');
    return resolve(fullPath);
}

export function formatDumpPath(label: string, path: string): string {
    return `  ${dim(`↳ ${label}:`)} ${cyan(`file://${resolve(path)}`)}`;
}

// ---------------------------------------------------------------------------
// Log Line Formatter
// ---------------------------------------------------------------------------

export function formatLogLine(data: RequestDumpData, dumpPath: string): string {
    const ts = dim(`[${formatTimestamp(data.timestamp)}]`);
    const method = cyan(bold(data.method.toUpperCase()));
    const target = `${data.pathname}${data.search}`;
    const statusCol = colorForStatus(data.status);
    const status = statusCol(String(data.status));
    const duration = dim(`${data.durationMs}ms`);

    let tag = '';
    if (data.errorKind) {
        const tagCol = colorForErrorKind(data.errorKind);
        tag = ` ${tagCol(`[${data.errorKind}]`)}`;
    } else if (data.status < 400) {
        tag = ` ${green('[SUCCESS]')}`;
    }

    const note = data.note ? ` ${dim(`· ${data.note}`)}` : '';
    const errDetail = data.errorMessage ? ` ${dim(`(${data.errorMessage})`)}` : '';

    const firstLine = `${ts} ${method} ${target} ${status} ${duration}${tag}${note}${errDetail}`;

    const lines = [firstLine];

    if (data.stderr && data.stderr.trim()) {
        const lastStderr = data.stderr.trim().split('\n').slice(-4).join('\n    ');
        lines.push(`  ${dim('stderr:')} ${red(lastStderr)}`);
    }

    if (data.hint) {
        lines.push(`  ${dim('↳ fix:')} ${yellow(data.hint)}`);
    }

    if (dumpPath) {
        const fileUrl = `file://${resolve(dumpPath)}`;
        lines.push(`  ${dim('↳ dump:')} ${cyan(fileUrl)}`);
    }

    if (data.buildDump) {
        lines.push(formatDumpPath('build', data.buildDump));
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Special Log Messages
// ---------------------------------------------------------------------------

export function formatRegenLimitHit(urlPath: string, limit: number, operationId?: string): string {
    const ts = dim(`[${formatTimestamp(new Date())}]`);
    const op = operationId ? ` (${operationId})` : '';
    return `${ts} ${red(bold('[REGENERATION_LIMIT_HIT]'))} Maximum regeneration limit (${limit}) reached for URL "${urlPath}"${op}. Halting further regeneration attempts.`;
}

export function formatRegenerating(
    urlPath: string,
    attempt: number,
    limit: number,
    operationId?: string,
    reason?: string,
    stderr?: string,
): string {
    const ts = dim(`[${formatTimestamp(new Date())}]`);
    const op = operationId ? ` (${operationId})` : '';
    const r = reason ? ` [${reason}]` : '';
    const head = `${ts} ${yellow(bold('[REGENERATING]'))} Error in handler for "${urlPath}"${op}${r}. Attempting regeneration (${attempt}/${limit})...`;
    const tail = stderr?.trim().split('\n').slice(-3).join('\n    ');
    return tail ? `${head}\n  ${dim('stderr:')} ${red(tail)}` : head;
}

export function formatRegenerated(
    urlPath: string,
    attempt: number,
    durationMs: number,
    operationId?: string,
): string {
    const ts = dim(`[${formatTimestamp(new Date())}]`);
    const op = operationId ? ` (${operationId})` : '';
    return `${ts} ${green(bold('[REGENERATED]'))} Successfully regenerated handler for "${urlPath}"${op} in attempt ${attempt} (${durationMs}ms).`;
}

// ---------------------------------------------------------------------------
// Request History & Regeneration Limiter
// ---------------------------------------------------------------------------

export interface ExampleRequest {
    input: HandlerRequest;
    output?: unknown;
}

export class RequestHistory {
    readonly #successful = new Map<string, ExampleRequest[]>();
    readonly #maxExamples: number;

    constructor(maxExamples = 5) {
        this.#maxExamples = maxExamples;
    }

    recordSuccess(operationKey: string, input: HandlerRequest, output: unknown): void {
        let list = this.#successful.get(operationKey);
        if (!list) {
            list = [];
            this.#successful.set(operationKey, list);
        }
        list.push({ input, output });
        if (list.length > this.#maxExamples) {
            list.shift();
        }
    }

    getSuccessful(operationKey: string, count = 2): ExampleRequest[] {
        const list = this.#successful.get(operationKey);
        if (!list || list.length === 0) {
            return [];
        }
        return list.slice(-count);
    }
}

export class RegenerationLimiter {
    readonly #counts = new Map<string, number>();
    readonly limit: number;

    constructor(limit = 3) {
        this.limit = limit;
    }

    countFor(url: string): number {
        return this.#counts.get(url) ?? 0;
    }

    isLimitHit(url: string): boolean {
        return (this.#counts.get(url) ?? 0) >= this.limit;
    }

    increment(url: string): number {
        const next = (this.#counts.get(url) ?? 0) + 1;
        this.#counts.set(url, next);
        return next;
    }
}
