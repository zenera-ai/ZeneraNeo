import { existsSync, readFileSync, statSync } from 'node:fs';

/** A step that failed, with the log that says why. */
export class StepError extends Error {
    constructor(
        message: string,
        readonly log?: string,
    ) {
        super(message);
    }
}

export const sizeOf = (file: string): number => (existsSync(file) ? statSync(file).size : 0);

/**
 * What broke, from what a step appended to its log since `from`: the provider's own line before
 * zen's generic `error ...`, and the meta agent's fuller log when the step names one.
 */
export function errorIn(log: string, from = 0): { message?: string; log: string } {
    const text = existsSync(log) ? readFileSync(log).subarray(from).toString('utf8') : '';
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const provider = lines.findLast((l) =>
        /\bHTTP \d{3}\b|^"\d{3} [^"]+" \(\d{3}\)|not found|quota|rate limit|unavailable|timed out/i.test(
            l,
        ),
    );
    const exited = lines.findLast((l) => /^error\s/.test(l))?.replace(/^error\s+/, '');
    const meta = lines.findLast((l) => /^log\s+\//.test(l))?.replace(/^log\s+/, '');
    return { message: provider ?? exited, log: meta ?? log };
}
