import { describe, expect, it } from 'vitest';
import { resilient, type ProcOptions, type ProcResult, type Runner } from '../src/index.ts';

// ---------------------------------------------------------------------------
// `resilient` repeats a podman call that failed before anything ran, and must
// never repeat one that ran. The 'a refused connection' tests in
// packages/neo/test/sandbox.test.ts pin the outline; these pin each clause of
// the guard, so that removing any one of them turns at least one test red.
//
// They live here rather than beside those because they import `../src`: a
// change to process.ts is seen at once, with no build in between.
//
// No process starts. The runner is injected, and all that is observed is how
// often it was called and with what.
// ---------------------------------------------------------------------------

const answer = (res: Partial<ProcResult>): ProcResult => ({
    code: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    ...res,
});

interface Call {
    bin: string;
    args: string[];
    opts?: ProcOptions;
}

/** Plays `script` in order, repeating its last answer, and records every call. */
function scripted(...script: Partial<ProcResult>[]): { run: Runner; calls: Call[] } {
    const calls: Call[] = [];
    const run: Runner = (bin, args, opts) => {
        calls.push({ bin, args: [...args], opts });
        return Promise.resolve(answer(script[Math.min(calls.length, script.length) - 1] ?? {}));
    };
    return { run, calls };
}

/** podman's client failing before it had a session: its own error, exit 125. */
const REFUSED = { code: 125, stderr: 'Error: failed to connect: ssh: handshake failed: EOF' };

/**
 * One line per alternative of the transport pattern, each matching that
 * alternative and no other, so dropping any one of them turns exactly one row
 * red. Where ssh and Go capitalise, these do too, which is what holds the
 * pattern's `i` flag.
 */
const TRANSPORT = [
    'kex_exchange_identification: banner line contains invalid characters',
    'Error: failed to connect: ssh: handshake failed: EOF',
    'Error: ssh: unexpected packet in response to channel open: <nil>',
    'Connection closed by remote host',
    'Error: dial tcp 127.0.0.1:50321: connect: connection refused',
    'read tcp 127.0.0.1:52345->127.0.0.1:50321: read: Connection reset by peer',
];

describe('a call that never reached the engine', () => {
    it.each(TRANSPORT)('is retried after: %s', async (stderr) => {
        const f = scripted({ code: 125, stderr }, { stdout: 'ok' });
        const res = await resilient(f.run)('podman', ['ps']);
        expect(res.stdout).toBe('ok');
        expect(f.calls).toHaveLength(2);
    });

    /**
     * The command travels on stdin. A retry that lost the options would hand
     * podman an empty shell, which exits 0 having done nothing — and report
     * that as the command's success.
     */
    it('is retried with exactly what the first attempt was given', async () => {
        const f = scripted(REFUSED, { stdout: 'ok' });
        const opts: ProcOptions = { input: 'make test', timeoutMs: 5000 };
        const args = ['exec', '--interactive', 'zn-x', '/bin/sh', '-s'];
        await resilient(f.run)('podman', args, opts);
        expect(f.calls).toHaveLength(2);
        expect(f.calls[1]).toEqual(f.calls[0]);
        expect(f.calls[1]?.opts?.input).toBe('make test');
    });
});

describe('a command that ran', () => {
    /**
     * pip retries its own downloads and warns on stderr as it does; with `-q`
     * a successful install prints nothing on stdout. Exit 0 is the only clause
     * that keeps this from running again.
     */
    it('is not repeated when it succeeded, whatever it said on stderr', async () => {
        const warning =
            "WARNING: Retrying (Retry(total=4)) after connection broken by 'NewConnectionError(" +
            "...: Failed to establish a new connection: [Errno 111] Connection refused')': " +
            '/simple/requests/';
        const f = scripted({ code: 0, stderr: warning });
        const res = await resilient(f.run)('podman', ['exec'], {
            input: 'pip install -q requests',
        });
        expect(res.code).toBe(0);
        expect(f.calls).toHaveLength(1);
    });

    /** `echo` with no arguments ran. Output is any byte at all, not any visible one. */
    it('is not repeated when all it printed was a newline', async () => {
        const f = scripted({ code: 125, stdout: '\n', stderr: 'Connection reset by peer' });
        await resilient(f.run)('podman', ['exec']);
        expect(f.calls).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Known gaps
//
// Each of these is a command that ran — or one that was abandoned — and that
// the guard repeats anyway. They are `it.fails`: green while the gap is open,
// red the moment it closes, at which point the `.fails` comes off.
// ---------------------------------------------------------------------------

describe('known gaps', () => {
    /**
     * podman relays the command's stderr unchanged, so the transport pattern
     * cannot tell whose words it is reading. A script in the default Python
     * image that appends to a log and then probes a server that is not up yet
     * fails with exactly the text the pattern looks for, prints nothing on
     * stdout, and runs again — append included — up to four times.
     */
    it.fails('does not repeat a command whose own stderr says connection refused', async () => {
        const f = scripted({
            code: 1,
            stderr:
                'Traceback (most recent call last):\n' +
                '  File "/workspace/probe.py", line 3, in <module>\n' +
                'ConnectionRefusedError: [Errno 111] Connection refused\n',
        });
        await resilient(f.run)('podman', ['exec'], {
            input: 'echo started >> run.log\npython probe.py',
        });
        expect(f.calls).toHaveLength(1);
    });

    /**
     * Polling a server that never comes up until the timeout leaves stderr full
     * of refusals and stdout empty. Every repeat waits out the whole timeout
     * again, so the agent waits up to four times what it asked for.
     */
    it.fails('does not repeat a command that ran until its timeout', async () => {
        const f = scripted({
            code: 124,
            timedOut: true,
            stderr: 'ConnectionRefusedError: [Errno 111] Connection refused\n'.repeat(3),
        });
        await resilient(f.run)('podman', ['exec'], {
            input: 'until python probe.py; do sleep 1; done',
        });
        expect(f.calls).toHaveLength(1);
    });

    /**
     * Output on stderr is output: git and pip report progress there. If the
     * connection then drops, stdout is still empty and the command runs again.
     * Not confirmed against a real podman: this is the shape the guard
     * accepts, not a captured failure.
     */
    it.fails('does not repeat a command whose only output went to stderr', async () => {
        const f = scripted({
            code: 125,
            stderr:
                "Cloning into 'repo'...\n" +
                'Error: read tcp 127.0.0.1:52345: read: connection reset by peer',
        });
        await resilient(f.run)('podman', ['exec'], {
            input: 'git clone https://example.com/repo.git',
        });
        expect(f.calls).toHaveLength(1);
    });

    /**
     * The guard reads the signal only after an attempt, never after the wait.
     * An abort that lands during the back-off still starts another attempt —
     * and `runProcess` does not kill a process whose signal was aborted before
     * it spawned, so that attempt runs to the end.
     */
    it.fails('starts no further attempt once the turn is abandoned in the back-off', async () => {
        const turn = new AbortController();
        const f = scripted(REFUSED, { stdout: 'ok' });
        const run: Runner = (bin, args, opts) => {
            if (f.calls.length === 0) {
                // The first back-off is at least 100 ms; this lands well inside it.
                setTimeout(() => turn.abort(), 20);
            }
            return f.run(bin, args, opts);
        };
        await resilient(run)('podman', ['ps'], { signal: turn.signal });
        expect(f.calls).toHaveLength(1);
    });
});
