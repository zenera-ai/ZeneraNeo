import { request } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { parse } from '../args.ts';
import type { Command, Context } from '../command.ts';
import { CliError, dim, EXIT, green, json, note, red, usageError, write, yellow } from '../term.ts';

const USAGE = 'zen server <start|check|status> [options]';
const SUBCOMMANDS = ['start', 'check', 'status'];

interface Flags {
    listen?: string;
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
 * It does no authentication. It listens on a Unix socket that sandboxed
 * commands cannot see, and whatever may reach it acts for its user: on a
 * laptop that is the socket's owner, in ZeneraLite the guard in front of it.
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
        '  --listen <where>       unix:<path> (default unix:<state>/server.sock) or',
        '                         tcp:<host>:<port>. No authentication: whoever',
        '                         reaches it acts for its user. A socket is the',
        '                         owner\u2019s only and hidden from every command.',
        '  --port <n>             Shorthand for tcp:127.0.0.1:<n>; --host widens it.',
        '  --project <dir>        The project; default $PROJECT_DIR, else /project.',
        '  --state <dir>          Everything it writes; default $ZEN_STATE_DIR, else /state.',
        '  --user <id>            Whose server it is; default $ZEN_USER_ID ($ZEN_USER_EMAIL,',
        '                         $ZEN_USER_ROLE say more about them).',
        '  --debug                The Test tab\u2019s routes: runs, traces, memory.',
        '  --sandbox <bwrap|podman>  Where commands run; bwrap unless told.',
        '',
        'Model keys come from the environment (BIFROST_BASE_URL and BIFROST_API_KEY,',
        'or a vendor\u2019s own), as anything else a run reads does.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                listen: { type: 'string' },
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
    const sandboxName = values.sandbox ?? 'bwrap';
    if (sandboxName !== 'bwrap' && sandboxName !== 'podman') {
        throw usageError(`--sandbox is bwrap or podman, not ${sandboxName}`, USAGE);
    }
    return {
        mod,
        listen: listenOn(values, stateDir),
        settings: {
            ...mod.DEFAULTS,
            projectDir,
            projectId: env.ZEN_PROJECT_ID?.trim() || basename(projectDir),
            stateDir,
            user,
            debug: Boolean(values.debug ?? truthy(env.ZEN_SERVER_DEBUG)),
            sandbox: sandboxName,
            sandboxProvider:
                sandboxName === 'podman' ? 'podman (this machine)' : 'bwrap (this container)',
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

/** --listen, else --port/--host, else $ZEN_SERVER_LISTEN, else the state directory's socket. */
function listenOn(values: Flags, stateDir: string, env: NodeJS.ProcessEnv = process.env): ListenOn {
    if (values.port !== undefined || values.host !== undefined) {
        if (values.listen) throw usageError('--listen, or --port/--host: not both', USAGE);
        return tcp(values.host ?? '127.0.0.1', values.port ?? '3000');
    }
    const where =
        values.listen ?? env.ZEN_SERVER_LISTEN?.trim() ?? `unix:${join(stateDir, 'server.sock')}`;
    if (where.startsWith('unix:') && where.length > 5) return { socket: resolve(where.slice(5)) };
    const m = /^tcp:(.+):(\d+)$/.exec(where);
    if (m) return tcp(m[1], m[2]);
    throw usageError(`--listen is unix:<path> or tcp:<host>:<port>, not ${where}`, USAGE);
}

function tcp(host: string, portText: string): ListenOn {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw usageError(`not a port: ${portText}`, USAGE);
    }
    return { port, host };
}

function describe(on: ListenOn): string {
    return 'socket' in on ? `unix:${on.socket}` : `tcp:${on.host}:${on.port}`;
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
    const { mod, settings, listen } = await options(ctx, values);
    mod.configure(settings);
    const errors = mod.startupErrors(await mod.serverStatus());
    if (errors.length) {
        for (const e of errors) note(red(`✗ ${e}`));
        throw new CliError('the server cannot start here', EXIT.sandbox, 'zen server check');
    }
    if ('port' in listen && !LOOPBACK.has(listen.host ?? '')) {
        note(
            yellow(
                `⚠ listening on ${listen.host}: anything that reaches it acts for ${settings.user.id}, ` +
                    'so put a guard in front of it',
            ),
        );
    }
    const app = mod.createServer(settings);
    await app.listen(listen);
    note(
        `zen server listening on ${describe(listen)} ` +
            dim(
                `(project=${settings.projectId}, user=${settings.user.id}, ` +
                    `state=${settings.stateDir}, sandbox=${settings.sandboxProvider}` +
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
    const stateDir = resolve(ctx.cwd, values.state ?? process.env.ZEN_STATE_DIR ?? '/state');
    const on = listenOn(values, stateDir);
    let answer: { status: number; body: string };
    try {
        answer = await get(on, '/api/status');
    } catch (err) {
        throw new CliError(
            `no server answered on ${describe(on)}: ${(err as NodeJS.ErrnoException).code ?? err}`,
            EXIT.failed,
            'is it running? --listen (or --state) says where',
        );
    }
    if (answer.status !== 200) {
        throw new CliError(
            `${describe(on)} answered ${answer.status}: ${answer.body.slice(0, 200)}`,
            EXIT.failed,
        );
    }
    const report = JSON.parse(answer.body) as import('@zenera/server').ServerStatus;
    if (ctx.json) {
        json(report);
        return;
    }
    printStatus(report);
}

/** A GET over a Unix socket or TCP; `fetch` speaks only the latter. */
function get(on: ListenOn, path: string): Promise<{ status: number; body: string }> {
    return new Promise((done, fail) => {
        const req = request(
            {
                ...('socket' in on ? { socketPath: on.socket } : { host: on.host, port: on.port }),
                path,
                timeout: 10_000,
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (body += c));
                res.on('end', () => done({ status: res.statusCode ?? 0, body }));
            },
        );
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', fail);
        req.end();
    });
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
