import { home } from '@zenera/engine';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from '../args.ts';
import { buildAgentImage, runContainer } from '../container.ts';
import { asCliError, ensurePodmanReady } from '../podman.ts';
import { project as resolveProject } from '../resolve.ts';
import { preflight } from '../sandbox.ts';
import type { Command, Context } from '../command.ts';
import { CliError, dim, EXIT, green, json, note, red, usageError, write, yellow } from '../term.ts';

const USAGE = 'zen server <start|check|status|token> [options]';
const SUBCOMMANDS = ['start', 'check', 'status', 'token'];

interface Flags {
    port?: string;
    host?: string;
    project?: string;
    root?: string;
    'memory-seed'?: string;
    'no-memory-seed'?: boolean;
    'jwt-public-key'?: string;
    'jwt-issuer'?: string;
    'jwt-audience'?: string;
    insecure?: boolean;
    debug?: boolean;
    sandbox?: string;
    container?: boolean;
    rebuild?: boolean;
    token?: string;
    user?: string;
    email?: string;
    role?: string;
    name?: string;
    thread?: string;
}

/**
 * The agent server: a project's chats over HTTP, for every user its host vouches for. What the
 * agent image runs (`/opt/zenera/bin/zen server start`); `@zenera/server` is loaded only here,
 * so no other command pays for it.
 *
 * Who a request is for is the `sub` of a JWT the host signs for that request (EdDSA, checked
 * with its public key); each user's chats and memory are in a folder of their own. `--insecure`
 * reads the token without checking it, on loopback only, for trying it out.
 */
export const server: Command = {
    summary: 'Serve a project’s chats over HTTP, for every user its host vouches for.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Server', subtitle: 'Agent Server', hue: 'crimson' },
    details: [
        '  start                  Listen, after the checks below pass.',
        '  check                  Whether it could start here: commands have somewhere to',
        '                         run, the image is this project\u2019s, the root is this',
        '                         server\u2019s.',
        '  status                 A running server\u2019s own report (/api/status).',
        '  token                  Print an unsigned token for an --insecure server:',
        '                         --user <id> [--email …] [--role …] [--thread <id>].',
        '',
        '  --port <n>             Default $ZEN_SERVER_PORT, else 3000.',
        '  --host <addr>          Default $ZEN_SERVER_HOST, else 127.0.0.1.',
        '  --project <name|dir>   The project; default $PROJECT_DIR, else the one you are',
        '                         in, as zen run (in the agent image: /project).',
        '  --root <dir>           Every user\u2019s chats and memory: users/<user>/{sessions,',
        '                         memory}. Default $ZEN_SERVER_ROOT, else',
        '                         ~/.zenera/neo/servers/<project> (in the agent image: /state).',
        '  --memory-seed <dir>    What each user\u2019s memory starts as, copied the first time',
        '                         they need one. Default: the project\u2019s own.',
        '  --no-memory-seed       Every user starts with an empty memory.',
        '',
        '  --jwt-public-key <file>  The PEM (Ed25519) its tokens are signed for; default',
        '                         $ZEN_SERVER_JWT_PUBLIC_KEY (the PEM itself).',
        '  --jwt-issuer <iss>     Default zenera-app.   --jwt-audience <aud>  Default zenera-runtime.',
        '  --insecure             Read tokens without checking them: no key, any signature,',
        '                         any age. Loopback only, never in a pod.',
        '',
        '  --container            Run it in podman, in an image built from the project\u2019s',
        '                         sandbox/Dockerfile and this zen: commands under bwrap,',
        '                         with what that Dockerfile installed. --rebuild to build',
        '                         it again.',
        '  --debug                The Test tab\u2019s routes: runs, traces, memory.',
        '  --sandbox <podman|bwrap>  Where commands run; default $ZEN_SERVER_SANDBOX,',
        '                         else bwrap inside the agent image and podman anywhere',
        '                         else, as zen run.',
        '  --token <jwt>          With status: the token to send (default: an unsigned one,',
        '                         which an --insecure server takes).',
        '',
        'Model keys come from the keyring and the environment, as for zen run.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                port: { type: 'string' },
                host: { type: 'string' },
                project: { type: 'string' },
                root: { type: 'string' },
                'memory-seed': { type: 'string' },
                'no-memory-seed': { type: 'boolean' },
                'jwt-public-key': { type: 'string' },
                'jwt-issuer': { type: 'string' },
                'jwt-audience': { type: 'string' },
                insecure: { type: 'boolean' },
                debug: { type: 'boolean' },
                sandbox: { type: 'string' },
                container: { type: 'boolean' },
                rebuild: { type: 'boolean' },
                token: { type: 'string' },
                user: { type: 'string' },
                email: { type: 'string' },
                role: { type: 'string' },
                name: { type: 'string' },
                thread: { type: 'string' },
            },
            USAGE,
        );
        const what = positionals[0];
        if (!what || !SUBCOMMANDS.includes(what)) {
            throw usageError(what ? `unknown subcommand: ${what}` : 'which one?', USAGE);
        }
        if (positionals.length > 1) {
            throw usageError('one subcommand at a time', USAGE);
        }
        switch (what) {
            case 'start':
                return values.container ? startContainer(ctx, values) : start(ctx, values);
            case 'check':
                return check(ctx, values);
            case 'status':
                return status(ctx, values);
            case 'token':
                return token(values);
        }
    },
};

type ServerModule = typeof import('@zenera/server');
type ServerSettings = import('@zenera/server').ServerSettings;

async function load(): Promise<ServerModule> {
    return import('@zenera/server');
}

/**
 * The project: --project (a name or a directory, as `zen run --project`), else $PROJECT_DIR, else
 * /project in the agent image, else the one this directory is in — or a registered one to pick.
 */
async function whichProject(
    ctx: Context,
    values: Flags,
    env: NodeJS.ProcessEnv,
    mod: ServerModule,
): Promise<{ dir: string; name: string }> {
    const given = values.project ?? env.PROJECT_DIR?.trim();
    if (!given && mod.inAgentImage()) {
        return { dir: '/project', name: env.ZEN_PROJECT_ID?.trim() || 'project' };
    }
    const found = await resolveProject({ project: given, cwd: ctx.cwd });
    return { dir: found.dir, name: found.name };
}

/** The verification a token gets: the host's key, or none at all (`--insecure`). */
function whichAuth(
    ctx: Context,
    values: Flags,
    env: NodeJS.ProcessEnv,
    mod: ServerModule,
): import('@zenera/server').ServerAuth {
    if (values.insecure) {
        if (values['jwt-public-key']) {
            throw usageError('--insecure checks no key: drop --jwt-public-key', USAGE);
        }
        if (mod.inAgentImage() && !mod.insecureHere(env)) {
            throw usageError('--insecure is never for a pod: give it the public key', USAGE);
        }
        return { mode: 'insecure' };
    }
    let publicKey = env.ZEN_SERVER_JWT_PUBLIC_KEY?.trim() ?? '';
    if (values['jwt-public-key']) {
        try {
            publicKey = readFileSync(resolve(ctx.cwd, values['jwt-public-key']), 'utf8');
        } catch (err) {
            throw usageError(`cannot read the public key: ${(err as Error).message}`, USAGE);
        }
    }
    if (!publicKey) {
        throw usageError(
            'no key to check tokens with',
            'give the public key its tokens are signed for (--jwt-public-key or ' +
                '$ZEN_SERVER_JWT_PUBLIC_KEY), or try it with --insecure',
        );
    }
    return {
        mode: 'jwt',
        publicKey,
        issuer: values['jwt-issuer'] ?? (env.ZEN_SERVER_JWT_ISSUER?.trim() || mod.DEFAULT_ISSUER),
        audience:
            values['jwt-audience'] ?? (env.ZEN_SERVER_JWT_AUDIENCE?.trim() || mod.DEFAULT_AUDIENCE),
    };
}

/** --root, else $ZEN_SERVER_ROOT, else /state in the agent image, else in the zen home. */
function whichRoot(
    ctx: Context,
    values: Flags,
    env: NodeJS.ProcessEnv,
    mod: ServerModule,
    project: string,
): string {
    const given = values.root ?? env.ZEN_SERVER_ROOT?.trim();
    if (given) return resolve(ctx.cwd, given);
    if (mod.inAgentImage()) return '/state';
    return join(home(), 'servers', project.replace(/[^\w.@-]/g, '_'));
}

function whichSeed(ctx: Context, values: Flags): string | null | undefined {
    if (values['no-memory-seed']) {
        if (values['memory-seed']) throw usageError('--memory-seed or --no-memory-seed', USAGE);
        return null;
    }
    return values['memory-seed'] ? resolve(ctx.cwd, values['memory-seed']) : undefined;
}

async function options(ctx: Context, values: Flags, env: NodeJS.ProcessEnv = process.env) {
    const mod = await load();
    const project = await whichProject(ctx, values, env, mod);
    const projectId = env.ZEN_PROJECT_ID?.trim() || project.name;
    const sandboxName = values.sandbox ?? (env.ZEN_SERVER_SANDBOX?.trim() || mod.defaultSandbox());
    if (sandboxName !== 'bwrap' && sandboxName !== 'podman') {
        throw usageError(`--sandbox is bwrap or podman, not ${sandboxName}`, USAGE);
    }
    const settings: ServerSettings = {
        ...mod.DEFAULTS,
        projectDir: project.dir,
        projectId,
        root: whichRoot(ctx, values, env, mod, projectId),
        memorySeed: whichSeed(ctx, values),
        auth: whichAuth(ctx, values, env, mod),
        debug: Boolean(values.debug ?? truthy(env.ZEN_SERVER_DEBUG)),
        sandbox: sandboxName,
        sandboxProvider: mod.SANDBOX_PROVIDERS[sandboxName],
        // As `zen run` readies podman: the machine started, the image pulled or built.
        ...(sandboxName === 'podman'
            ? {
                  preflight: (setup: import('@zenera/engine').SandboxSetup) =>
                      preflight(setup, true),
              }
            : {}),
        hidden: [],
        plugins: mod.envRunPlugins(env),
        maxRuns: positive(env.ZEN_RUNTIME_MAX_RUNS, mod.DEFAULTS.maxRuns),
        maxUserRuns: positive(env.ZEN_RUNTIME_MAX_USER_RUNS, mod.DEFAULTS.maxUserRuns),
        maxRunMinutes: positive(env.ZEN_RUNTIME_MAX_RUN_MINUTES, mod.DEFAULTS.maxRunMinutes),
        runLogMaxBytes:
            positive(env.ZEN_RUNTIME_RUN_LOG_MAX_MB, mod.DEFAULTS.runLogMaxBytes / 2 ** 20) *
            2 ** 20,
    };
    return { mod, settings, listen: listenOn(values, env) };
}

type ListenOn = import('@zenera/server').ListenOn;

/** --port/--host, else $ZEN_SERVER_PORT/$ZEN_SERVER_HOST, else 127.0.0.1:3000. */
function listenOn(values: Flags, env: NodeJS.ProcessEnv = process.env): Required<ListenOn> {
    const text = values.port ?? env.ZEN_SERVER_PORT?.trim() ?? '3000';
    const port = Number(text);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw usageError(`not a port: ${text}`, USAGE);
    }
    return { port, host: values.host ?? (env.ZEN_SERVER_HOST?.trim() || '127.0.0.1') };
}

function describe(on: ListenOn): string {
    return on.host?.includes(':') ? `[${on.host}]:${on.port}` : `${on.host}:${on.port}`;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

async function check(ctx: Context, values: Flags): Promise<void> {
    if (values.container) {
        await ensurePodmanReady({ yes: true }).catch((err: unknown) => {
            throw asCliError(err);
        });
        write(green('✓ podman is ready: start --container builds what it needs'));
        return;
    }
    const { mod, settings } = await options(ctx, values);
    mod.configure(settings);
    const report = await mod.serverStatus();
    const errors = mod.startupErrors(report);
    if (ctx.json) {
        json({ ok: errors.length === 0, errors, status: report });
    } else {
        printStatus(report);
        for (const e of errors) write(red(`✗ ${e}`));
        if (!errors.length) write(green('✓ ready to start'));
    }
    if (errors.length) {
        throw new CliError('the server cannot start here', EXIT.sandbox);
    }
}

async function start(ctx: Context, values: Flags): Promise<void> {
    const { mod, settings, listen } = await options(ctx, values);
    if (settings.auth.mode === 'insecure' && !LOOPBACK.has(listen.host) && !mod.insecureHere()) {
        throw usageError(`--insecure listens on loopback only, not ${listen.host}`, USAGE);
    }
    mod.configure(settings);
    if (settings.sandbox === 'podman') {
        // What `zen run` does first: podman there and its machine running, without asking.
        await ensurePodmanReady({ yes: true }).catch((err: unknown) => {
            throw asCliError(err);
        });
    }
    const errors = mod.startupErrors(await mod.serverStatus());
    if (errors.length) {
        for (const e of errors) note(red(`✗ ${e}`));
        throw new CliError('the server cannot start here', EXIT.sandbox, 'zen server check');
    }
    if (settings.auth.mode === 'insecure') {
        note(yellow('⚠ insecure: tokens are read, not checked — anyone here can be anyone'));
    }
    const app = mod.createServer(settings);
    await app.listen(listen);
    note(
        `zen server listening on ${describe(listen)} ` +
            dim(
                `(project=${settings.projectId}, root=${settings.root}, auth=${settings.auth.mode}, ` +
                    `sandbox=${settings.sandboxProvider}${settings.debug ? ', debug' : ''})`,
            ),
    );
    // A stopping container: runs end as interrupted and save their sessions within the grace
    // period, then the process ends — whatever a run's tools left open must not keep it alive.
    await new Promise<void>((done) => {
        const stop = (signal: string) => {
            note(`${signal}: stopping, ${mod.activeRuns()} run(s) going`);
            void app.stop(20_000).finally(done);
        };
        process.once('SIGTERM', () => stop('SIGTERM'));
        process.once('SIGINT', () => stop('SIGINT'));
    });
    process.exit(0);
}

/** `--container`: the agent image built from the project, run in podman, its port here. */
async function startContainer(ctx: Context, values: Flags): Promise<void> {
    const mod = await load();
    if (mod.inAgentImage()) {
        throw usageError('already inside the agent image: drop --container', USAGE);
    }
    if (values.sandbox) {
        throw usageError('--container runs commands under bwrap in it: drop --sandbox', USAGE);
    }
    const env = process.env;
    const project = await whichProject(ctx, values, env, mod);
    const projectId = env.ZEN_PROJECT_ID?.trim() || project.name;
    const auth = whichAuth(ctx, values, env, mod);
    const listen = listenOn(values, env);
    if (auth.mode === 'insecure' && !LOOPBACK.has(listen.host)) {
        throw usageError(`--insecure listens on loopback only, not ${listen.host}`, USAGE);
    }
    const image = await buildAgentImage(project.dir, { rebuild: values.rebuild });
    note(
        `zen server in ${image.tag} ${dim(`(on ${image.base}${image.built ? ', just built' : ''})`)}`,
    );
    if (auth.mode === 'insecure') {
        note(yellow('⚠ insecure: tokens are read, not checked — anyone here can be anyone'));
    }
    const root = whichRoot(ctx, values, env, mod, projectId);
    note(dim(`listening on ${describe(listen)}, root ${root}`));
    await runContainer({
        image: image.tag,
        project: { dir: project.dir, id: projectId },
        root,
        memorySeed: whichSeed(ctx, values),
        listen,
        debug: Boolean(values.debug),
        auth,
    });
    process.exit(0);
}

async function status(ctx: Context, values: Flags): Promise<void> {
    const mod = await load();
    const on = listenOn(values);
    const target = '/api/status';
    // An unsigned token, unless given one: what an --insecure server takes.
    const bearer =
        values.token ??
        mod.unsignedToken({ sub: values.user ?? 'zen-status', req: `GET ${target}` });
    let res: Response;
    try {
        res = await fetch(`http://${describe(on)}${target}`, {
            headers: { authorization: `Bearer ${bearer}` },
            signal: AbortSignal.timeout(10_000),
        });
    } catch (err) {
        throw new CliError(
            `no server answered on ${describe(on)}: ${(err as { cause?: { code?: string } }).cause?.code ?? err}`,
            EXIT.failed,
            'is it running? --port and --host say where',
        );
    }
    if (!res.ok) {
        throw new CliError(
            `${describe(on)} answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
            EXIT.failed,
            res.status === 401
                ? 'it checks its tokens: give it one signed for it, --token'
                : undefined,
        );
    }
    const report = (await res.json()) as import('@zenera/server').ServerStatus;
    if (ctx.json) {
        json(report);
        return;
    }
    printStatus(report);
}

/** An unsigned token: what an --insecure server takes, for curl and the like. */
async function token(values: Flags): Promise<void> {
    const mod = await load();
    if (!values.user) {
        throw usageError('for whom? --user <id>', USAGE);
    }
    write(
        mod.unsignedToken({
            sub: values.user,
            ...(values.email ? { email: values.email } : {}),
            ...(values.role ? { role: values.role } : {}),
            ...(values.name ? { name: values.name } : {}),
            ...(values.thread ? { thr: values.thread } : {}),
        }),
    );
}

function printStatus(s: import('@zenera/server').ServerStatus): void {
    const row = (k: string, v: string) => write(`${dim(k.padEnd(9))} ${v}`);
    row('project', `${s.project.id} ${dim(s.project.dir)}`);
    row(
        'auth',
        s.auth === 'insecure' ? yellow('insecure (tokens not checked)') : 'jwt (EdDSA, checked)',
    );
    row('listen', `${s.listen ?? dim('not yet')}${s.debug ? dim(' · debug routes on') : ''}`);
    row(
        'sandbox',
        s.sandbox.ok
            ? `${s.sandbox.provider}${s.sandbox.proc ? dim(` · ${s.sandbox.proc} /proc`) : ''}`
            : red(`${s.sandbox.provider}: ${s.sandbox.error}`),
    );
    const img = s.image;
    row(
        'image',
        img.error
            ? red(img.error)
            : img.matches === undefined
              ? yellow('not built by zen (no identity to check)')
              : img.matches
                ? `${img.build ?? img.base}${img.release ? dim(` · release ${img.release}`) : ''}`
                : red(
                      `${img.build ?? img.base}, project wants ${img.wants.build ?? img.wants.image}`,
                  ),
    );
    row(
        'root',
        s.root.error
            ? red(s.root.error)
            : `${s.root.dir} ${dim(
                  s.root.version === undefined
                      ? 'new: written on start'
                      : `layout ${s.root.version} of ${s.root.supported}`,
              )}`,
    );
    row(
        'memory',
        s.memorySeed ? `seeded from ${s.memorySeed}` : dim('no seed: each user starts empty'),
    );
    row('versions', dim(`server ${s.server} · engine ${s.zen.engine} · node ${s.node}`));
}

function truthy(v: string | undefined): boolean {
    return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}

function positive(v: string | undefined, fallback: number): number {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}
