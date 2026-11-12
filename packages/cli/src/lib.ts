// packages/cli/src/lib.ts
//
// The public API of `@zenera/cli`, exported as `@zenera/cli/lib`: a hand-picked list, bound by the package version.
// Main: re-exports of the keyring, argument parsing, terminal styling, catalog, `Command`, and the section
// "For @zenera/meta" (project resolution, usage ledger, editor brief, theme, `browseModels`).
// Used by: sibling packages only - `@zenera/meta` (through its `src/host.ts`), `@zenera/gym`, `@zenera/rag`.

// ---------------------------------------------------------------------------
// The library face of the CLI
//
// `zen` is a program, not a library, and everything in `src/` is written that
// way: it prints, it prompts, it carries process exit codes. But the keyring is
// a machine-level thing rather than a command-level one — where credentials
// live, how they are stored 0600, how they reach `process.env` before a run —
// and a second front end on this machine has to agree with `zen` about all
// three or the two disagree about which key is active.
//
// `Command` is here for the other direction: a sibling package implements it
// and `zen` loads it by name, so a new package is a subcommand rather than a
// new binary.
//
// So this file, and only this file, is what another package may import. It is
// deliberately a hand-written list rather than a `export *`: every name here is
// public API of a published package and is bound by its version, which is a
// reason to add to it slowly.
//
// One caveat travels with `term.ts`: `CliError` carries an exit code and the
// writers go to stdout/stderr. That vocabulary belongs to startup. A server
// must not let a `CliError` escape into a request handler.
// ---------------------------------------------------------------------------

export {
    assertNotEmpty,
    assertOwner,
    assertPrivate,
    assertUsable,
    describe,
    ensureDir,
    ensureHome,
    envNames,
    envOf,
    form,
    home,
    isOwner,
    isProvider,
    keyId,
    KeyStore,
    mask,
    OWNERS,
    parseRef,
    paths,
    PROVIDERS,
    readJson,
    SERVICES,
    SHAPES,
    writeJson,
    type CredentialForm,
    type KeyCheck,
    type KeyEntry,
    type KeyOwner,
    type Liveness,
    type Provider,
    type Service,
} from '@zenera/engine';
export { extract, invokedAs, one, parse, split, type Parsed, type Split } from './args.ts';
export { bannerArt, printBanner, type BannerText } from './banner.ts';
export {
    Cache,
    items as cacheItems,
    cacheKey,
    kinds as cacheKinds,
    clear as clearCache,
    NO_CACHE,
    sweep as sweepCache,
    type CacheEntry,
    type CacheItem,
    type CacheKind,
    type CacheOptions,
    type CacheStore,
    type Swept,
} from './cache.ts';
export {
    CATALOG_TTL_MS,
    CURATED,
    fetchCatalog,
    loadCatalog,
    loadCatalogs,
    matches,
    PREFERRED,
    type Catalog,
    type CatalogEntry,
    type CatalogOptions,
    type Filters,
    type Role,
} from './catalog.ts';
export type { Command, Context, Subsystem } from './command.ts';
export { probe, probeAll } from './liveness.ts';
export {
    engineDisk,
    ensurePodmanReady,
    ownedContainers,
    podmanStatus,
    removeContainers,
    type DiskLine,
    type EngineDisk,
    type OwnedContainer,
    type PodmanOptions,
    type PodmanStatus,
} from './podman.ts';
export {
    ago,
    bold,
    CliError,
    count,
    credentialError,
    cyan,
    dim,
    EXIT,
    fail,
    green,
    invalidError,
    isInteractive,
    italic,
    json,
    note,
    pad,
    red,
    table,
    underline,
    usageError,
    warn,
    write,
    writeAll,
    yellow,
    type ExitCode,
} from './term.ts';
export { formatBlocks, formatInline, formatMarkdown, wrapSpans } from './tui/markdown.ts';

// ---------------------------------------------------------------------------
// For @zenera/meta
//
// The meta agent was a part of `zen` until it became a package of its own, and
// it still drives `zen` the way the rest of the CLI does: the same project
// resolution, the same usage ledger, the same editor brief and the same look.
// These are what it reaches for, through `packages/meta/src/host.ts` alone.
// ---------------------------------------------------------------------------

export { matching, projectNames, type Candidate } from './candidates.ts';
export { editorFiles } from './editor.ts';
export { copilotEventLog, type EventLine } from './eventlog.ts';
export { probeChat, probeModel } from './liveness.ts';
export { PROVIDER_NAMES, splitRef } from './modelref.ts';
export { duration } from './narrate.ts';
export { rankModels } from './rank.ts';
export { project as resolveProject } from './resolve.ts';
export { copyTree, SHARED_RULES, TEMPLATES } from './scaffold.ts';
export { choose, confirm, cut, plain, progress, readStdin, styled } from './term.ts';
export { safe } from './trace.ts';
export { resolveTheme, THEMES, type Theme } from './tui/theme.ts';
export { boxWidth, wrap } from './tui/wrap.ts';
export { appendUsage, LEDGER_ENV, ledgerPath, META_PROMPT_ENV, META_SESSION_ENV } from './usage.ts';
export { validateProject, type Report as ProjectReport } from './validate.ts';

/** The model browser, loaded only when asked for: it is the one thing here that draws. */
export async function browseModels(
    ...args: Parameters<typeof import('./commands/models.ts').browseModels>
): ReturnType<typeof import('./commands/models.ts').browseModels> {
    const { browseModels: browse } = await import('./commands/models.ts');
    return await browse(...args);
}
