/**
 * Host-side image build and container lifecycle for zen server start --container.
 * buildAgentImage packs the installed runtime onto the project's sandbox image;
 * agentDockerfile defines its non-root Node/bwrap environment, and runContainer
 * mounts project/state and a startup seed snapshot, publishes the port, follows logs
 * and forwards shutdown before cleaning up the snapshot.
 * Used by commands/server.ts; onStarted lets that command print a host-side chat link.
 */
import {
    home,
    KeyStore,
    credentials,
    gcloudAdc,
    loadProjectEnv,
    MODEL_CONTEXT_ENV,
    resolveBuild,
    writeRuntime,
} from '@zenera/engine';
import { DEFAULT_SANDBOX_IMAGE, readProjectConfig } from '@zenera/neo';
import { runProcess } from '@zenera/sandbox';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asCliError, ensureImage, ensurePodmanReady } from './podman.ts';
import { prepareMemorySeed } from './seed.ts';
import { buildProgress, HOST_MANAGED_ENV, streamAgentBuild } from './serverDisplay.ts';
import { bold, CliError, cyan, dim, EXIT, green, note, table, yellow } from './term.ts';

// ---------------------------------------------------------------------------
// The agent image, built here and run in podman: `zen server start --container`.
//
// Two builds. The project's environment — its sandbox/Dockerfile, or its
// `image:` — exactly as `zen run` builds or pulls it. Then the agent image on
// top of it: this CLI's own @zenera packages (packed from where they are
// installed, so it runs this code, released or not) with a Linux Node, a
// static bwrap, the `zenera` libraries and the image's own environment for
// commands, all under /opt/zenera, with `zen server start` as its command.
// Inside it the server finds itself in the agent image: bwrap, /project,
// /state. Nothing in it builds or starts containers.
//
// The Node runtime, the @zenera packages and bwrap are the same for every
// project, so a released CLI copies them from the release's prebuilt image
// (zenera-agent-runtime:<version>, agent-runtime.Dockerfile, published by
// CI) instead of installing and compiling them here. A dev checkout, a
// failed pull or ZEN_AGENT_RUNTIME=local builds them here as before.
// ---------------------------------------------------------------------------

/** The packages the server needs, in an order npm can install from files. */
const PACKAGES = ['sandbox', 'neo', 'view', 'engine', 'server', 'cli'] as const;

const BWRAP_VERSION = '0.13.1';
const IMAGE_REPO = 'localhost/zenera-agent';
export const AGENT_RUNTIME_REPO = 'ghcr.io/zenera-ai/zenera-agent-runtime';
const ENTRY = '/opt/zenera/app/node_modules/@zenera/cli/dist/main.js';
export const AGENT_UID = 10001;
export const AGENT_GID = 10001;

export interface AgentImage {
    /** the agent image */
    tag: string;
    /** what it was built on: the project's environment */
    base: string;
    built: boolean;
}

/** The agent image for a project, built unless this machine has it already. */
export async function buildAgentImage(
    projectDir: string,
    opts: { rebuild?: boolean; verbose?: boolean } = {},
): Promise<AgentImage> {
    await ensurePodmanReady({ yes: true }).catch((err: unknown) => {
        throw asCliError(err);
    });

    // 1. The project's environment, as `zen run` has it.
    const { root, config } = readProjectConfig(projectDir);
    const build = resolveBuild(root, config.sandbox);
    const base = build?.tag ?? config.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE;
    const baseOutput = buildProgress(opts.verbose);
    try {
        await ensureImage(
            {
                image: base,
                build: build && { dockerfile: build.dockerfile, context: build.context },
            },
            { force: opts.rebuild, progress: { onProgress: baseOutput.line } },
        );
    } finally {
        baseOutput.done();
    }
    const inspected = await podman(['image', 'inspect', '--format', '{{json .}}', base]);
    const image = JSON.parse(inspected) as { Id: string; Config?: { Env?: string[] } };

    // 2. The context: zen packed (unless prebuilt), the libraries, the image's environment.
    const runtime = await prebuiltRuntime();
    const ctx = join(home(), 'images', `ctx-${randomBytes(4).toString('hex')}`);
    mkdirSync(ctx, { recursive: true });
    try {
        if (!runtime) {
            mkdirSync(join(ctx, 'pkgs'));
            const tarballs: Record<string, string> = {};
            for (const name of PACKAGES) {
                tarballs[`@zenera/${name}`] = await pack(packageDir(name), join(ctx, 'pkgs'));
            }
            writeFileSync(join(ctx, 'app.json'), JSON.stringify(appManifest(tarballs), null, 2));
        }
        writeRuntime(join(ctx, 'runtime'));
        mkdirSync(join(ctx, 'etc'), { recursive: true });
        writeFileSync(join(ctx, 'etc', 'image-env.json'), JSON.stringify(envOf(image.Config?.Env)));
        const identity: Record<string, string> = build
            ? { ZEN_IMAGE_BUILD: build.hash }
            : { ZEN_IMAGE_BASE: base };
        const dockerfile = agentDockerfile(base, identity, runtime?.image);
        writeFileSync(join(ctx, 'Dockerfile'), dockerfile);

        // 3. Named by everything that went in, so an unchanged one is not built again.
        const tag = `${IMAGE_REPO}:${contentHash(ctx, runtime ? `${image.Id}\0${runtime.id}` : image.Id)}`;
        const present = await runProcess('podman', ['image', 'exists', tag], { timeoutMs: 30_000 });
        if (present.code === 0 && !opts.rebuild) {
            return { tag, base, built: false };
        }
        note();
        note(`  ${bold(cyan('Building agent image'))}`);
        for (const line of table([
            ['Image', tag],
            ['Base', base],
            ['Runtime', runtime?.image ?? 'built here'],
        ]))
            note(`  ${dim(line)}`);
        await streamAgentBuild(
            'podman',
            ['build', '-t', tag, '-f', join(ctx, 'Dockerfile'), ctx],
            opts.verbose,
        );
        note(`  ${green('✓ Agent image built')}`);
        return { tag, base, built: true };
    } finally {
        rmSync(ctx, { recursive: true, force: true });
    }
}

export interface ContainerRun {
    image: string;
    project: { dir: string; id: string };
    /** where users' things are kept on this machine: /state inside */
    root: string;
    /** a seed outside the project, mounted read-only */
    memorySeed?: string | null;
    listen: { port: number; host: string };
    debug: boolean;
    /** Host-side UI links are printed only after podman has started the container. */
    onStarted?: () => void;
    auth:
        { mode: 'jwt'; publicKey: string; issuer: string; audience: string } | { mode: 'insecure' };
}

/**
 * Runs the agent image in podman and stays with it: its log here, its port published on this
 * machine, a Ctrl-C or SIGTERM passed on so its runs save before it goes.
 */
export async function runContainer(run: ContainerRun): Promise<void> {
    mkdirSync(run.root, { recursive: true, mode: 0o700 });
    const rootless = (await podman(['info', '--format', '{{.Host.Security.Rootless}}'])).trim();
    if (rootless !== 'true' && rootless !== 'false') {
        throw new CliError(
            `could not determine whether podman is rootless: ${rootless}`,
            EXIT.sandbox,
        );
    }
    const seed = await prepareMemorySeed(run.project.dir, run.root, run.memorySeed);
    let containerId: string | undefined;
    let stopResult: ReturnType<typeof runProcess> | undefined;
    const secretNames: string[] = [];
    try {
        const name = `zen-server-${run.project.id.replace(/[^\w.-]/g, '_')}-${run.listen.port}`;
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ZEN_PROJECT_ID: run.project.id,
            [HOST_MANAGED_ENV]: '1',
        };
        const args = [
            'run',
            '--rm',
            '--detach',
            '--name',
            name,
            '--label',
            'zenera.server=1',
            '--user',
            `${AGENT_UID}:${AGENT_GID}`,
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            ...(rootless === 'true'
                ? ['--userns', `keep-id:uid=${AGENT_UID},gid=${AGENT_GID}`]
                : []),
            '--publish',
            `${run.listen.host}:${run.listen.port}:3000`,
            '--volume',
            `${run.project.dir}:/project:ro`,
            '--volume',
            `${run.root}:/state`,
            // Values by name only: podman reads them from its own environment, so no key is on a
            // command line.
            '--env',
            'ZEN_PROJECT_ID',
            '--env',
            HOST_MANAGED_ENV,
        ];
        const inner = [
            'server',
            'start',
            '--host',
            '0.0.0.0',
            '--port',
            '3000',
            '--root',
            '/state',
        ];
        if (seed) {
            args.push('--volume', `${seed.dir}:/seed:ro`);
            inner.push('--memory-seed', '/seed');
        } else {
            inner.push('--no-memory-seed');
        }
        if (run.debug) inner.push('--debug');
        if (run.auth.mode === 'insecure') {
            env.ZEN_SERVER_INSECURE_LOCAL = '1';
            args.push('--env', 'ZEN_SERVER_INSECURE_LOCAL');
            inner.push('--insecure');
        } else {
            env.ZEN_SERVER_JWT_PUBLIC_KEY = run.auth.publicKey;
            args.push('--env', 'ZEN_SERVER_JWT_PUBLIC_KEY');
            inner.push('--jwt-issuer', run.auth.issuer, '--jwt-audience', run.auth.audience);
        }
        const modelCredentials = await modelKeys(run.project.dir);
        for (const name of MODEL_CONTEXT_ENV) {
            const value = process.env[name];
            if (value) {
                env[name] = value;
                args.push('--env', name);
            }
        }
        for (const forwarded of modelCredentials) {
            if (forwarded.holds === 'secret') {
                env[forwarded.env] = forwarded.value;
                args.push('--env', forwarded.env);
            } else {
                const name = `zen-server-${randomBytes(8).toString('hex')}-${forwarded.env.toLowerCase()}`;
                const made = await runProcess(
                    'podman',
                    ['secret', 'create', name, forwarded.value],
                    {
                        timeoutMs: 30_000,
                    },
                );
                if (made.code !== 0) {
                    throw new CliError(
                        `could not prepare ${forwarded.env}: ${made.stderr.trim() || made.stdout.trim()}`,
                        EXIT.credentials,
                        'the host must be able to read the credential file',
                    );
                }
                secretNames.push(name);
                env[forwarded.env] = `/run/secrets/${name}`;
                args.push(
                    '--secret',
                    `${name},type=mount,uid=${AGENT_UID},gid=${AGENT_GID},mode=0400`,
                    '--env',
                    forwarded.env,
                );
            }
        }
        args.push(run.image, ...inner);

        const started = await runProcess('podman', args, { timeoutMs: 120_000, env });
        if (started.code !== 0) {
            throw new CliError(
                `could not start the agent container: ${(started.stderr.trim() || started.stdout.trim()).split('\n')[0]}`,
                EXIT.sandbox,
            );
        }
        const id = started.stdout.trim();
        containerId = id;
        const logs = spawn('podman', ['logs', '--follow', name], {
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        run.onStarted?.();
        let stopping = false;
        const stop = async (signal: string) => {
            if (stopping) return;
            stopping = true;
            note();
            note(`  ${yellow('Stopping agent container')} ${dim(`(${signal})`)}`);
            stopResult = runProcess('podman', ['stop', '--ignore', '--time', '25', id], {
                timeoutMs: 60_000,
            });
            const stopped = await stopResult;
            if (stopped.code !== 0) {
                note(
                    `could not stop the agent container: ${stopped.stderr.trim() || stopped.stdout.trim()}`,
                );
            }
        };
        const interrupt = () => void stop('SIGINT');
        const terminate = () => void stop('SIGTERM');
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', terminate);
        await new Promise<void>((done, reject) => {
            logs.once('close', () => done());
            logs.once('error', reject);
        }).finally(() => {
            process.removeListener('SIGINT', interrupt);
            process.removeListener('SIGTERM', terminate);
        });
        if (!stopping) {
            throw new CliError('the agent container stopped', EXIT.failed, `podman logs ${name}`);
        }
    } finally {
        if (containerId) {
            const stopped = await (stopResult ??
                runProcess('podman', ['stop', '--ignore', '--time', '25', containerId], {
                    timeoutMs: 60_000,
                }));
            if (stopped.code !== 0) {
                throw new CliError(
                    `could not stop the agent container: ${stopped.stderr.trim() || stopped.stdout.trim()}`,
                    EXIT.failed,
                    'the startup memory snapshot and runtime credentials were retained until the container can be stopped',
                );
            }
        }
        try {
            const failures: string[] = [];
            for (const name of secretNames) {
                const removed = await runProcess('podman', ['secret', 'rm', name], {
                    timeoutMs: 30_000,
                });
                if (removed.code !== 0) {
                    failures.push(`${name}: ${removed.stderr.trim() || removed.stdout.trim()}`);
                }
            }
            if (failures.length) {
                throw new CliError(
                    `could not remove runtime credentials: ${failures.join('; ')}`,
                    EXIT.failed,
                    'remove the reported secrets after the container stops: podman secret rm <name>',
                );
            }
        } finally {
            await seed?.cleanup();
        }
    }
    note(`  ${green('✓ Server stopped')}`);
    note();
}

/** The model keys this machine has, from the keyring and the environment, as a run reads them. */
async function modelKeys(projectDir: string): Promise<ReturnType<typeof credentials>> {
    loadProjectEnv(projectDir);
    const keys = await KeyStore.open();
    keys.materialize();
    const found = credentials();
    const adc = !process.env.GOOGLE_APPLICATION_CREDENTIALS ? gcloudAdc() : undefined;
    if (adc) found.push({ env: 'GOOGLE_APPLICATION_CREDENTIALS', holds: 'file', value: adc });
    return found;
}

const require = createRequire(import.meta.url);

/** Where an @zenera package this CLI runs is installed: the workspace, or node_modules. */
function packageDir(name: (typeof PACKAGES)[number]): string {
    if (name === 'cli') {
        return dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
    }
    // Its entry, not its manifest: not every package exports ./package.json.
    let dir = dirname(require.resolve(`@zenera/${name}`));
    while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) {
        dir = dirname(dir);
    }
    return dir;
}

async function pack(dir: string, into: string): Promise<string> {
    const res = await runProcess(
        'npm',
        ['pack', dir, '--pack-destination', into, '--ignore-scripts', '--silent'],
        { timeoutMs: 300_000 },
    );
    const file = res.stdout.trim().split('\n').at(-1);
    if (res.code !== 0 || !file) {
        throw new CliError(
            `could not pack ${dir}: ${(res.stderr.trim() || `exit ${res.code}`).split('\n').at(-1)}`,
            EXIT.failed,
        );
    }
    return file;
}

/**
 * The runtime's own package.json: the CLI from its tarball, and every @zenera package it needs
 * forced to its tarball too — else npm would fetch the released ones and run other code.
 */
function appManifest(tarballs: Record<string, string>): unknown {
    const file = (name: string) => `file:/opt/zenera/pkgs/${tarballs[name]}`;
    return {
        name: 'zenera-runtime',
        private: true,
        dependencies: { '@zenera/cli': file('@zenera/cli') },
        overrides: Object.fromEntries(Object.keys(tarballs).map((name) => [name, file(name)])),
    };
}

/** `NAME=value` lines as an object; the commands' starting environment. */
function envOf(lines: readonly string[] = []): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of lines) {
        const at = line.indexOf('=');
        if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
    }
    return env;
}

// Static bwrap, compiled; shared by the agent image (built here) and the prebuilt runtime.
const BWRAP_STAGE = `FROM docker.io/library/alpine:3.22 AS bwrap
ARG BWRAP_VERSION=${BWRAP_VERSION}
RUN apk add --no-cache build-base meson ninja pkgconf libcap-dev libcap-static linux-headers curl xz
RUN mkdir -p /src && curl -fsSL https://github.com/containers/bubblewrap/releases/download/v\${BWRAP_VERSION}/bubblewrap-\${BWRAP_VERSION}.tar.xz \\
    | tar -xJ -C /src --strip-components=1
RUN cd /src && meson setup build --buildtype=release --prefer-static --default-library=static \\
        -Dc_link_args=-static -Dselinux=disabled -Dman=disabled -Dtests=false \\
        -Dbash_completion=disabled -Dzsh_completion=disabled \\
 && ninja -C build bwrap && strip build/bwrap`;

/**
 * The agent image's Dockerfile. `runtime`: a prebuilt runtime image to copy /opt/zenera from
 * (node, the @zenera packages, bwrap); without it they are installed and compiled here.
 */
export function agentDockerfile(
    base: string,
    identity: Record<string, string>,
    runtime?: string,
): string {
    const parts = runtime
        ? [`FROM ${base}`, 'USER root', `COPY --from=${runtime} /opt/zenera /opt/zenera`]
        : [
              `FROM docker.io/library/node:24-trixie-slim AS runtime
COPY pkgs/ /opt/zenera/pkgs/
COPY app.json /opt/zenera/app/package.json
RUN cd /opt/zenera/app \\
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \\
 && mkdir -p /opt/zenera/bin \\
 && cp "$(command -v node)" /opt/zenera/bin/node \\
 && rm -rf /opt/zenera/pkgs \\
 && /opt/zenera/bin/node ${ENTRY} version
`,
              `${BWRAP_STAGE}\n`,
              `FROM ${base}`,
              'USER root',
              'COPY --from=runtime /opt/zenera /opt/zenera',
              'COPY --from=bwrap /src/build/bwrap /opt/zenera/bin/bwrap',
          ];
    return `# Generated by zen server start --container. The project's environment, plus zen.
${parts.join('\n')}
COPY runtime/ /opt/zenera/runtime/
COPY etc/ /opt/zenera/etc/
# Mount points: the image's root is read-only to every command. Node needs glibc: a base
# without it fails here, not when the server starts.
RUN mkdir -p /project /state /workspace /home/agent /home/zenera \\
 && chown ${AGENT_UID}:${AGENT_GID} /state /workspace /home/agent /home/zenera \\
 && /opt/zenera/bin/node -e "process.exit(0)"
ENV HOME=/home/zenera
USER ${AGENT_UID}:${AGENT_GID}
ENV ${Object.entries(identity)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')}
LABEL zenera.agent=1
ENTRYPOINT ["/opt/zenera/bin/node", "${ENTRY}"]
CMD ["server", "start"]
`;
}

/**
 * The prebuilt runtime image of a release (packages/cli/agent-runtime.Dockerfile is this, kept
 * in step by a test): /opt/zenera with node, @zenera/cli@ZEN_VERSION and every @zenera package
 * pinned to that version, and bwrap. CI builds it for amd64 and arm64 and pushes it to
 * AGENT_RUNTIME_REPO:<version> (RELEASE.md).
 */
export function agentRuntimeDockerfile(): string {
    const pins = PACKAGES.filter((name) => name !== 'cli')
        .map((name) => `"overrides.@zenera/${name}=$ZEN_VERSION"`)
        .join(' ');
    return `# Generated from agentRuntimeDockerfile() in src/container.ts - edit that, then run
# \`npm run agent-runtime:dockerfile -w packages/cli\`. zen's prebuilt agent runtime: what every
# agent image copies into /opt/zenera. Build with --build-arg ZEN_VERSION=<a published version>.
FROM docker.io/library/node:24-trixie-slim AS runtime
ARG ZEN_VERSION
RUN test -n "$ZEN_VERSION" \\
 && mkdir -p /opt/zenera/app /opt/zenera/bin && cd /opt/zenera/app \\
 && printf '{"name":"zenera-runtime","private":true}\\n' > package.json \\
 && npm pkg set "dependencies.@zenera/cli=$ZEN_VERSION" ${pins} \\
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \\
 && cp "$(command -v node)" /opt/zenera/bin/node \\
 && test "$(/opt/zenera/bin/node ${ENTRY} --version)" = "$ZEN_VERSION"

${BWRAP_STAGE}

FROM scratch
ARG ZEN_VERSION
COPY --from=runtime /opt/zenera /opt/zenera
COPY --from=bwrap /src/build/bwrap /opt/zenera/bin/bwrap
LABEL zenera.agent-runtime=1 zenera.version=$ZEN_VERSION \\
      org.opencontainers.image.source=https://github.com/zenera-ai/ZeneraNeo
`;
}

/** This CLI's version, and whether every @zenera package it runs came from npm. */
function cliRelease(): { version: string; installed: boolean } {
    const manifest = JSON.parse(readFileSync(join(packageDir('cli'), 'package.json'), 'utf8')) as {
        version: string;
    };
    const installed = PACKAGES.every((name) =>
        packageDir(name).split(/[\\/]/).includes('node_modules'),
    );
    return { version: manifest.version, installed };
}

/**
 * The runtime image to copy from, or null to build the runtime here. ZEN_AGENT_RUNTIME=local
 * always builds here; ZEN_AGENT_RUNTIME_IMAGE names another image (a mirror); otherwise a
 * released CLI uses its release's image, and a dev checkout builds its own code here.
 */
export function agentRuntimeRef(
    release: { version: string; installed: boolean },
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    if (env.ZEN_AGENT_RUNTIME?.trim() === 'local') return null;
    const override = env.ZEN_AGENT_RUNTIME_IMAGE?.trim();
    if (override) return override;
    return release.installed ? `${AGENT_RUNTIME_REPO}:${release.version}` : null;
}

/**
 * The prebuilt runtime, pulled unless present, with its image id; null (with a note) to build it
 * here: none for this CLI, unreachable, or not the version this CLI is.
 */
async function prebuiltRuntime(): Promise<{ image: string; id: string } | null> {
    const release = cliRelease();
    const image = agentRuntimeRef(release);
    if (!image) return null;
    const fallback = (why: string) => {
        note(`  ${yellow('!')} ${dim(`prebuilt runtime ${image}: ${why}; building it here`)}`);
        return null;
    };
    const present = await runProcess('podman', ['image', 'exists', image], { timeoutMs: 30_000 });
    if (present.code !== 0) {
        note(`  ${dim(`Pulling ${image}…`)}`);
        const pulled = await runProcess('podman', ['pull', '--quiet', image], {
            timeoutMs: 15 * 60_000,
            maxBytes: 1024 * 1024,
        });
        if (pulled.code !== 0) {
            return fallback((pulled.stderr.trim() || `exit ${pulled.code}`).split('\n').at(-1)!);
        }
    }
    const inspected = await runProcess(
        'podman',
        ['image', 'inspect', '--format', '{{.Id}} {{index .Labels "zenera.version"}}', image],
        { timeoutMs: 60_000 },
    );
    const [id, version] = inspected.stdout.trim().split(' ');
    if (inspected.code !== 0 || !id) return fallback('cannot inspect it');
    // A mirror named by ZEN_AGENT_RUNTIME_IMAGE must still be this CLI's runtime.
    if (version !== release.version) {
        return fallback(`it holds zen ${version || '(unlabelled)'}, this is ${release.version}`);
    }
    return { image, id };
}

/** Everything that went into the image: the base's id and the context, file by file. */
export function contentHash(ctx: string, baseId: string): string {
    const hash = createHash('sha256').update(baseId);
    const walk = (rel: string): void => {
        for (const entry of readdirSync(join(ctx, rel), { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const path = join(rel, entry.name);
            if (entry.isDirectory()) walk(path);
            else hash.update(`\0${path}\0`).update(readFileSync(join(ctx, path)));
        }
    };
    walk('');
    return hash.digest('hex').slice(0, 12);
}

async function podman(args: readonly string[]): Promise<string> {
    const res = await runProcess('podman', args, { timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 });
    if (res.code !== 0) {
        throw new CliError(
            `podman ${args[0]} ${args[1] ?? ''}: ${(res.stderr.trim() || `exit ${res.code}`).split('\n')[0]}`,
            EXIT.sandbox,
        );
    }
    return res.stdout;
}
