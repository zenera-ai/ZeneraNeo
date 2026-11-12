// packages/engine/src/errors.ts
//
// Errors and warnings for code that runs under both a terminal and a server: never prints, never exits.
// Main: `EngineError` (code + hint, recognised across separately installed copies of this module),
// `EXIT`, `usageError`/`invalidError`/`credentialError`, `Logger`.
// Used by: all of `@zenera/engine`; `@zenera/cli` re-exports `EngineError` as `CliError` (`term.ts`), which
// every CLI command and sibling package (meta, gym, rag) throws and `main.ts` maps to an exit code.

// ---------------------------------------------------------------------------
// Errors and warnings
//
// The engine runs under a terminal and under a server, so it never prints and
// never exits. An error carries a code a CLI turns into an exit status and a
// server turns into an HTTP status; a warning goes to whatever `Logger` the
// host handed in.
// ---------------------------------------------------------------------------

export const EXIT = {
    ok: 0,
    failed: 1,
    usage: 2,
    invalid: 3,
    credentials: 4,
    sandbox: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Marks an `EngineError` by a registry symbol rather than by its class, which
 * is per copy of this module. `zen` loads a sibling package - `@zenera/meta`,
 * the gym - that is installed apart and brings its own copy of the engine, and
 * an error it throws must still read as one at the top, code and hint intact.
 */
const BRAND = Symbol.for('zenera.EngineError');

/**
 * An error that already knows what it means. Anything else reaching the top is
 * a bug, which is the distinction a caller needs: a wrong request and a wrong
 * answer are not the same failure.
 */
export class EngineError extends Error {
    readonly code: ExitCode;
    readonly hint?: string;

    constructor(message: string, code: ExitCode = EXIT.failed, hint?: string) {
        super(message);
        this.name = 'EngineError';
        this.code = code;
        this.hint = hint;
        Object.defineProperty(this, BRAND, { value: true });
    }

    /** Subclasses keep the ordinary prototype check; only the base is matched by brand. */
    static override [Symbol.hasInstance](value: unknown): boolean {
        if (this !== EngineError) {
            return Function.prototype[Symbol.hasInstance].call(this, value);
        }
        return typeof value === 'object' && value !== null && BRAND in value;
    }
}

export const usageError = (m: string, hint?: string): EngineError =>
    new EngineError(m, EXIT.usage, hint);
export const invalidError = (m: string, hint?: string): EngineError =>
    new EngineError(m, EXIT.invalid, hint);
export const credentialError = (m: string, hint?: string): EngineError =>
    new EngineError(m, EXIT.credentials, hint);

export interface Logger {
    warn(message: string): void;
}

/** Plain lines on stderr, for a host that did not say where warnings go. */
export const stderrLogger: Logger = {
    warn: (message) => {
        process.stderr.write(`warning ${message}\n`);
    },
};
