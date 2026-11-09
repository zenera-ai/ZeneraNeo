/**
 * Release images for `zen server build`: the agent image plus the project and its memory seed,
 * immutable, for Kubernetes. buildReleaseImage builds the agent image (container.ts), stages a
 * context (snapshotProject, the seed from seed.ts, --add trees via copyTree), generates
 * releaseDockerfile, builds `localhost/zenera-release:<hash>` and optionally pushes it
 * (pushImage) to report its digest. parseAdd and checkRelease validate the command's flags.
 * Used by commands/server.ts; deploy-time settings (plugins, keys, URLs) are never baked in.
 */
import { home } from '@zenera/engine';
import { memoryDir, readProjectConfig } from '@zenera/neo';
import { runProcess } from '@zenera/sandbox';
import { randomBytes } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { collect } from './archive.ts';
import {
    AGENT_GID,
    AGENT_UID,
    type AgentImage,
    buildAgentImage,
    contentHash,
} from './container.ts';
import { prepareMemorySeed } from './seed.ts';
import { streamAgentBuild } from './serverDisplay.ts';
import { bold, CliError, cyan, dim, EXIT, green, note, table, usageError } from './term.ts';

const IMAGE_REPO = 'localhost/zenera-release';
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Where the image keeps its own things: an --add must not land on (or over) any of them. */
export const RESERVED_DESTINATIONS = [
    '/project',
    '/seed',
    '/state',
    '/workspace',
    '/opt/zenera/app',
    '/opt/zenera/bin',
] as const;

export interface ReleaseAdd {
    /** absolute path on this machine */
    src: string;
    /** absolute path in the image */
    dest: string;
}

export interface ReleaseOptions {
    release?: string;
    /** `--memory-seed` (a dir), `--no-memory-seed` (null), or the project's own (undefined) */
    memorySeed?: string | null;
    adds?: readonly ReleaseAdd[];
    push?: { ref: string; authfile?: string; insecure?: boolean };
    projectId?: string;
    rebuild?: boolean;
    verbose?: boolean;
}

export interface ReleaseImage {
    release: string;
    /** the release image, tagged locally */
    image: string;
    agentImage: string;
    base: string;
    built: boolean;
    ref?: string;
    digest?: string;
}

/** `<src>:<dest>`: src resolved against cwd and present, dest an absolute path of its own. */
export function parseAdd(spec: string, cwd: string): ReleaseAdd {
    const at = spec.lastIndexOf(':');
    const usage = '--add <src>:<dest>, e.g. --add ./plugins:/opt/zenera/plugins';
    if (at <= 0 || at === spec.length - 1) {
        throw usageError(`not <src>:<dest>: ${spec}`, usage);
    }
    const src = resolve(cwd, spec.slice(0, at));
    const raw = spec.slice(at + 1);
    if (!raw.startsWith('/')) {
        throw usageError(`--add destination must be absolute: ${raw}`, usage);
    }
    if (/\s/.test(raw)) {
        throw usageError(`--add destination must not contain whitespace: ${raw}`, usage);
    }
    if (raw.split('/').includes('..')) {
        throw usageError(`--add destination must not contain '..': ${raw}`, usage);
    }
    const dest = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    if (posix.normalize(dest) !== dest) {
        throw usageError(`--add destination is not normalized: ${raw}`, usage);
    }
    // On a reserved path, under one, or over one (`/opt/zenera` would replace its app).
    const clash = RESERVED_DESTINATIONS.find(
        (r) =>
            dest === r || dest.startsWith(`${r}/`) || r.startsWith(dest === '/' ? '/' : `${dest}/`),
    );
    if (clash) {
        throw usageError(
            `--add destination ${dest} would overlay ${clash}`,
            `the image keeps ${RESERVED_DESTINATIONS.join(', ')} for itself`,
        );
    }
    if (!existsSync(src)) {
        throw usageError(`--add source does not exist: ${src}`, usage);
    }
    return { src, dest };
}

/** A release id as given, checked; the default comes from the content (`r-<hash>`). */
export function checkRelease(id: string): string {
    if (!RELEASE_ID.test(id)) {
        throw usageError(
            `not a release id: ${id}`,
            'letters, digits, ".", "_" and "-", starting with a letter or digit, at most 64',
        );
    }
    return id;
}

/** Image-readable modes: dirs 0755, files 0644, or 0755 when the source is executable. */
export function releaseMode(mode: number, isDir: boolean): number {
    return isDir || mode & 0o111 ? 0o755 : 0o644;
}

async function copyOne(src: string, dest: string, mode: number): Promise<void> {
    await mkdir(dirname(dest), { recursive: true });
    // A clone where the filesystem has them; a plain copy where it does not.
    await copyFile(src, dest, constants.COPYFILE_FICLONE);
    await chmod(dest, releaseMode(mode, false));
}

/** Directories in `into` made 0755 all the way down (mkdir's modes honour the umask). */
async function openDirs(into: string): Promise<void> {
    await chmod(into, 0o755);
    for (const entry of await readdir(into, { withFileTypes: true })) {
        if (entry.isDirectory()) await openDirs(join(into, entry.name));
    }
}

/**
 * The project as the image carries it: what `zen export` would (no `.env`, sessions, `.git`,
 * `node_modules`, scratch, locks, links), minus its memory, which travels as the seed.
 */
export async function snapshotProject(projectDir: string, into: string): Promise<number> {
    const dir = resolve(projectDir);
    const { root, config } = readProjectConfig(dir);
    const memory = memoryDir(root, config);
    const memoryRel =
        memory && !relative(dir, memory).startsWith('..') && !isAbsolute(relative(dir, memory))
            ? relative(dir, memory).split(sep).join('/')
            : undefined;
    await mkdir(into, { recursive: true });
    let count = 0;
    for (const file of collect(dir, { memory: false }).files) {
        if (memoryRel && (file.rel === memoryRel || file.rel.startsWith(`${memoryRel}/`))) continue;
        await copyOne(file.abs, join(into, ...file.rel.split('/')), file.mode);
        count++;
    }
    await openDirs(into);
    return count;
}

/** A file or a tree, copied with image-readable modes; links are not followed. */
export async function copyTree(src: string, into: string): Promise<void> {
    const stat = await lstat(src);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
        await mkdir(into, { recursive: true });
        await chmod(into, 0o755);
        for (const entry of await readdir(src)) {
            await copyTree(join(src, entry), join(into, entry));
        }
    } else if (stat.isFile()) {
        await copyOne(src, into, stat.mode);
    }
}

export function releaseDockerfile(
    agentTag: string,
    opts: {
        release: string;
        projectId: string;
        seed: boolean;
        adds: readonly { ctxPath: string; dest: string }[];
    },
): string {
    const lines = [
        '# Generated by zen server build. A release: the agent image plus the project.',
        `FROM ${agentTag}`,
        'USER root',
        'COPY project/ /project/',
        ...(opts.seed ? ['COPY seed/ /seed/'] : []),
        ...opts.adds.map((a) => `COPY ${a.ctxPath} ${a.dest}`),
        `USER ${AGENT_UID}:${AGENT_GID}`,
        `ENV ZEN_RELEASE=${JSON.stringify(opts.release)} ZEN_PROJECT_ID=${JSON.stringify(opts.projectId)}`,
        `LABEL zenera.release=${JSON.stringify(opts.release)} zenera.project=${JSON.stringify(opts.projectId)}`,
    ];
    return `${lines.join('\n')}\n`;
}

/** The arguments of `podman push`, the reference as podman wants it. */
export function pushArgs(
    tag: string,
    push: { ref: string; authfile?: string; insecure?: boolean },
    digestFile: string,
): string[] {
    const ref = push.ref.replace(/^docker:\/\//, '');
    return [
        'push',
        '--digestfile',
        digestFile,
        ...(push.authfile ? ['--authfile', push.authfile] : []),
        ...(push.insecure ? ['--tls-verify=false'] : []),
        tag,
        `docker://${ref}`,
    ];
}

/** Pushes the image and returns its manifest digest (`sha256:…`). */
export async function pushImage(
    tag: string,
    push: { ref: string; authfile?: string; insecure?: boolean },
    digestFile: string,
): Promise<string> {
    const res = await runProcess('podman', pushArgs(tag, push, digestFile), {
        timeoutMs: 60 * 60_000,
        maxBytes: 1024 * 1024,
    });
    if (res.code !== 0) {
        // podman prints progress first; the reason is its `Error:` line.
        const lines = (res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`).split('\n');
        const first = (lines.find((l) => /^Error\b/i.test(l.trim())) ?? lines[0]!).trim();
        throw new CliError(
            `could not push ${tag} to ${push.ref}: ${first}`,
            EXIT.failed,
            'log in first (podman login <registry>), or give --authfile <file>; ' +
                'for a plain-HTTP registry, --insecure-registry',
        );
    }
    let digest = '';
    try {
        digest = readFileSync(digestFile, 'utf8').trim();
    } catch {
        // Checked below.
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
        throw new CliError(
            `pushed ${push.ref}, but podman reported no digest${digest ? `: ${digest}` : ''}`,
            EXIT.failed,
        );
    }
    return digest;
}

/** The release image for a project: the agent image built first, then the project on top. */
export async function buildReleaseImage(
    projectDir: string,
    opts: ReleaseOptions = {},
): Promise<ReleaseImage> {
    const agent = await buildAgentImage(projectDir, {
        rebuild: opts.rebuild,
        verbose: opts.verbose,
    });
    return buildRelease(projectDir, agent, opts);
}

/** The release step alone, on an agent image already built. */
export async function buildRelease(
    projectDir: string,
    agent: AgentImage,
    opts: ReleaseOptions = {},
): Promise<ReleaseImage> {
    const inspected = await runProcess(
        'podman',
        ['image', 'inspect', '--format', '{{.Id}}', agent.tag],
        {
            timeoutMs: 60_000,
        },
    );
    const agentId = inspected.stdout.trim();
    if (inspected.code !== 0 || !agentId) {
        throw new CliError(
            `cannot inspect the agent image ${agent.tag}: ${(inspected.stderr.trim() || `exit ${inspected.code}`).split('\n')[0]}`,
            EXIT.sandbox,
        );
    }
    const projectId = opts.projectId ?? basename(resolve(projectDir));
    const ctx = join(home(), 'images', `release-ctx-${randomBytes(4).toString('hex')}`);
    await mkdir(ctx, { recursive: true });
    try {
        await snapshotProject(projectDir, join(ctx, 'project'));
        const seed = await prepareMemorySeed(projectDir, ctx, opts.memorySeed);
        if (seed) await rename(seed.dir, join(ctx, 'seed'));
        const adds: { ctxPath: string; dest: string }[] = [];
        for (const [n, add] of (opts.adds ?? []).entries()) {
            const isDir = (await lstat(add.src)).isDirectory();
            const ctxPath = isDir ? `add/${n}/` : `add/${n}/file`;
            await mkdir(join(ctx, 'add', String(n)), { recursive: true });
            await copyTree(add.src, join(ctx, ...ctxPath.split('/').filter(Boolean)));
            adds.push({ ctxPath, dest: isDir ? `${add.dest}/` : add.dest });
        }
        if (existsSync(join(ctx, 'add'))) await openDirs(join(ctx, 'add'));

        // The default release is named by what it holds, so the same content is the same release.
        const release =
            opts.release ??
            `r-${contentHash(ctx, [agentId, ...adds.map((a) => `${a.ctxPath}>${a.dest}`)].join('\0'))}`;
        checkRelease(release);
        await writeFile(
            join(ctx, 'Dockerfile'),
            releaseDockerfile(agent.tag, { release, projectId, seed: Boolean(seed), adds }),
        );
        const image = `${IMAGE_REPO}:${contentHash(ctx, `${agentId}\0${release}`)}`;
        const present = await runProcess('podman', ['image', 'exists', image], {
            timeoutMs: 30_000,
        });
        const built = present.code !== 0 || Boolean(opts.rebuild);
        if (built) {
            note();
            note(`  ${bold(cyan('Building release image'))}`);
            for (const line of table([
                ['Release', release],
                ['Image', image],
                ['Agent', agent.tag],
            ]))
                note(`  ${dim(line)}`);
            await streamAgentBuild(
                'podman',
                ['build', '-t', image, '-f', join(ctx, 'Dockerfile'), ctx],
                opts.verbose,
            );
            note(`  ${green('✓ Release image built')}`);
        }
        const result: ReleaseImage = {
            release,
            image,
            agentImage: agent.tag,
            base: agent.base,
            built,
        };
        if (opts.push) {
            note(`  ${dim(`Pushing ${image} to ${opts.push.ref}…`)}`);
            result.ref = opts.push.ref.replace(/^docker:\/\//, '');
            result.digest = await pushImage(image, opts.push, join(ctx, 'digest'));
            note(`  ${green('✓ Pushed')} ${dim(result.digest)}`);
        }
        return result;
    } finally {
        await rm(ctx, { recursive: true, force: true });
    }
}
