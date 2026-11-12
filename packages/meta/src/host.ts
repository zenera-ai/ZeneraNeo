// ---------------------------------------------------------------------------
// The meta layer's one door into the rest of the CLI
//
// Everything under `src/meta/` imports the runtime through this file and no
// other, so the layer can leave for a package of its own by turning this into
// a dependency. `test/meta-boundary.test.ts` holds the line.
// ---------------------------------------------------------------------------

export {
    envOf,
    paths,
    PROVIDERS,
    readJson,
    writeJson,
    type KeyEntry,
    type KeyStore,
    type Provider,
} from '@zenera/engine';
export { invokedAs, parse } from '../args.ts';
export { loadCatalogs } from '../catalog.ts';
export type { EventLine } from '../eventlog.ts';
export { PROVIDER_NAMES, splitRef } from '../modelref.ts';
export { duration } from '../narrate.ts';
export { rankModels } from '../rank.ts';
export { copyTree, SHARED_RULES, TEMPLATES } from '../scaffold.ts';
export {
    bold,
    CliError,
    confirm,
    credentialError,
    cut,
    cyan,
    dim,
    EXIT,
    green,
    invalidError,
    json,
    note,
    pad,
    plain,
    red,
    styled,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';
export { safe } from '../trace.ts';
export { formatInline, formatMarkdown } from '../tui/markdown.ts';
export { resolveTheme, type Theme } from '../tui/theme.ts';
export { boxWidth } from '../tui/wrap.ts';
export { META_PROMPT_ENV, META_SESSION_ENV } from '../usage.ts';
export { validateProject, type Report as ProjectReport } from '../validate.ts';
