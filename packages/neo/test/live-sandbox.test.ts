import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileTools } from '../src/tools/files.ts';
import {
    DEFAULT_SANDBOX_IMAGE,
    PodmanSandbox,
    runProcess,
    WORKSPACE_MOUNT,
    type OutOfMemory,
} from '@zenera/sandbox';
import { sandboxTools } from '../src/tools/sandbox.ts';
import type { AnyTool, ToolContext } from '../src/types.ts';

// ---------------------------------------------------------------------------
// The other half of sandbox.test.ts.
//
// That file asserts which arguments podman is handed; this one hands them to
// podman. Everything here starts a real container, so nothing here can be
// checked by inspecting argv: that the mount is the workspace and only the
// workspace, that `--read-only` is honoured by the engine rather than by us,
// that a killed job's children die with it, that the timeout returns.
//
// It self-skips when no engine answers, like the live model tests do without a
// key, and it is excluded by `npm test -- --exclude '**/live-*'`.
// ---------------------------------------------------------------------------

const ENGINE = process.env.ZENERA_SANDBOX_ENGINE ?? 'podman';
const IMAGE = process.env.ZENERA_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
const MINUTE = 60_000;

/** `info` rather than `--version`: on macOS the binary exists long before the VM does. */
async function engineAnswers(): Promise<boolean> {
    try {
        const res = await runProcess(ENGINE, ['info', '--format', '{{.Host.OS}}'], {
            timeoutMs: MINUTE,
        });
        return res.code === 0;
    } catch {
        return false;
    }
}

const ENABLED = await engineAnswers();

if (!ENABLED) {
    console.warn(`[live-sandbox] skipped: \`${ENGINE} info\` did not answer`);
}

describe.skipIf(!ENABLED)('a real container', () => {
    let root = '';
    let box: PodmanSandbox;

    /** Container names, so cleanup can be checked against the engine itself. */
    const exists = async (name: string): Promise<boolean> =>
        (await runProcess(ENGINE, ['container', 'inspect', name], { timeoutMs: MINUTE })).code ===
        0;

    beforeAll(async () => {
        // realpath matters on macOS, where the mkdtemp path is under a symlink
        // (/var -> /private/var) and the VM only shares the resolved one.
        root = await realpath(await mkdtemp(join(tmpdir(), 'zn-live-sandbox-')));

        const has = await runProcess(ENGINE, ['image', 'exists', IMAGE], { timeoutMs: MINUTE });
        if (has.code !== 0) {
            const pull = await runProcess(ENGINE, ['pull', IMAGE], { timeoutMs: 10 * MINUTE });
            if (pull.code !== 0) {
                throw new Error(`could not pull ${IMAGE}: ${pull.stderr.trim()}`);
            }
        }

        box = new PodmanSandbox({ root, key: 'live-sandbox', image: IMAGE }, { engine: ENGINE });
        await box.start();
    }, 12 * MINUTE);

    afterAll(async () => {
        await box?.close();
        if (root) {
            await rm(root, { recursive: true, force: true });
        }
    }, 2 * MINUTE);

    it(
        'runs a command and reports what it did',
        async () => {
            const res = await box.exec('echo hello; echo oops >&2; exit 3');
            expect(res.exit_code).toBe(3);
            expect(res.stdout).toBe('hello\n');
            expect(res.stderr).toBe('oops\n');
            expect(res.timed_out).toBeUndefined();
            expect(res.duration_ms).toBeGreaterThanOrEqual(0);
        },
        MINUTE,
    );

    it(
        'keeps state between commands, because it is one container',
        async () => {
            await box.exec('echo remembered > /tmp/marker');
            expect((await box.exec('cat /tmp/marker')).stdout).toBe('remembered\n');
        },
        MINUTE,
    );

    it(
        'runs the command inside, not here',
        async () => {
            // Two proofs at once: the shell that parsed this was the container's
            // (the host spawns argv arrays only), and the host directory holding
            // the workspace is not itself reachable from in there.
            const res = await box.exec(`[ -e '${root}' ] && echo host-visible || echo isolated`);
            expect(res.stdout.trim()).toBe('isolated');

            const uname = await box.exec('uname -s');
            expect(uname.stdout.trim()).toBe('Linux');
        },
        MINUTE,
    );

    it(
        'passes shell metacharacters through as text',
        async () => {
            const nasty = String.raw`a; b \`c\` $(d) && e | f > g`;
            const res = await box.exec(`cat <<'EOF'\n${nasty}\nEOF`);
            expect(res.stdout).toBe(`${nasty}\n`);
        },
        MINUTE,
    );

    it(
        'mounts the workspace, and it is the same directory on both sides',
        async () => {
            await writeFile(join(root, 'from-host.txt'), 'written outside\n');

            const read = await box.exec(`cat ${WORKSPACE_MOUNT}/from-host.txt`);
            expect(read.exit_code).toBe(0);
            expect(read.stdout).toBe('written outside\n');

            const wrote = await box.exec('printf "written inside\\n" > made-here.txt');
            expect(wrote.exit_code).toBe(0);
            expect(await readFile(join(root, 'made-here.txt'), 'utf8')).toBe('written inside\n');
        },
        MINUTE,
    );

    it(
        'runs in the workspace by default and in a subdirectory on request',
        async () => {
            expect((await box.exec('pwd')).stdout.trim()).toBe(WORKSPACE_MOUNT);
            await box.exec('mkdir -p sub/dir');
            expect((await box.exec('pwd', { cwd: 'sub/dir' })).stdout.trim()).toBe(
                `${WORKSPACE_MOUNT}/sub/dir`,
            );
        },
        MINUTE,
    );

    it(
        'returns when the timeout expires rather than holding the turn',
        async () => {
            const res = await box.exec('sleep 60', { timeout: 2 });
            expect(res.timed_out).toBe(true);
            expect(res.exit_code).not.toBe(0);
            expect(res.duration_ms).toBeLessThan(30_000);
        },
        MINUTE,
    );

    it(
        'caps the output a single command can return',
        async () => {
            const res = await box.exec('yes 0123456789 | head -n 40000');
            expect(res.truncated).toBe(true);
            expect(res.stdout.length).toBeLessThanOrEqual(64 * 1024);
        },
        2 * MINUTE,
    );

    describe('background jobs', () => {
        it(
            'outlives the call that started it, and is readable in windows',
            async () => {
                const id = await box.startJob(
                    'for i in 1 2 3 4 5; do echo line-$i; sleep 1; done; echo done',
                );

                const first = await box.readJob(id);
                expect(first.running).toBe(true);
                expect(first.job_id).toBe(id);

                let last = first;
                for (let i = 0; i < 30 && last.running === true; i++) {
                    await new Promise((r) => setTimeout(r, 1000));
                    last = await box.readJob(id);
                }

                expect(last.running).toBe(false);
                expect(last.exit_code).toBe(0);
                expect(String(last.output)).toContain('line-5');
                expect(last.lines).toBe(6);

                const tail = await box.readJob(id, 6);
                expect(tail.start_line).toBe(6);
                expect(tail.output).toBe('done\n');
            },
            2 * MINUTE,
        );

        it(
            'kills the whole process group, not just the wrapper',
            async () => {
                // `ps` is not in a slim image, so count /proc instead. The duration
                // is a marker: the container's own `sleep infinity` would otherwise
                // be counted too. The bracket keeps grep off its own command line.
                const children = async (): Promise<number> => {
                    const res = await box.exec(
                        String.raw`grep -al '31313[1]' /proc/[0-9]*/cmdline 2>/dev/null | wc -l`,
                    );
                    return Number(res.stdout.trim());
                };

                const id = await box.startJob('sleep 313131 & sleep 313131 & wait');
                await new Promise((r) => setTimeout(r, 1000));
                expect(await children()).toBe(2);

                await box.stopJob(id);
                await new Promise((r) => setTimeout(r, 1500));
                expect(await children()).toBe(0);
            },
            2 * MINUTE,
        );
    });

    describe('a read-only run', () => {
        it(
            'is refused by the engine, not by us',
            async () => {
                const ro = new PodmanSandbox(
                    {
                        root,
                        key: 'live-sandbox-ro',
                        image: IMAGE,
                        readOnly: true,
                        env: { ZENERA_LIVE: 'yes' },
                    },
                    { engine: ENGINE },
                );
                try {
                    const write = await ro.exec('printf x > refused.txt');
                    expect(write.exit_code).not.toBe(0);
                    expect(write.stderr.toLowerCase()).toContain('read-only');

                    // The forwarded environment is the same container, so it costs
                    // nothing to check that it actually arrived.
                    expect((await ro.exec('printf %s "$ZENERA_LIVE"')).stdout).toBe('yes');

                    // ...and the container's own filesystem is still writable, or
                    // every package manager would be dead on arrival.
                    expect((await ro.exec('printf x > /tmp/fine')).exit_code).toBe(0);
                } finally {
                    await ro.close();
                }
            },
            3 * MINUTE,
        );
    });

    /**
     * Which cgroup did the killing is not something argv can be asked, so the
     * unit tests can only check the arithmetic against a counter they invented.
     * Here the kernel supplies it.
     */
    describe('an out-of-memory kill', () => {
        // 512 MB held in a shell variable, inside a container allowed 256 MiB.
        // `head` and `tr` only, so it does not assume the image's interpreter.
        const HOG = String.raw`x=$(head -c 512000000 /dev/zero | tr "\0" a); echo survived`;

        const tight = (key: string): PodmanSandbox =>
            new PodmanSandbox({ root, key, image: IMAGE, memory: 256 }, { engine: ENGINE });

        it(
            'blames the limit rather than the machine, and leaves other failures alone',
            async () => {
                const small = tight('live-sandbox-oom');
                try {
                    const res = await small.exec(HOG, { timeout: 60 });
                    expect(res.exit_code).toBe(137);
                    expect(res.stdout).not.toContain('survived');
                    expect(res.out_of_memory?.limit_mib).toBe(256);
                    expect(res.out_of_memory?.retryable).toBe(false);
                    expect(res.out_of_memory?.peak_mib).toBeGreaterThan(128);

                    const plain = await small.exec('echo no; exit 3');
                    expect(plain.exit_code).toBe(3);
                    expect(plain.out_of_memory).toBeUndefined();
                } finally {
                    await small.close();
                }
            },
            3 * MINUTE,
        );

        it(
            'explains a killed job the same way however often its log is read',
            async () => {
                const small = tight('live-sandbox-oom-job');
                try {
                    const id = await small.startJob(HOG);
                    // Waits by the clock, not by a count: on a loaded machine a
                    // poll costs seconds, and counting them shortens the wait
                    // exactly when the job needs it to be longer.
                    const until = Date.now() + 60_000;
                    let last = await small.readJob(id);
                    while (last.running === true && Date.now() < until) {
                        await new Promise((r) => setTimeout(r, 1000));
                        last = await small.readJob(id);
                    }

                    expect(last.running).toBe(false);
                    expect(last.exit_code).toBe(137);
                    const verdict = last.out_of_memory as OutOfMemory | undefined;
                    expect(verdict?.retryable).toBe(false);

                    // The second read cannot see the counter move, so only the
                    // cache keeps it from calling this the machine's doing.
                    const again = await small.readJob(id);
                    expect(again.out_of_memory).toEqual(verdict);
                } finally {
                    await small.close();
                }
            },
            3 * MINUTE,
        );
    });

    /**
     * The two toolsets are handed to the same agent and they name the same
     * bytes: `run_command` writes at /workspace, `read_file` reads at the
     * relative path, and neither has to be told they are the same directory.
     * This is the seam `WorkspaceOptions.mount` exists for, and it can only be
     * checked against a real bind mount.
     */
    describe('the file tools and the shell', () => {
        const AGENT = { agent: { name: 'both' } } as ToolContext;

        const call = async (tools: AnyTool[], name: string, args: unknown): Promise<any> => {
            const found = tools.find((t) => t.name === name);
            if (!found) {
                throw new Error(`no such tool: ${name}`);
            }
            return await found.execute(args, AGENT);
        };

        /**
         * The container's name is a function of its spec, so a box built from
         * the same options attaches to the one `beforeAll` started — no second
         * container, and `afterAll`'s dispose covers this one too.
         */
        const toolsets = (): { file: AnyTool[]; shell: AnyTool[] } => ({
            file: fileTools({ root, mount: WORKSPACE_MOUNT }),
            shell: sandboxTools(
                new PodmanSandbox({ root, key: 'live-sandbox', image: IMAGE }, { engine: ENGINE }),
            ),
        });

        it(
            'read what the other one wrote, whichever way the path is spelled',
            async () => {
                const { file, shell } = toolsets();

                // The container makes three files under its own name for the
                // directory...
                const made = await call(shell, 'run_command', {
                    command:
                        'mkdir -p /workspace/both && for i in 1 2 3; do ' +
                        'printf "from the shell %s\\n" "$i" > /workspace/both/shell-$i.txt; done',
                });
                expect(made.exit_code).toBe(0);

                // ...and the file tools see them under theirs. Paths come back
                // relative whichever spelling went in.
                const listed = await call(file, 'list_dir', { path: `${WORKSPACE_MOUNT}/both` });
                const names = (out: any): string[] =>
                    out.entries.map((e: any) => e.name).sort() as string[];
                expect(names(listed)).toEqual(['shell-1.txt', 'shell-2.txt', 'shell-3.txt']);
                expect(listed.entries.find((e: any) => e.name === 'shell-1.txt')).toMatchObject({
                    format: 'text',
                    lines: 1,
                });
                expect(await call(file, 'list_dir', { path: 'both' })).toEqual(listed);

                const read = await call(file, 'read_file', {
                    path: `${WORKSPACE_MOUNT}/both/shell-2.txt`,
                });
                expect(read.content).toBe('from the shell 2');
                // Out under the name the shell prints, whichever name went in.
                expect(read.path).toBe(`${WORKSPACE_MOUNT}/both/shell-2.txt`);
                expect(await call(file, 'read_file', { path: 'both/shell-2.txt' })).toEqual(read);

                const found = await call(file, 'find_files', {
                    pattern: 'shell-',
                    path: `${WORKSPACE_MOUNT}/both`,
                });
                expect(found.matches.sort()).toEqual([
                    `${WORKSPACE_MOUNT}/both/shell-1.txt`,
                    `${WORKSPACE_MOUNT}/both/shell-2.txt`,
                    `${WORKSPACE_MOUNT}/both/shell-3.txt`,
                ]);

                // ...so a path taken straight out of a command's output is a
                // path read_file accepts, which is the whole point.
                const listing = await call(shell, 'run_command', {
                    command: 'find /workspace/both -name shell-3.txt',
                });
                const printed = listing.stdout.trim();
                expect(printed).toBe(`${WORKSPACE_MOUNT}/both/shell-3.txt`);
                expect((await call(file, 'read_file', { path: printed })).content).toBe(
                    'from the shell 3',
                );

                // The other direction: written by the file tools, once under
                // each spelling, and read back inside the container.
                await call(file, 'write_file', {
                    path: `${WORKSPACE_MOUNT}/both/tools-1.txt`,
                    content: 'from the file tools 1\n',
                });
                await call(file, 'write_file', {
                    path: 'both/tools-2.txt',
                    content: 'from the file tools 2\n',
                });
                const back = await call(shell, 'run_command', {
                    command: 'cat /workspace/both/tools-1.txt /workspace/both/tools-2.txt',
                });
                expect(back.exit_code).toBe(0);
                expect(back.stdout).toBe('from the file tools 1\nfrom the file tools 2\n');

                // Both spellings landed in one directory, not two.
                const all = await call(shell, 'run_command', { command: 'ls both | sort' });
                expect(all.stdout.trim().split('\n')).toEqual([
                    'shell-1.txt',
                    'shell-2.txt',
                    'shell-3.txt',
                    'tools-1.txt',
                    'tools-2.txt',
                ]);
            },
            2 * MINUTE,
        );

        it(
            'agree about the root, whether it is called /, /workspace or .',
            async () => {
                const { file, shell } = toolsets();

                const dot = await call(file, 'list_dir', { path: '.' });
                expect(dot.path).toBe(WORKSPACE_MOUNT);
                expect(await call(file, 'list_dir', { path: '/' })).toEqual(dot);
                expect(await call(file, 'list_dir', { path: WORKSPACE_MOUNT })).toEqual(dot);

                // ...and it is the directory the container starts in.
                const pwd = await call(shell, 'run_command', { command: 'pwd' });
                expect(pwd.stdout.trim()).toBe(WORKSPACE_MOUNT);

                const inside = await call(shell, 'run_command', {
                    command: 'ls -A /workspace | sort',
                });
                expect(inside.stdout.trim().split('\n').sort()).toEqual(
                    dot.entries.map((e: any) => e.name).sort(),
                );
            },
            2 * MINUTE,
        );

        it(
            'patch a file the container is about to run',
            async () => {
                const { file, shell } = toolsets();

                await call(file, 'write_file', {
                    path: 'both/report.sh',
                    content: '#!/bin/sh\necho draft\n',
                });
                const patched = await call(file, 'apply_patch', {
                    patch: [
                        '*** Begin Patch',
                        `*** Update File: ${WORKSPACE_MOUNT}/both/report.sh`,
                        '@@',
                        ' #!/bin/sh',
                        '-echo draft',
                        '+echo final',
                        '*** End Patch',
                        '',
                    ].join('\n'),
                });
                expect(patched.applied).toBe(1);
                expect(patched.files[0].path).toBe(`${WORKSPACE_MOUNT}/both/report.sh`);

                const ran = await call(shell, 'run_command', {
                    command: 'sh /workspace/both/report.sh',
                });
                expect(ran.stdout).toBe('final\n');

                // A rename made here is the same rename in there. Only the new
                // name is checked inside the container: the guest caches
                // directory lookups for about a second, so an immediate
                // "is it gone?" would be asking the cache, not the mount.
                const moved = await call(file, 'move_file', {
                    from: `${WORKSPACE_MOUNT}/both/report.sh`,
                    to: 'both/final.sh',
                });
                expect(moved).toMatchObject({
                    from: `${WORKSPACE_MOUNT}/both/report.sh`,
                    to: `${WORKSPACE_MOUNT}/both/final.sh`,
                    moved: true,
                });
                const after = await call(shell, 'run_command', {
                    command: 'sh /workspace/both/final.sh',
                });
                expect(after.stdout).toBe('final\n');

                const left = await call(file, 'list_dir', { path: WORKSPACE_MOUNT + '/both' });
                const names = left.entries.map((e: any) => e.name);
                expect(names).toContain('final.sh');
                expect(names).not.toContain('report.sh');
            },
            2 * MINUTE,
        );
    });

    describe('disposal', () => {
        it(
            'removes an ephemeral container and leaves the workspace behind',
            async () => {
                const one = new PodmanSandbox(
                    {
                        root,
                        key: 'live-sandbox-gone',
                        image: IMAGE,
                    },
                    { engine: ENGINE },
                );
                await one.exec('echo survives > disposed.txt');
                expect(await exists(one.name)).toBe(true);

                await one.close();
                expect(one.started).toBe(false);
                expect(await exists(one.name)).toBe(false);
                expect(await readFile(join(root, 'disposed.txt'), 'utf8')).toBe('survives\n');
            },
            3 * MINUTE,
        );

        it(
            'only stops one that asked to persist',
            async () => {
                const kept = new PodmanSandbox(
                    {
                        root,
                        key: 'live-sandbox-kept',
                        image: IMAGE,
                        persist: true,
                    },
                    { engine: ENGINE },
                );
                try {
                    await kept.exec('true');
                    await kept.close();
                    expect(await exists(kept.name)).toBe(true);

                    // ...and it comes back up rather than being recreated: the
                    // container name is a function of the spec, so this is the
                    // same one, with what the last session left in it.
                    await kept.exec('echo again > /tmp/resumed');
                    expect((await kept.exec('cat /tmp/resumed')).stdout).toBe('again\n');
                } finally {
                    await runProcess(ENGINE, ['rm', '--force', '--volumes', kept.name], {
                        timeoutMs: MINUTE,
                    });
                }
            },
            3 * MINUTE,
        );
    });
});

/**
 * The trees that are mounted beside the workspace: the project's assets and its
 * skill catalog. Only a real container can say whether `:ro` holds, and only a
 * real one can run a skill's script — which is the point of mounting the
 * catalog at all.
 */
describe.skipIf(!ENABLED)('mounted reference material', () => {
    const AGENT = { agent: { name: 'reader' } } as ToolContext;
    let root = '';
    let assets = '';
    let skills = '';
    let box: PodmanSandbox;
    let file: AnyTool[];
    let shell: AnyTool[];

    const call = async (tools: AnyTool[], name: string, args: unknown): Promise<any> => {
        const found = tools.find((t) => t.name === name);
        if (!found) {
            throw new Error(`no such tool: ${name}`);
        }
        return await found.execute(args, AGENT);
    };

    beforeAll(async () => {
        // realpath: the VM only shares the resolved path.
        root = await realpath(await mkdtemp(join(tmpdir(), 'zn-live-mounts-')));
        assets = await realpath(await mkdtemp(join(tmpdir(), 'zn-live-assets-')));
        skills = await realpath(await mkdtemp(join(tmpdir(), 'zn-live-skills-')));

        await writeFile(join(assets, 'handbook.md'), 'Always say please.\n', 'utf8');
        await mkdir(join(skills, 'greet', 'scripts'), { recursive: true });
        await writeFile(
            join(skills, 'greet', 'SKILL.md'),
            '---\ndescription: Greets.\n---\nRun scripts/hello.py.\n',
            'utf8',
        );
        await writeFile(
            join(skills, 'greet', 'scripts', 'hello.py'),
            'print("hello from the skill")\n',
            'utf8',
        );

        const mounts = [
            { host: assets, at: '/assets', readOnly: true },
            { host: skills, at: '/skills', readOnly: true },
        ];
        file = fileTools({ root, mount: WORKSPACE_MOUNT, mounts });
        shell = sandboxTools(
            new PodmanSandbox(
                {
                    root,
                    key: 'live-mounts',
                    image: IMAGE,
                    mounts,
                    env: { PYTHONDONTWRITEBYTECODE: '1' },
                },
                { engine: ENGINE },
            ),
        );
        box = new PodmanSandbox(
            {
                root,
                key: 'live-mounts',
                image: IMAGE,
                mounts,
                env: { PYTHONDONTWRITEBYTECODE: '1' },
            },
            { engine: ENGINE },
        );
        await box.start();
    }, 12 * MINUTE);

    afterAll(async () => {
        await box?.close();
        for (const dir of [root, assets, skills]) {
            if (dir) {
                await rm(dir, { recursive: true, force: true });
            }
        }
    }, 2 * MINUTE);

    it(
        'runs a script the skill shipped, from where the skill says it is',
        async () => {
            const out = await call(shell, 'run_command', {
                command: 'python /skills/greet/scripts/hello.py',
            });
            expect(out.exit_code).toBe(0);
            expect(out.stdout).toBe('hello from the skill\n');
        },
        2 * MINUTE,
    );

    it(
        'is the same bytes under the same name on both sides',
        async () => {
            expect((await call(file, 'read_file', { path: '/assets/handbook.md' })).content).toBe(
                'Always say please.',
            );
            const printed = await call(shell, 'run_command', {
                command: 'cat /assets/handbook.md',
            });
            expect(printed.stdout).toBe('Always say please.\n');

            // Omitting the path searches everything the agent can see.
            const found = await call(file, 'find_files', { pattern: 'hello.py' });
            expect(found.matches).toContain('/skills/greet/scripts/hello.py');
        },
        2 * MINUTE,
    );

    it(
        'refuses a write from either side',
        async () => {
            await expect(
                call(file, 'write_file', { path: '/assets/new.md', content: 'no' }),
            ).rejects.toThrow(/read-only/);

            const shellWrite = await call(shell, 'run_command', {
                command: 'echo no > /assets/new.md; echo no > /skills/greet/new.py',
            });
            expect(shellWrite.exit_code).not.toBe(0);
            expect(await call(file, 'list_dir', { path: '/assets' })).toMatchObject({
                entries: [{ name: 'handbook.md' }],
            });
        },
        2 * MINUTE,
    );
});
