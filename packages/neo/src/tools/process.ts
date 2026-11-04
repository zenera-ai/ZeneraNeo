import { spawn } from 'node:child_process';
import { SandboxError } from './sandbox.ts';

/** One command's output is capped, so a `cat` of a log file cannot fill the context. */
const MAX_OUTPUT = 64 * 1024;
/** Nothing runs longer than this, whatever it asked for. */
export const MAX_TIMEOUT_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Spawning
//
// Small on purpose. `execa` would do this and more, and this package's runtime
// dependencies are two — so it does this and nothing more.
// ---------------------------------------------------------------------------

export interface ProcOptions {
    /** written to stdin, which is then closed */
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** per stream */
    maxBytes?: number;
}

export interface ProcResult {
    code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
}

export type Runner = (
    bin: string,
    args: readonly string[],
    opts?: ProcOptions,
) => Promise<ProcResult>;

export const runProcess: Runner = (bin, args, opts = {}) =>
    new Promise<ProcResult>((settle, fail) => {
        const max = opts.maxBytes ?? MAX_OUTPUT;
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outSize = 0;
        let errSize = 0;
        let truncated = false;
        let timedOut = false;
        let done = false;

        const child = spawn(bin, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

        const keep = (into: Buffer[], size: number, chunk: Buffer): number => {
            const room = max - size;
            if (room <= 0) {
                truncated = true;
                return size;
            }
            if (chunk.length > room) {
                truncated = true;
                into.push(chunk.subarray(0, room));
                return max;
            }
            into.push(chunk);
            return size + chunk.length;
        };

        child.stdout.on('data', (c: Buffer) => (outSize = keep(out, outSize, c)));
        child.stderr.on('data', (c: Buffer) => (errSize = keep(err, errSize, c)));

        // SIGTERM first so a well-behaved process can flush; SIGKILL after, so
        // one that ignores it cannot hold the turn open forever.
        let hard: NodeJS.Timeout | undefined;
        const stop = (): void => {
            child.kill('SIGTERM');
            hard = setTimeout(() => child.kill('SIGKILL'), 2000);
            hard.unref();
        };

        const timer = opts.timeoutMs
            ? setTimeout(
                  () => {
                      timedOut = true;
                      stop();
                  },
                  Math.min(opts.timeoutMs, MAX_TIMEOUT_MS),
              )
            : undefined;

        const onAbort = (): void => stop();
        opts.signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (fn: () => void): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            clearTimeout(hard);
            opts.signal?.removeEventListener('abort', onAbort);
            fn();
        };

        child.on('error', (e: NodeJS.ErrnoException) => {
            finish(() =>
                fail(
                    e.code === 'ENOENT'
                        ? new SandboxError(`${bin} is not installed, or not on PATH`)
                        : e,
                ),
            );
        });

        child.on('close', (code) => {
            finish(() =>
                settle({
                    code: code ?? (timedOut ? 124 : 1),
                    stdout: Buffer.concat(out).toString('utf8'),
                    stderr: Buffer.concat(err).toString('utf8'),
                    truncated,
                    timedOut,
                }),
            );
        });

        if (opts.input !== undefined) {
            child.stdin.on('error', () => {
                // A command that exits before reading its script closes the
                // pipe under us. That is the command's answer, not an error.
            });
            child.stdin.end(opts.input);
        } else {
            child.stdin.end();
        }
    });

// ---------------------------------------------------------------------------
// Reaching the engine at all
//
// On macOS and Windows the client is remote: unless it has been pointed at the
// machine's forwarded endpoint, every invocation opens its own ssh connection
// into the virtual machine, and sshd refuses new ones past `MaxStartups` — ten
// by default, with a random drop above that. A wide batch therefore loses
// calls for a reason that has nothing to do with the command, on a different
// task each time.
//
// A refused connection is the one failure that can be retried without asking
// what the command was: it happened before authentication, so nothing ran.
// ---------------------------------------------------------------------------

const TRANSPORT =
    /kex_exchange_identification|ssh: handshake failed|ssh: unexpected packet|connection closed by remote host|connection reset by peer|connection refused/i;

const ATTEMPTS = 4;

/**
 * `run`, retried while the engine could not be reached at all.
 *
 * Empty stdout is the guard that keeps this from retrying real work: a command
 * that produced output ran, whatever its stderr says afterwards. The wait is
 * jittered because the burst being backed off from is N clients arriving
 * together, and a fixed delay would only reassemble it.
 */
export function resilient(run: Runner, attempts = ATTEMPTS): Runner {
    return async (bin, args, opts = {}) => {
        for (let n = 1; ; n++) {
            const res = await run(bin, args, opts);
            if (
                n >= attempts ||
                res.code === 0 ||
                res.stdout !== '' ||
                opts.signal?.aborted ||
                !TRANSPORT.test(res.stderr)
            ) {
                return res;
            }
            await new Promise((go) => setTimeout(go, 2 ** n * 50 + Math.random() * 100));
        }
    };
}
