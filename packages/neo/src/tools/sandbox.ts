import { tool, type AnyTool, type JsonSchema } from '../types.ts';
import { SandboxError, WORKSPACE_MOUNT, type Sandbox } from '@zenera/sandbox';

// ---------------------------------------------------------------------------
// Sandbox tools
//
// A shell, and a boundary around it. The boundary is a container: the agent's
// commands run against an image the project chose, with one host directory
// bind-mounted at `/workspace` and nothing else of the machine in reach. That
// is the whole security story, and it is deliberately the *only* one — the
// command string is handed to `/bin/sh` verbatim, because escaping a shell
// language is a game nobody wins and the container is what makes losing it
// survivable.
//
// The host side is the opposite: every process is spawned with an argv array
// and `shell: false`, and the command text travels on **stdin** rather than in
// an argument, so there is no host shell to inject into and no argv length to
// overflow.
//
// Nothing here knows how to install a container engine or start a virtual
// machine. That is a host concern with a user attached to it, so it lives in
// whatever front end is driving this — the library only reports, clearly, that
// the engine did not answer.
// ---------------------------------------------------------------------------

/** The family name config selects the whole set by: `tools: [sandbox:*]`. */
export const SANDBOX_GROUP = 'sandbox';

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function sandboxTools<TCtx = unknown>(sandbox: Sandbox): AnyTool<TCtx>[] {
    const where: JsonSchema = {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command. Runs under /bin/sh inside the container.',
            },
            cwd: {
                type: 'string',
                description: `Directory to run in, relative to ${WORKSPACE_MOUNT}.`,
            },
        },
        required: ['command'],
        additionalProperties: false,
    };

    const runCommand = tool<{ command: string; cwd?: string; timeout?: number }, TCtx>({
        name: 'run_command',
        group: SANDBOX_GROUP,
        description:
            'Runs a shell command in a Linux container and waits for it to finish. The ' +
            `workspace is mounted at ${WORKSPACE_MOUNT} and is the working directory, so files you ` +
            'read and write here are the same files the file tools see. Everything ' +
            'else is throwaway. Use this for builds, tests, and package installs; use ' +
            'run_command_background for anything that does not end on its own, such as a ' +
            'server or a watcher.',
        parameters: {
            ...where,
            properties: {
                ...where.properties,
                timeout: { type: 'integer', description: 'Seconds to allow before killing it.' },
            },
        },
        execute: (args, tc) =>
            guard(() =>
                sandbox.exec(args.command, {
                    cwd: args.cwd,
                    timeout: args.timeout,
                    signal: tc.signal,
                }),
            ),
    });

    const runBackground = tool<{ command: string; cwd?: string }, TCtx>({
        name: 'run_command_background',
        group: SANDBOX_GROUP,
        description:
            'Starts a long-running command and returns immediately with a job id. Output ' +
            'is collected to a log you read with read_command_output; stop it with ' +
            'stop_command. Use this for servers, watchers, and anything you want to keep ' +
            'running while you do something else.',
        parameters: where,
        execute: (args) =>
            guard(async () => {
                const id = await sandbox.startJob(args.command, { cwd: args.cwd });
                return {
                    job_id: id,
                    started: true,
                    hint: 'read_command_output shows what it has printed so far',
                };
            }),
    });

    const readOutput = tool<{ job_id: string; start_line?: number }, TCtx>({
        name: 'read_command_output',
        group: SANDBOX_GROUP,
        description:
            "Reads a background job's output and says whether it is still running. Pass " +
            'start_line to continue from where the last read ended, which is `end_line + 1`.',
        parameters: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'From run_command_background.' },
                start_line: { type: 'integer', description: 'First log line to return, 1-based.' },
            },
            required: ['job_id'],
            additionalProperties: false,
        },
        execute: (args) => guard(() => sandbox.readJob(args.job_id, args.start_line)),
    });

    const stop = tool<{ job_id: string }, TCtx>({
        name: 'stop_command',
        group: SANDBOX_GROUP,
        description: 'Stops a background job and everything it started.',
        parameters: {
            type: 'object',
            properties: { job_id: { type: 'string', description: 'From run_command_background.' } },
            required: ['job_id'],
            additionalProperties: false,
        },
        execute: (args) => guard(() => sandbox.stopJob(args.job_id)),
    });

    return [runCommand, runBackground, readOutput, stop];
}

/**
 * A missing engine and a path outside the workspace are things the model can
 * be told about; anything else is a bug and should reach the runner as one.
 */
async function guard(fn: () => Promise<unknown>): Promise<unknown> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof SandboxError) {
            return { error: err.message, hint: err.hint };
        }
        throw err;
    }
}
