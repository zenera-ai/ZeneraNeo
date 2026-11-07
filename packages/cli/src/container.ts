import { home, KeyStore, credentials, resolveBuild, writeRuntime } from '@zenera/engine';
import { DEFAULT_SANDBOX_IMAGE, readProjectConfig } from '@zenera/neo';
import { runProcess } from '@zenera/sandbox';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asCliError, ensureImage, ensurePodmanReady } from './podman.ts';
import { CliError, dim, EXIT, note } from './term.ts';

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
// ---------------------------------------------------------------------------

/** The packages the server needs, in an order npm can install from files. */
const PACKAGES = ['sandbox', 'neo', 'view', 'engine', 'server', 'cli'] as const;

const BWRAP_VERSION = '0.13.1';
const IMAGE_REPO = 'localhost/zenera-agent';

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
    opts: { rebuild?: boolean } = {},
): Promise<AgentImage> {
    await ensurePodmanReady({ yes: true }).catch((err: unknown) => {
        throw asCliError(err);
    });

    // 1. The project's environment, as `zen run` has it.
    const { root, config } = readProjectConfig(projectDir);
    const build = resolveBuild(root, config.sandbox);
    const base = build?.tag ?? config.sandbox?.image ?? DEFAULT_SANDBOX_IMAGE;
    await ensureImage(
        { image: base, build: build && { dockerfile: build.dockerfile, context: build.context } },
        { force: opts.rebuild },
    );
    const inspected = await podman(['image', 'inspect', '--format', '{{json .}}', base]);
    const image = JSON.parse(inspected) as { Id: string; Config?: { Env?: string[] } };

    // 2. The context: zen packed, the libraries, the image's environment, the Dockerfile.
    const ctx = join(home(), 'images', `ctx-${randomBytes(4).toString('hex')}`);
    mkdirSync(join(ctx, 'pkgs'), { recursive: true });
    try {
        const tarballs: Record<string, string> = {};
        for (const name of PACKAGES) {
            tarballs[`@zenera/${name}`] = await pack(packageDir(name), join(ctx, 'pkgs'));
        }
        writeRuntime(join(ctx, 'runtime'));
        mkdirSync(join(ctx, 'etc'), { recursive: true });
        writeFileSync(join(ctx, 'etc', 'image-env.json'), JSON.stringify(envOf(image.Config?.Env)));
        writeFileSync(join(ctx, 'app.json'), JSON.stringify(appManifest(tarballs), null, 2));
        const identity: Record<string, string> = build
            ? { ZEN_IMAGE_BUILD: build.hash }
            : { ZEN_IMAGE_BASE: base };
        const dockerfile = agentDockerfile(base, identity);
        writeFileSync(join(ctx, 'Dockerfile'), dockerfile);

        // 3. Named by everything that went in, so an unchanged one is not built again.
        const tag = `${IMAGE_REPO}:${contentHash(ctx, image.Id)}`;
        const present = await runProcess('podman', ['image', 'exists', tag], { timeoutMs: 30_000 });
        if (present.code === 0 && !opts.rebuild) {
            return { tag, base, built: false };
        }
        note(dim(`building the agent image ${tag} on ${base}`));
        await streamed('podman', ['build', '-t', tag, '-f', join(ctx, 'Dockerfile'), ctx]);
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
    auth:
        { mode: 'jwt'; publicKey: string; issuer: string; audience: string } | { mode: 'insecure' };
}

/**
 * Runs the agent image in podman and stays with it: its log here, its port published on this
 * machine, a Ctrl-C or SIGTERM passed on so its runs save before it goes.
 */
export async function runContainer(run: ContainerRun): Promise<void> {
    mkdirSync(run.root, { recursive: true, mode: 0o700 });
    const name = `zen-server-${run.project.id.replace(/[^\w.-]/g, '_')}-${run.listen.port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, ZEN_PROJECT_ID: run.project.id };
    const args = [
        'run',
        '--rm',
        '--detach',
        '--name',
        name,
        '--label',
        'zenera.server=1',
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
    ];
    const inner = ['server', 'start', '--host', '0.0.0.0', '--port', '3000', '--root', '/state'];
    if (run.memorySeed === null) {
        inner.push('--no-memory-seed');
    } else if (run.memorySeed) {
        args.push('--volume', `${run.memorySeed}:/seed:ro`);
        inner.push('--memory-seed', '/seed');
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
    const skipped: string[] = [];
    for (const forwarded of await modelKeys()) {
        if (forwarded.holds === 'secret') {
            env[forwarded.env] = forwarded.value;
            args.push('--env', forwarded.env);
        } else {
            // A credential file (gcloud's ADC) would be bound into the container and again into
            // each command, which SELinux refuses for a file podman mounted: values only, for now.
            skipped.push(forwarded.env);
        }
    }
    if (skipped.length) {
        note(dim(`not passed into the container (credential files): ${skipped.join(', ')}`));
    }
    args.push(run.image, ...inner);

    const started = await runProcess('podman', args, { timeoutMs: 120_000, env });
    if (started.code !== 0) {
        throw new CliError(
            `could not start the agent container: ${(started.stderr.trim() || started.stdout.trim()).split('\n')[0]}`,
            EXIT.sandbox,
        );
    }
    const logs = spawn('podman', ['logs', '--follow', name], {
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    let stopping = false;
    const stop = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        note(`${signal}: stopping the agent container`);
        await runProcess('podman', ['stop', '--time', '25', name], { timeoutMs: 60_000 });
    };
    process.once('SIGINT', () => void stop('SIGINT'));
    process.once('SIGTERM', () => void stop('SIGTERM'));
    await new Promise<void>((done) => logs.once('close', () => done()));
    if (!stopping) {
        throw new CliError('the agent container stopped', EXIT.failed, `podman logs ${name}`);
    }
}

/** The model keys this machine has, from the keyring and the environment, as a run reads them. */
async function modelKeys(): Promise<ReturnType<typeof credentials>> {
    const keys = await KeyStore.open();
    keys.materialize();
    return credentials();
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

export function agentDockerfile(base: string, identity: Record<string, string>): string {
    const entry = '/opt/zenera/app/node_modules/@zenera/cli/dist/main.js';
    return `# Generated by zen server start --container. The project's environment, plus zen.
FROM docker.io/library/node:24-trixie-slim AS runtime
COPY pkgs/ /opt/zenera/pkgs/
COPY app.json /opt/zenera/app/package.json
RUN cd /opt/zenera/app \\
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \\
 && mkdir -p /opt/zenera/bin \\
 && cp "$(command -v node)" /opt/zenera/bin/node \\
 && rm -rf /opt/zenera/pkgs \\
 && /opt/zenera/bin/node ${entry} version

FROM docker.io/library/alpine:3.22 AS bwrap
ARG BWRAP_VERSION=${BWRAP_VERSION}
RUN apk add --no-cache build-base meson ninja pkgconf libcap-dev libcap-static linux-headers curl xz
RUN mkdir -p /src && curl -fsSL https://github.com/containers/bubblewrap/releases/download/v\${BWRAP_VERSION}/bubblewrap-\${BWRAP_VERSION}.tar.xz \\
    | tar -xJ -C /src --strip-components=1
RUN cd /src && meson setup build --buildtype=release --prefer-static --default-library=static \\
        -Dc_link_args=-static -Dselinux=disabled -Dman=disabled -Dtests=false \\
        -Dbash_completion=disabled -Dzsh_completion=disabled \\
 && ninja -C build bwrap && strip build/bwrap

FROM ${base}
USER root
COPY --from=runtime /opt/zenera /opt/zenera
COPY --from=bwrap /src/build/bwrap /opt/zenera/bin/bwrap
COPY runtime/ /opt/zenera/runtime/
COPY etc/ /opt/zenera/etc/
# Mount points: the image's root is read-only to every command. Node needs glibc: a base
# without it fails here, not when the server starts.
RUN mkdir -p /project /state /workspace /home/agent && /opt/zenera/bin/node -e "process.exit(0)"
ENV ${Object.entries(identity)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')}
LABEL zenera.agent=1
ENTRYPOINT ["/opt/zenera/bin/node", "${entry}"]
CMD ["server", "start"]
`;
}

/** Everything that went into the image: the base's id and the context, file by file. */
function contentHash(ctx: string, baseId: string): string {
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

/** A long podman step whose own output is the progress: dimmed, on stderr. */
function streamed(bin: string, args: readonly string[]): Promise<void> {
    return new Promise((done, fail) => {
        const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        const tail: string[] = [];
        const show = (chunk: Buffer) => {
            for (const line of chunk.toString().split('\n')) {
                if (!line.trim()) continue;
                tail.push(line);
                if (tail.length > 20) tail.shift();
                note(dim(`  ${line}`));
            }
        };
        child.stdout.on('data', show);
        child.stderr.on('data', show);
        child.once('error', fail);
        child.once('close', (code) =>
            code === 0
                ? done()
                : fail(
                      new CliError(
                          `the agent image did not build (exit ${code})`,
                          EXIT.sandbox,
                          tail.slice(-3).join('\n'),
                      ),
                  ),
        );
    });
}
