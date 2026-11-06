import { basename, resolve } from 'node:path';
import { parse } from '../args.ts';
import type { Command, Context } from '../command.ts';
import { CliError, dim, EXIT, green, json, note, red, usageError, write, yellow } from '../term.ts';

const USAGE = 'zen server <start|check|status> [options]';
const SUBCOMMANDS = ['start', 'check', 'status'];

interface Flags {
    port?: string;
    host?: string;
    project?: string;
    state?: string;
    user?: string;
    auth?: string;
    debug?: boolean;
    sandbox?: string;
    url?: string;
    token?: string;
}

/**
 * The agent server: a project's chats over HTTP, for the one user its
 * container belongs to. It is what the agent image runs
 * (`/opt/zenera/bin/zen server start`); `@zenera/server` is loaded only here,
 * so no other command pays for it.
 */
export const server: Command = {
    summary: 'Serve a project’s chats over HTTP: the agent image’s server.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Server', subtitle: 'Agent Server', hue: 'crimson' },
    details: [
        '  start                  Listen, after the checks below pass.',
        '  check                  Whether it could start here: commands isolated',
        '                         (bwrap), the image built for this project, a',
        '                         /state layout this server knows.',
        '  status                 A running server’s own report (/api/status).',
        '',
        '  --port <n>             Default $ZEN_SERVER_PORT, else 3000.',
        '  --host <addr>          Default 0.0.0.0.',
        '  --project <dir>        The project; default $PROJECT_DIR, else /project.',
        '  --state <dir>          Everything it writes; default $ZEN_STATE_DIR, else /state.',
        '  --user <id>            The one user it serves; default $ZEN_USER_ID. Without',
        '                         one it serves any user zenera-app vouches for,',
        '                         each under <state>/users/<id>/.',
        '  --auth <jwt|token>     jwt: tokens zenera-app signs ($ZEN_IDENTITY_PUBLIC_KEY).',
        '                         token: one bearer token ($ZEN_SERVER_TOKEN), for',
        '                         a server nobody else fronts. Default: whichever is set.',
        '  --debug                The Test tab’s routes: runs, traces, memory.',
        '  --sandbox <bwrap|podman>  Where commands run; bwrap unless told.',
        '  --url <url>            With status: where it listens (default localhost:3000).',
        '  --token <t>            With status: the bearer token ($ZEN_SERVER_TOKEN).',
        '',
        'Model keys come from the environment (BIFROST_BASE_URL and BIFROST_API_KEY,',
        'or a vendor’s own), as anything else a run reads does.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                port: { type: 'string' },
                host: { type: 'string' },
                project: { type: 'string' },
                state: { type: 'string' },
                user: { type: 'string' },
                auth: { type: 'string' },
                debug: { type: 'boolean' },
                sandbox: { type: 'string' },
                url: { type: 'string' },
                token: { type: 'string' },
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
                return start(ctx, values);
            case 'check':
                return check(ctx, values);
            case 'status':
                return status(ctx, values);
        }
    },
};

type ServerModule = typeof import('@zenera/server');

async function load(): Promise<ServerModule> {
    return import('@zenera/server');
}

async function options(ctx: Context, values: Flags, env: NodeJS.ProcessEnv = process.env) {
    const mod = await load();
    const projectDir = resolve(ctx.cwd, values.project ?? env.PROJECT_DIR ?? '/project');
    const stateDir = resolve(ctx.cwd, values.state ?? env.ZEN_STATE_DIR ?? '/state');
    const userId = values.user ?? (env.ZEN_USER_ID?.trim() || undefined);
    const publicKey = env.ZEN_IDENTITY_PUBLIC_KEY?.trim() ?? '';
    const token = env.ZEN_SERVER_TOKEN?.trim() ?? '';
    const mode = values.auth ?? (publicKey ? 'jwt' : token ? 'token' : undefined);
    let auth: import('@zenera/server').ServerAuth;
    if (mode === 'jwt') {
        if (!publicKey) {
            throw usageError('--auth jwt needs $ZEN_IDENTITY_PUBLIC_KEY', USAGE);
        }
        auth = { mode, publicKey };
    } else if (mode === 'token') {
        if (!token) {
            throw usageError('--auth token needs $ZEN_SERVER_TOKEN', USAGE);
        }
        if (!userId) {
            throw usageError('--auth token serves one user: name it with --user', USAGE);
        }
        auth = { mode, token };
    } else if (mode) {
        throw usageError(`--auth is jwt or token, not ${mode}`, USAGE);
    } else {
        throw usageError(
            'no caller could ever be let in',
            'set $ZEN_IDENTITY_PUBLIC_KEY (zenera-app) or $ZEN_SERVER_TOKEN',
        );
    }
    const sandboxName = values.sandbox ?? 'bwrap';
    if (sandboxName !== 'bwrap' && sandboxName !== 'podman') {
        throw usageError(`--sandbox is bwrap or podman, not ${sandboxName}`, USAGE);
    }
    const { bwrapSandbox } = await import('@zenera/sandbox');
    return {
        mod,
        settings: {
            ...mod.DEFAULTS,
            projectDir,
            projectId: env.ZEN_PROJECT_ID?.trim() || basename(projectDir),
            stateDir,
            userId,
            auth,
            debug: Boolean(values.debug ?? truthy(env.ZEN_SERVER_DEBUG)),
            sandbox: sandboxName === 'podman' ? ('podman' as const) : bwrapSandbox,
            sandboxProvider:
                sandboxName === 'podman' ? 'podman (this machine)' : 'bwrap (this container)',
            plugins: mod.envRunPlugins(env),
            maxRuns: positive(env.ZEN_RUNTIME_MAX_RUNS, mod.DEFAULTS.maxRuns),
            maxUserRuns: positive(env.ZEN_RUNTIME_MAX_USER_RUNS, mod.DEFAULTS.maxUserRuns),
            maxRunMinutes: positive(env.ZEN_RUNTIME_MAX_RUN_MINUTES, mod.DEFAULTS.maxRunMinutes),
            runLogMaxBytes:
                positive(env.ZEN_RUNTIME_RUN_LOG_MAX_MB, mod.DEFAULTS.runLogMaxBytes / 2 ** 20) *
                2 ** 20,
        },
    };
}

async function check(ctx: Context, values: Flags): Promise<void> {
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
    const { mod, settings } = await options(ctx, values);
    mod.configure(settings);
    const errors = mod.startupErrors(await mod.serverStatus());
    if (errors.length) {
        for (const e of errors) note(red(`✗ ${e}`));
        throw new CliError('the server cannot start here', EXIT.sandbox, 'zen server check');
    }
    const port = Number(values.port ?? process.env.ZEN_SERVER_PORT ?? 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw usageError(`not a port: ${values.port}`, USAGE);
    }
    const app = mod.createServer(settings);
    await app.listen(port, values.host ?? '0.0.0.0');
    note(
        `zen server listening on ${values.host ?? '0.0.0.0'}:${port} ` +
            dim(
                `(project=${settings.projectId}, state=${settings.stateDir}, ` +
                    `${settings.userId ? `user=${settings.userId}` : 'any user'}, ` +
                    `auth=${settings.auth.mode}, sandbox=${settings.sandboxProvider}` +
                    `${settings.debug ? ', debug' : ''})`,
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

async function status(ctx: Context, values: Flags): Promise<void> {
    const url = (values.url ?? 'http://localhost:3000').replace(/\/+$/, '');
    const token = values.token ?? process.env.ZEN_SERVER_TOKEN ?? '';
    let res: Response;
    try {
        res = await fetch(`${url}/api/status`, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(10_000),
        });
    } catch (err) {
        throw new CliError(
            `no server answered at ${url}: ${(err as { cause?: { code?: string } }).cause?.code ?? err}`,
            EXIT.failed,
            'is it running? --url says where',
        );
    }
    if (!res.ok) {
        throw new CliError(
            `${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
            EXIT.failed,
            res.status === 401 ? 'pass its token: --token or $ZEN_SERVER_TOKEN' : undefined,
        );
    }
    const report = (await res.json()) as import('@zenera/server').ServerStatus;
    if (ctx.json) {
        json(report);
        return;
    }
    printStatus(report);
}

function printStatus(s: import('@zenera/server').ServerStatus): void {
    const row = (k: string, v: string) => write(`${dim(k.padEnd(9))} ${v}`);
    row('project', `${s.project.id} ${dim(s.project.dir)}`);
    row('user', s.user ?? 'any (users/<id>/)');
    row('auth', `${s.auth}${s.debug ? dim(' · debug routes on') : ''}`);
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
              ? yellow('not built by zen image build (no identity to check)')
              : img.matches
                ? `${img.build ?? img.base}${img.release ? dim(` · release ${img.release}`) : ''}`
                : red(
                      `${img.build ?? img.base}, project wants ${img.wants.build ?? img.wants.image}`,
                  ),
    );
    row(
        'state',
        s.state.error
            ? red(s.state.error)
            : `${s.state.dir} ${dim(`layout ${s.state.version} of ${s.state.supported}`)}`,
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
