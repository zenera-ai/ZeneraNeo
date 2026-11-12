// packages/cli/src/commands/version.ts
//
// `zen version`: the version of every `@zenera/*` package this `zen` resolves, and of the programs it runs on.
// Main: `version: Command`. Helpers: `versionOf`, `installedVersion` (manifest of a resolved package),
// `askVersion` (`<program> --version`). Siblings add their own subsystems through `Command.subsystems`.
// Used by: `commands/index.ts` (as `zen version`), `main.ts` (`--version` prints `cliManifest` alone),
// and the tests, which compare the sandbox image tag to `versionOf(cliManifest)`.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, Subsystem } from '../command.ts';
import { hasExternal, loadExternal } from '../external.ts';
import { dim, json, pad, write, yellow } from '../term.ts';
import { EXTERNAL } from './index.ts';

/** A package's version, read from its manifest rather than inlined at build time. */
export async function versionOf(manifest: URL): Promise<string> {
    const { version } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
    return version;
}

export const cliManifest = new URL('../../package.json', import.meta.url);

/** What `zen` itself is built on, as opposed to the packages it loads by name. */
const BUILT_ON = [
    '@zenera/engine',
    '@zenera/neo',
    '@zenera/sandbox',
    '@zenera/server',
    '@zenera/view',
];

/**
 * Where a package actually resolved from — the workspace symlink in
 * development, `node_modules` once installed — found the way `zen` finds it.
 * Not every package exports its manifest, so failing that it resolves an
 * entry point it does export and climbs to the manifest that names it. That
 * also fails loudly if an `exports` map is ever broken, which is the one
 * packaging mistake nothing else catches.
 */
export async function installedVersion(name: string): Promise<string | undefined> {
    for (const spec of [`${name}/package.json`, name, `${name}/command`]) {
        let at: string;
        try {
            at = fileURLToPath(import.meta.resolve(spec));
        } catch {
            continue;
        }
        for (let dir = dirname(at); dir !== dirname(dir); dir = dirname(dir)) {
            try {
                const found = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
                    name?: string;
                    version?: string;
                };
                if (found.name === name) {
                    return found.version;
                }
            } catch {
                // No manifest at this level; keep climbing.
            }
        }
    }
    return undefined;
}

/** The first line a program prints for `--version`, or nothing if it is not there to ask. */
export function askVersion(command: string, args = ['--version']): Promise<string | undefined> {
    return new Promise((done) => {
        execFile(command, args, { timeout: 5_000 }, (err, stdout) => {
            done(err ? undefined : stdout.trim().split('\n')[0]?.trim() || undefined);
        });
    });
}

async function podman(): Promise<Subsystem> {
    const said = await askVersion('podman');
    return said
        ? { name: 'podman', version: said.split(' ').at(-1) }
        : { name: 'podman', detail: 'needed by zen sandbox and zen server' };
}

/** What each installed sibling says it runs on. One that cannot say is left out, not fatal. */
async function siblings(): Promise<Subsystem[]> {
    const said = await Promise.all(
        Object.entries(EXTERNAL)
            .filter(([, ext]) => hasExternal(ext))
            .map(async ([name, ext]) => {
                try {
                    return (await (await loadExternal(name, ext)).subsystems?.()) ?? [];
                } catch {
                    return [];
                }
            }),
    );
    return said.flat();
}

interface Row {
    name: string;
    version?: string;
    detail?: string;
}

export const version: Command = {
    summary: 'Print the versions of every zen package and what they run on.',
    usage: 'zen version',
    details: [
        'Packages are the @zenera/* ones this zen resolves: what it is built on,',
        'then the ones it loads by name (zen meta, zen gym, zen rag), which are',
        'installed apart. They are released in lockstep, so one whose version is',
        'not the CLI’s is marked: that is the usual reason a command misbehaves.',
        '',
        'Subsystems are the programs outside Node that commands run: podman for',
        'the sandbox and the server, copilot for the meta agent.',
        '',
        '`zen --version` prints the CLI’s version alone.',
    ],
    banner: { head: 'Zenera', accent: 'Version', subtitle: 'Runtime & Build', hue: 'steel' },
    run: async (ctx) => {
        const cli = await versionOf(cliManifest);
        const [built, external, systems] = await Promise.all([
            Promise.all(
                BUILT_ON.map(async (name) => ({ name, version: await installedVersion(name) })),
            ),
            Promise.all(
                Object.values(EXTERNAL).map(async (ext) => ({
                    name: ext.package,
                    version: await installedVersion(ext.package),
                    install: ext.install,
                })),
            ),
            Promise.all([podman(), siblings()]),
        ]);
        const packages: Row[] = [
            { name: '@zenera/cli', version: cli },
            ...built,
            ...external.map((p) => (p.version ? p : { ...p, detail: p.install })),
        ];
        const subsystems: Row[] = [
            { name: 'node', version: process.versions.node },
            systems[0],
            ...systems[1],
        ];

        if (ctx.json) {
            json({
                packages: Object.fromEntries(packages.map((p) => [p.name, p.version ?? null])),
                subsystems: Object.fromEntries(
                    subsystems.map((s) => [
                        s.name,
                        { version: s.version ?? null, ...(s.detail ? { detail: s.detail } : {}) },
                    ]),
                ),
            });
            return;
        }

        const width = Math.max(...[...packages, ...subsystems].map((r) => r.name.length));
        const line = (r: Row, missing: string, skew = false): string => {
            const value = !r.version ? dim(missing) : skew ? yellow(r.version) : r.version;
            const said = skew ? `expected ${cli}, as the CLI` : r.detail;
            return `  ${pad(r.name, width)}  ${value}${said ? `  ${dim(said)}` : ''}`;
        };
        write(dim('packages'));
        for (const p of packages) {
            write(line(p, 'not installed', p.version !== undefined && p.version !== cli));
        }
        write(dim('subsystems'));
        for (const s of subsystems) {
            write(line(s, 'not found'));
        }
    },
};
