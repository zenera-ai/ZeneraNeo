import { basename, resolve } from 'node:path';
import { parse } from '../args.ts';
import { asCliError, ensurePodmanReady } from '../podman.ts';
import { preflight } from '../sandbox.ts';
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
    debug?: boolean;
    sandbox?: string;
}

/**
 * The agent server: one user's chats with a project, over HTTP. It is what the
 * agent image runs (`/opt/zenera/bin/zen server start`); `@zenera/server` is
 * loaded only here, so no other command pays for it.
 *
 * Every request carries the one token it was given ($ZEN_SERVER_TOKEN, else
 * <state>/server.token, made on first start). The token names nobody: who the
 * server is for is --user, and who may use it is decided in front of it.
 */
export const server: Command = {
    summary: 'Serve a project’s chats over HTTP: the agent image’s server.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Server', subtitle: 'Agent Server', hue: 'crimson' },
    details: [
        '  start                  Listen, after the checks below pass.',
        '  check                  Whether it could start here: commands isolated',
        '                         (bwrap), the image built for this project, a',
        '                         /state that is this user\u2019s.',
        '  status                 A running server\u2019s own report (/api/status).',
        '',
        '  --port <n>             Default $ZEN_SERVER_PORT, else 3000.',
        '  --host <addr>          Default $ZEN_SERVER_HOST, else 127.0.0.1.',
        '  --project <dir>        The project; default $PROJECT_DIR, else /project.',
        '  --state <dir>          Everything it writes; default $ZEN_STATE_DIR, else /state.',
        '  --user <id>            Whose server it is; default $ZEN_USER_ID ($ZEN_USER_EMAIL,',
        '                         $ZEN_USER_ROLE say more about them).',
        '  --debug                The Test tab\u2019s routes: runs, traces, memory.',
        '  --sandbox <podman|bwrap>  Where commands run; default $ZEN_SERVER_SANDBOX,',
        '                         else bwrap inside the agent image and podman anywhere',
        '                         else, as zen run (start readies the machine; a turn',
        '                         pulls or builds the image it needs).',
        '',
        'Every request but /healthz needs `Authorization: Bearer <token>`: the',
        'token is $ZEN_SERVER_TOKEN, else <state>/server.token (made on first start,',
        'owner-only). Sandboxed commands see neither.',
        '',
        'Model keys come from the environment (BIFROST_BASE_URL and BIFROST_API_KEY,',
        'or a vendor\u2019s own), as anything else a run reads does.',
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
                debug: { type: 'boolean' },
                sandbox: { type: 'string' },
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
    const id = values.user ?? env.ZEN_USER_ID?.trim();
    if (!id) {
        throw usageError('whose server is it?', 'name its user: --user or $ZEN_USER_ID');
    }
    const user = {
        id,
        ...(env.ZEN_USER_EMAIL?.trim() ? { email: env.ZEN_USER_EMAIL.trim() } : {}),
        ...(env.ZEN_USER_ROLE?.trim()
            ? { role: env.ZEN_USER_ROLE.trim() as import('@zenera/server').ServerUser['role'] }
            : {}),
    };
    try {
        mod.checkUser(user);
    } catch (err) {
        throw usageError((err as Error).message, USAGE);
    }
    const sandboxName = values.sandbox ?? (env.ZEN_SERVER_SANDBOX?.trim() || mod.defaultSandbox());
    if (sandboxName !== 'bwrap' && sandboxName !== 'podman') {
        throw usageError(`--sandbox is bwrap or podman, not ${sandboxName}`, USAGE);
    }
    return {
        mod,
        listen: listenOn(values),
        stateDir,
        settings: {
            ...mod.DEFAULTS,
            projectDir,
            projectId: env.ZEN_PROJECT_ID?.trim() || basename(projectDir),
            stateDir,
            user,
            token: '',
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
            maxRunMinutes: positive(env.ZEN_RUNTIME_MAX_RUN_MINUTES, mod.DEFAULTS.maxRunMinutes),
            runLogMaxBytes:
                positive(env.ZEN_RUNTIME_RUN_LOG_MAX_MB, mod.DEFAULTS.runLogMaxBytes / 2 ** 20) *
                2 ** 20,
        } satisfies import('@zenera/server').ServerSettings,
    };
}

type ListenOn = import('@zenera/server').ListenOn;

/** --port/--host, else $ZEN_SERVER_PORT/$ZEN_SERVER_HOST, else 127.0.0.1:3000. */
function listenOn(values: Flags, env: NodeJS.ProcessEnv = process.env): ListenOn {
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
    const { mod, settings, listen, stateDir } = await options(ctx, values);
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
    if (!LOOPBACK.has(listen.host ?? '')) {
        note(
            yellow(
                `⚠ listening on ${listen.host}: its token is all that stands between the network ` +
                    `and ${settings.user.id}'s chats`,
            ),
        );
    }
    const token = mod.serverToken(stateDir, { create: true })!;
    const app = mod.createServer({ ...settings, token: token.token });
    await app.listen(listen);
    note(
        `zen server listening on ${describe(listen)} ` +
            dim(
                `(project=${settings.projectId}, user=${settings.user.id}, ` +
                    `state=${settings.stateDir}, sandbox=${settings.sandboxProvider}` +
                    `${settings.debug ? ', debug' : ''}, ` +
                    `token from ${token.from === 'env' ? '$ZEN_SERVER_TOKEN' : token.from})`,
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
    const mod = await load();
    const stateDir = resolve(ctx.cwd, values.state ?? process.env.ZEN_STATE_DIR ?? '/state');
    const on = listenOn(values);
    const token = mod.serverToken(stateDir);
    const url = `http://${describe(on)}/api/status`;
    let res: Response;
    try {
        res = await fetch(url, {
            headers: token ? { authorization: `Bearer ${token.token}` } : {},
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
                ? 'its token: $ZEN_SERVER_TOKEN, or --state where its server.token is'
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

function printStatus(s: import('@zenera/server').ServerStatus): void {
    const row = (k: string, v: string) => write(`${dim(k.padEnd(9))} ${v}`);
    row('project', `${s.project.id} ${dim(s.project.dir)}`);
    row('user', s.user);
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
