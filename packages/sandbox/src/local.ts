import { isAbsolute, resolve } from 'node:path';
import {
    SandboxError,
    type ExecOptions,
    type ExecResult,
    type JobOutput,
    type JobStopped,
    type Sandbox,
} from './contract.ts';
import { localFs, type FsDriver } from './fs.ts';
import { MAX_TIMEOUT_MS, runProcess, type Runner } from './process.ts';

// ---------------------------------------------------------------------------
// A sandbox that is no sandbox: commands as plain child processes
//
// For code that is already where its commands should run: `zen page` inside a
// session's sandbox (bwrap or podman put it there), or on a person's own machine
// for their own folder. It keeps the `Sandbox` contract so what takes a sandbox
// (a page's function calls, `AppCalls`) runs here unchanged; it adds no
// isolation of its own, so a host must never hand it to code from somewhere else.
//
// Main: ProcessSandbox - exec through `/bin/sh -s` (the script on stdin, as the
// other sandboxes send it), the files through `localFs`. No background jobs.
// Used by: @zenera/cli `zen page` (page.ts), for a page's calls.
// ---------------------------------------------------------------------------

export interface ProcessSandboxOptions {
    /** where commands run when they name no cwd, and what a relative cwd is under */
    root: string;
    /** the whole environment of every command; this process's when unset */
    env?: NodeJS.ProcessEnv;
    /** directories put in front of a path-like variable (`PYTHONPATH`) for every command */
    execPaths?: Record<string, readonly string[]>;
    /** seconds a command may take when it says nothing; 120 */
    timeout?: number;
    /** how processes are spawned - the seam tests replace */
    run?: Runner;
}

const DEFAULT_TIMEOUT_SECONDS = 120;

export class ProcessSandbox implements Sandbox {
    readonly name = 'process';
    readonly fs: FsDriver = localFs;
    readonly started = true;
    readonly #opts: ProcessSandboxOptions;
    readonly #closing = new AbortController();

    constructor(opts: ProcessSandboxOptions) {
        this.#opts = opts;
    }

    async prepare(): Promise<void> {}

    async start(): Promise<void> {}

    async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
        const cwd = opts.cwd
            ? isAbsolute(opts.cwd)
                ? opts.cwd
                : resolve(this.#opts.root, opts.cwd)
            : this.#opts.root;
        const signal = opts.signal
            ? AbortSignal.any([opts.signal, this.#closing.signal])
            : this.#closing.signal;
        const startedAt = Date.now();
        const quoted = `'${cwd.replace(/'/g, `'\\''`)}'`;
        const res = await (this.#opts.run ?? runProcess)('/bin/sh', ['-s'], {
            input: `cd ${quoted} || exit 1\n${command}`,
            timeoutMs: Math.min(
                (opts.timeout ?? this.#opts.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
                MAX_TIMEOUT_MS,
            ),
            signal,
            env: this.#env(),
            group: true,
            ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
        });
        return {
            exit_code: res.code,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated || undefined,
            timed_out: res.timedOut || undefined,
            duration_ms: Date.now() - startedAt,
        };
    }

    #env(): NodeJS.ProcessEnv {
        const env = { ...(this.#opts.env ?? process.env) };
        for (const [name, dirs] of Object.entries(this.#opts.execPaths ?? {})) {
            if (dirs.length) env[name] = [...dirs, env[name]].filter(Boolean).join(':');
        }
        return env;
    }

    async startJob(): Promise<string> {
        throw new SandboxError('background jobs are not run here', 'run the command itself');
    }

    async readJob(id: string): Promise<JobOutput> {
        throw new SandboxError(`no such job: ${id}`);
    }

    async stopJob(id: string): Promise<JobStopped> {
        throw new SandboxError(`no such job: ${id}`);
    }

    /** Stops every command still running. */
    async close(): Promise<void> {
        this.#closing.abort();
    }
}
