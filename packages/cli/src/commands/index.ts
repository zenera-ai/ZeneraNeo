import type { BannerText } from '../banner.ts';
import type { Command } from '../command.ts';
import { cache } from './cache.ts';
import { check } from './check.ts';
import { completion } from './completion.ts';
import { pack } from './export.ts';
import { unpack } from './import.ts';
import { init } from './init.ts';
import { inspect } from './inspect.ts';
import { key } from './key.ts';
import { list } from './list.ts';
import { memory } from './memory.ts';
import { meta } from './meta.ts';
import { models } from './models.ts';
import { open } from './open.ts';
import { run } from './run.ts';
import { sandbox } from './sandbox.ts';
import { server } from './server.ts';
import { version } from './version.ts';
import { view } from './view.ts';

/**
 * Insertion order is the order help prints in, and it is deliberate: the four
 * a new user needs first, then the credentials-and-models pair, then the two
 * reports on a project, then the pair that moves a project between machines,
 * then the ones that are only ever run on purpose.
 *
 * `export` and `import` are reserved words, so the two commands are declared
 * under names a module can export and given their real ones here.
 */
export const COMMANDS: Record<string, Command> = {
    init,
    list,
    run,
    meta,
    open,
    key,
    models,
    check,
    inspect,
    view,
    export: pack,
    import: unpack,
    memory,
    sandbox,
    server,
    cache,
    completion,
    version,
};

/** Names that are not listed in help but still work. */
export const ALIASES: Record<string, string> = {
    ls: 'list',
    new: 'init',
    keys: 'key',
    model: 'models',
    validate: 'check',
    doctor: 'check',
    copilot: 'meta',
    report: 'inspect',
    mem: 'memory',
    edit: 'open',
    code: 'open',
    pack: 'export',
    archive: 'export',
    unpack: 'import',
    share: 'export',
};

// ---------------------------------------------------------------------------
// Commands living in another package
//
// A sibling package adds commands to `zen` rather than a binary of its own, so
// there is one thing to install and one name to remember. This table is what
// `zen` knows about them, and it is data: help is rendered from it without
// resolving anything and without importing anything, which is what keeps
// `zen list` from paying for a mock server's dependencies.
//
// It is a known list rather than a scan of `node_modules` on purpose. These
// packages are released in lockstep by one author, so discovery would buy
// nothing and cost a manifest format, an API version and a public contract.
// ---------------------------------------------------------------------------

export interface External {
    /** the package to import `<pkg>/command` from */
    readonly package: string;
    readonly summary: string;
    readonly usage: string;
    /** what to tell someone who has not got it */
    readonly install: string;
    /** printed instead of the `zen` banner, so the sub-brand shows through */
    readonly banner?: BannerText;
}

export const EXTERNAL: Record<string, External> = {
    gym: {
        package: '@zenera/gym',
        summary: 'Simulated API environments for agent training and evaluation.',
        usage: 'zen gym <serve|build|cache|model> [spec...]',
        install: 'npm i -g @zenera/gym',
        banner: { head: 'Zenera', accent: 'Gym', subtitle: 'Agent Environments', hue: 'mint' },
    },
    rag: {
        package: '@zenera/rag',
        summary: 'Retrieval over a corpus: index it, then ask it something.',
        usage: 'zen rag <subject> <command> [args...]',
        install: 'npm i -g @zenera/rag',
        banner: { head: 'Zenera', accent: 'Rag', subtitle: 'Corpus Retrieval', hue: 'green' },
    },
};
