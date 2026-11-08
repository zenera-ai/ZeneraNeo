/**
 * Terminal presentation shared by direct and container-based server startup.
 * printServerStarted renders the runtime summary and browser link; streamAgentBuild
 * uses animated compact build progress by default and full grouped logs with --verbose.
 * HOST_MANAGED_ENV lets the image report readiness without repeating the host summary.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentImage } from './container.ts';
import {
    bold,
    CliError,
    cut,
    cyan,
    dim,
    EXIT,
    green,
    note,
    plain,
    progress,
    red,
    table,
    warn,
    write,
    yellow,
} from './term.ts';

export const HOST_MANAGED_ENV = 'ZEN_SERVER_HOST_MANAGED';

export interface ServerStartup {
    project: string;
    url: string;
    root: string;
    auth: 'jwt' | 'insecure';
    sandbox: string;
    image?: AgentImage;
    runtimeUser?: string;
    page?: string;
    chatUser?: string;
}

export function printServerStarted(info: ServerStartup): void {
    note();
    note(`  ${green(bold(info.image ? '✓ Container started' : '✓ Server ready'))}`);
    note();
    const rows: [string, string][] = [
        ['Project', bold(info.project)],
        ['HTTP', cyan(info.url)],
        [
            'Auth',
            info.auth === 'insecure'
                ? yellow('insecure · JWT signatures not checked')
                : green('JWT · EdDSA verified'),
        ],
        ['Sandbox', info.sandbox],
        ['State', dim(info.root)],
        ['Memory', 'private per user · shared across sessions'],
    ];
    if (info.runtimeUser) rows.push(['Process', info.runtimeUser]);
    if (info.image) {
        rows.push(
            [
                'Image',
                `${cyan(info.image.tag)} ${dim(info.image.built ? '(just built)' : '(cached)')}`,
            ],
            ['Base', dim(info.image.base)],
        );
    }
    if (info.page) rows.push(['Chat user', bold(info.chatUser ?? 'local')]);
    for (const line of table(rows.map(([label, value]) => [dim(label), value]))) {
        note(`  ${line}`);
    }
    if (info.auth === 'insecure') {
        note();
        warn('Anyone with access can impersonate any user. Local testing only.');
    }
    if (info.page) {
        write();
        write(`  ${bold('Test chat')}`);
        write(`  ${cyan(info.page)}`);
        write();
    }
    note();
    note(dim('  Press Ctrl+C to stop gracefully and save active runs.'));
    note();
}

/** Keep the host's published address and paths out of the image's own ready message. */
export function hostManagedOutput(
    inAgentImage: boolean,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return inAgentImage && env[HOST_MANAGED_ENV] === '1';
}

const BUILD_ERROR = /^(?:error\b|npm (?:err!|error)\b)|\b(?:fatal error|failed to)\b/i;
const BUILD_WARNING = /\b(?:warn|warning|deprecated)\b/i;

function buildLinePrinter(): (line: string) => void {
    let stage: string | undefined;
    return (line) => {
        const step = /^(\s*(?:\[(\d+)\/(\d+)\] )?STEP \d+\/\d+:)(.*)/.exec(line);
        if (step?.[2] && stage !== step[2]) {
            stage = step[2];
            const name = /\bAS\s+(\S+)/i.exec(step[4]!)?.[1] ?? 'agent image';
            note();
            note(`  ${bold(cyan(`Build stage ${step[2]}/${step[3]} · ${name}`))}`);
        }
        const text = step
            ? `${bold(cyan(step[1]!))}${dim(step[4]!)}`
            : BUILD_ERROR.test(line.trimStart())
              ? red(line)
              : BUILD_WARNING.test(line)
                ? yellow(line)
                : /^(?:Successfully tagged|Successfully built)/i.test(line)
                  ? green(line)
                  : dim(line);
        note(line ? `    ${text}` : '');
    };
}

/** A spinning row with elapsed time in a terminal, or one final row in a piped log. */
export function buildProgress(verbose = false): { line(line: string): void; done(): void } {
    const print = buildLinePrinter();
    const bar = progress();
    const tty = Boolean(process.stderr.isTTY);
    const started = Date.now();
    const frames = ['|', '/', '-', '\\'];
    let frame = 0;
    let last = '';
    let finished = false;
    const render = () => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        const text = `${frames[frame++ % frames.length]} ${seconds}s ${last || 'Building…'}`;
        bar.update(`  ${dim(plain(cut(text, Math.max(1, (process.stderr.columns || 100) - 2))))}`);
    };
    const timer = !verbose && tty ? setInterval(render, 150) : undefined;
    timer?.unref();
    if (timer) render();
    return {
        line(line) {
            if (finished) return;
            if (verbose) {
                print(line);
                return;
            }
            if (!line.trim()) return;
            if (BUILD_ERROR.test(line.trimStart()) || BUILD_WARNING.test(line)) {
                bar.done();
                print(line);
                last = '';
                return;
            }
            last = line;
            if (tty) render();
        },
        done() {
            if (finished) return;
            finished = true;
            if (timer) clearInterval(timer);
            bar.done();
            if (!verbose && !tty && last) note(`  ${dim(plain(cut(last, 120)))}`);
            last = '';
        },
    };
}

/** stdout and stderr are decoded independently so split chunks never corrupt build lines. */
export function streamAgentBuild(
    bin: string,
    args: readonly string[],
    verbose = false,
): Promise<void> {
    const output = buildProgress(verbose);
    return new Promise<void>((done, fail) => {
        const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        const tail: string[] = [];
        const show = (line: string) => {
            if (line.trim()) {
                tail.push(line);
                if (tail.length > 20) tail.shift();
            }
            output.line(line);
        };
        createInterface({ input: child.stdout, crlfDelay: Infinity })
            .on('line', show)
            .on('error', fail);
        createInterface({ input: child.stderr, crlfDelay: Infinity })
            .on('line', show)
            .on('error', fail);
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
    }).finally(() => output.done());
}
