import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SandboxError, type BuildSpec, type PrepareOptions } from './contract.ts';
import { runProcess, type ProcResult, type Runner } from './process.ts';

// ---------------------------------------------------------------------------
// The sandbox image
//
// `image:` names something to pull; `build:` names a Dockerfile to build. Both
// end as an image a sandbox runs, and getting it there is the sandbox's job:
// podman builds on this machine, a sandbox service builds wherever it builds.
// What they share is the *identity* of a build — which files go in and what
// they hash to — so a project names the same image on every backend.
//
// The tag is a function of what goes into the image, and it has to be: a
// container's name hashes its image, so a tag that stayed put while the
// Dockerfile changed would leave a `persist: true` container running last
// week's filesystem, with nothing anywhere saying so. Hashing the context as
// well as the Dockerfile means an edit to either yields a new tag, a new
// container name, and a build — which is the only honest answer.
// ---------------------------------------------------------------------------

/** Where locally built images are tagged. Not scoped: a `/` or an `@` is not a legal tag. */
export const LOCAL_IMAGE_REPO = 'localhost/zenera-sandbox';

/**
 * A build context is meant to be small — a Dockerfile and whatever it copies.
 * Hashing a directory someone pointed at their whole home folder would hang
 * before it was wrong, so it stops and says which key to narrow.
 */
export const MAX_CONTEXT_FILES = 2_000;

/** What a build is made of: the address every backend agrees on. */
export interface BuildIdentity {
    /** 12 hex characters; the tag a build is known by */
    hash: string;
    /** every file in the context, relative and sorted — exactly what was hashed */
    files: readonly string[];
}

/**
 * The content address of a build: the Dockerfile, then every file the build can
 * see, by path and by content, then its arguments.
 *
 * `.dockerignore` is not read. The engine honours it and this does not, so an
 * ignored file that changes yields a new tag and a build that produces the same
 * image — wasteful, never wrong, and the alternative is reimplementing a match
 * syntax whose disagreements would be silent.
 */
export function buildIdentity(spec: BuildSpec): BuildIdentity {
    const hash = createHash('sha256');
    hash.update(readFileSync(spec.dockerfile));
    const files = walk(spec.context);
    for (const rel of files) {
        // The separator is hashed as posix so the same tree tags the same on
        // any host.
        hash.update(`\0${rel.split(sep).join('/')}\0`);
        hash.update(readFileSync(join(spec.context, rel)));
    }
    // Only when there are any, so a build without arguments keeps the tag it
    // had before arguments existed.
    const args = Object.entries(spec.args ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (args.length > 0) {
        hash.update(`\0args\0${JSON.stringify(args)}`);
    }
    return { hash: hash.digest('hex').slice(0, 12), files };
}

/** The tag a build is run under on this machine. */
export function localImageTag(build: BuildSpec | BuildIdentity): string {
    const id = 'hash' in build ? build : buildIdentity(build);
    return `${LOCAL_IMAGE_REPO}:${id.hash}`;
}

/** Every file under `dir`, relative and sorted, so the digest is stable. */
function walk(dir: string): string[] {
    const found: string[] = [];
    const pending = [dir];
    while (pending.length > 0) {
        const at = pending.pop()!;
        for (const entry of readdirSync(at, { withFileTypes: true })) {
            const path = join(at, entry.name);
            if (entry.isDirectory()) {
                pending.push(path);
            } else if (entry.isFile()) {
                found.push(relative(dir, path));
            }
        }
        if (found.length > MAX_CONTEXT_FILES) {
            throw new SandboxError(
                `sandbox.build.context: ${dir} holds more than ${MAX_CONTEXT_FILES} files`,
                'point `context:` at the directory the build actually copies from',
            );
        }
    }
    return found.sort();
}

// ---------------------------------------------------------------------------
// On this machine
// ---------------------------------------------------------------------------

/**
 * A build that ran and failed, rather than an engine that could not be asked.
 * Both stop a run, but only one of them is the project's fault: `zen check`
 * reports a Dockerfile that does not build as an error, and a laptop without
 * podman as a warning.
 */
export class ImageBuildError extends SandboxError {
    constructor(message: string, hint?: string) {
        super(message, hint);
        this.name = 'ImageBuildError';
    }
}

/**
 * Whether `err` is a failed build, by name rather than by class: a plugin
 * that provides the sandbox may bring its own copy of this package, and its
 * `ImageBuildError` is then a different class that means the same thing.
 */
export function isImageBuildError(err: unknown): err is ImageBuildError {
    return err instanceof Error && err.name === 'ImageBuildError';
}

/** Pulling is slow on purpose... */
const PULL_MS = 600_000;
/** ...and a build from a cold cache is slower still. */
const BUILD_MS = 900_000;

/**
 * Images this process has already settled, per runner and per engine. A batch
 * opens the same project dozens of times at once, and without this each one
 * asks podman and the concurrent copies race each other to pull or build the
 * very same image. Keyed by runner too, so a test's fake engine never inherits
 * an answer the real one gave.
 */
const settled = new WeakMap<Runner, Map<string, Promise<void>>>();

/**
 * Puts the image on this machine's engine: nothing when it is already there,
 * a build when the spec names a Dockerfile, a pull otherwise.
 *
 * Skipping a present build is safe in a way it would not be for an ordinary
 * tag, because this one is a hash of the Dockerfile and its context: the image
 * existing *means* the content is unchanged. What it does not cover is a moved
 * base image — `podman build` reuses whatever `FROM node:24` resolved to last
 * time — which is what `force` is for.
 */
export function ensurePodmanImage(
    target: { image: string; build?: BuildSpec },
    host: { engine?: string; exec?: Runner } = {},
    opts: PrepareOptions = {},
): Promise<void> {
    const engine = host.engine ?? 'podman';
    const run = host.exec ?? runProcess;
    let byKey = settled.get(run);
    if (!byKey) {
        byKey = new Map();
        settled.set(run, byKey);
    }
    const key = `${engine}::${target.image}`;
    const pending = byKey.get(key);
    if (pending && !opts.force) {
        return pending;
    }
    const attempt = obtain(engine, run, target, opts).catch((err: unknown) => {
        // A failure is not a settled answer: the user may fix the Dockerfile
        // and try again in the same process.
        byKey.delete(key);
        throw err;
    });
    byKey.set(key, attempt);
    return attempt;
}

async function obtain(
    engine: string,
    run: Runner,
    target: { image: string; build?: BuildSpec },
    opts: PrepareOptions,
): Promise<void> {
    const say = (line: string): void => opts.onProgress?.(line);
    const slow = <T>(label: string, work: Promise<T>): Promise<T> =>
        opts.slow ? opts.slow(label, work) : work;
    const tail = (res: ProcResult): void => {
        for (const line of res.stderr.split('\n').slice(-3)) {
            if (line.trim()) {
                say(`  ${line.trim()}`);
            }
        }
    };

    if (!opts.force) {
        const present = await run(engine, ['image', 'exists', target.image], {
            timeoutMs: 30_000,
        });
        if (present.code === 0) {
            return;
        }
    }

    const build = target.build;
    if (build) {
        if (opts.allowBuild === false) {
            throw new SandboxError(
                `the sandbox image ${target.image} is not built`,
                'build it before running: `zen sandbox up` builds it on this machine',
            );
        }
        say(`${opts.force ? 'rebuilding' : 'building'} the sandbox image from ${build.dockerfile}`);
        say('  the agent runs its commands inside a container, so the image is needed first');
        say('  this takes a few minutes; later runs reuse it');
        const args = Object.entries(build.args ?? {}).flatMap(([k, v]) => [
            '--build-arg',
            `${k}=${v}`,
        ]);
        const built = await slow(
            'building the sandbox image',
            run(
                engine,
                [
                    'build',
                    '--tag',
                    target.image,
                    '--file',
                    build.dockerfile,
                    ...args,
                    build.context,
                ],
                { timeoutMs: BUILD_MS, signal: opts.signal },
            ),
        );
        tail(built);
        if (built.code !== 0) {
            throw new ImageBuildError(
                `could not build ${build.dockerfile}`,
                last(built) || 'run the build by hand to see what the engine says',
            );
        }
        return;
    }

    say(`pulling ${target.image} — this happens once`);
    const pulled = await slow(
        'pulling',
        run(engine, ['pull', target.image], { timeoutMs: PULL_MS, signal: opts.signal }),
    );
    tail(pulled);
    if (pulled.code !== 0) {
        throw new SandboxError(
            `could not pull ${target.image}`,
            first(pulled) || 'check the image name and your network',
        );
    }
}

function first(res: ProcResult): string {
    return (res.stderr.trim() || res.stdout.trim()).split('\n')[0] ?? '';
}

/** A build says what went wrong on its last line, not its first. */
function last(res: ProcResult): string {
    const lines = (res.stderr.trim() || res.stdout.trim()).split('\n').filter((l) => l.trim());
    return lines.slice(-2).join(' — ');
}
