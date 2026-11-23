#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function errorPayload(text) {
    const value = text.trim();
    if (!value) return undefined;

    const candidates = [value];
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(value.slice(start, end + 1));

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (
                parsed &&
                typeof parsed === 'object' &&
                parsed.error &&
                typeof parsed.error === 'object'
            ) {
                return parsed.error;
            }
        } catch {
            // npm's non-JSON diagnostic text is expected for transport failures.
        }
    }
    return undefined;
}

function parseVersion(stdout) {
    try {
        const value = JSON.parse(stdout.trim());
        return typeof value === 'string' &&
            /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
            ? value
            : undefined;
    } catch {
        return undefined;
    }
}

/** Classify one `npm view --json <name>@<version> version` result. */
export function classifyNpmView({ exitCode, stdout = '', stderr = '' }) {
    if (exitCode === 0) {
        const version = parseVersion(stdout);
        return version
            ? { status: 'present', reason: `registry returned version ${version}` }
            : {
                  status: 'unknown',
                  reason: 'successful npm view returned empty or unparseable version output',
              };
    }

    const error = errorPayload(stdout) ?? errorPayload(stderr);
    if (error?.code === 'E404') {
        if (
            typeof error.summary === 'string' &&
            /^No match found for version\b/i.test(error.summary)
        ) {
            return { status: 'absent', reason: error.summary };
        }
        return {
            status: 'unknown',
            reason:
                typeof error.summary === 'string'
                    ? `E404 is not a version miss: ${error.summary}`
                    : 'E404 did not identify a missing version',
        };
    }

    const code = error?.code ?? 'unclassified npm error';
    const detail = error?.summary ?? error?.detail ?? stderr.trim() ?? stdout.trim();
    return { status: 'unknown', reason: `${code}: ${detail || 'no diagnostic output'}` };
}

async function runNpmView(name, version) {
    try {
        const result = await execFileAsync(
            'npm',
            ['view', '--json', `${name}@${version}`, 'version'],
            {
                encoding: 'utf8',
                maxBuffer: 1024 * 1024,
            },
        );
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
        return {
            exitCode: typeof error.code === 'number' ? error.code : 1,
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? error.message ?? '',
        };
    }
}

/** Retry unknown outcomes only. `run` and `sleep` are injectable for offline tests. */
export async function lookupRegistryVersion({
    name,
    version,
    run = runNpmView,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 3,
    delayMs = 500,
}) {
    if (!name || !version)
        return { status: 'unknown', reason: 'package name and version are required', attempts: 0 };
    if (!Number.isInteger(attempts) || attempts < 1) {
        return { status: 'unknown', reason: 'attempts must be a positive integer', attempts: 0 };
    }

    let result;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        result = classifyNpmView(await run(name, version));
        if (result.status !== 'unknown') return { ...result, attempts: attempt };
        if (attempt < attempts) await sleep(delayMs * 2 ** (attempt - 1));
    }
    return { ...result, attempts };
}

async function main() {
    const [name, version] = process.argv.slice(2);
    const result = await lookupRegistryVersion({ name, version });
    const label = `${name ?? '<missing-name>'}@${version ?? '<missing-version>'}`;
    const message = `${result.status}: ${label} (${result.reason}; attempts=${result.attempts})`;

    if (result.status === 'present') {
        console.log(message);
        process.exitCode = 0;
    } else if (result.status === 'absent') {
        console.log(message);
        process.exitCode = 10;
    } else {
        console.error(message);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
