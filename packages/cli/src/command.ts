// packages/cli/src/command.ts
//
// The `Command` contract every `zen` subcommand implements, built-in or loaded from a sibling package.
// Main: `Command` (summary, usage, help, run, and the optional `complete` and `subsystems` hooks), `Context`, `Subsystem`.
// Used by: every file in `src/commands/`, `main.ts` (dispatch), `complete.ts`, and through `lib.ts` by
// `@zenera/meta`, `@zenera/gym` and `@zenera/rag`, which export a `Command` as `<package>/command`.

// ---------------------------------------------------------------------------
// The command contract
//
// A command receives its own arguments, already stripped of the name, and the
// two things the frame settled before dispatching: whether output should be
// machine-readable, and which directory the whole invocation is relative to.
//
// It returns nothing. Success is the absence of a throw; every failure worth
// distinguishing is a `CliError` carrying its exit code.
// ---------------------------------------------------------------------------

import type { BannerText } from './banner.ts';
import type { Candidate } from './candidates.ts';

export interface Context {
    readonly args: readonly string[];
    readonly json: boolean;
    /** honours `-C <dir>`, so nothing below reads `process.cwd()` directly */
    readonly cwd: string;
}

export interface Command {
    readonly summary: string;
    readonly usage: string;
    /** lines printed under the usage line by `zen help <command>` */
    readonly details?: readonly string[];
    /** printed instead of the `zen` banner, so the sub-brand shows through */
    readonly banner?: BannerText;
    /**
     * True when this invocation's stdout is the answer rather than a report on
     * it. The banner is then held back rather than dropped: if the run turns
     * out to need a prompt, someone is there to see it, and it appears.
     */
    readonly quiet?: (args: readonly string[]) => boolean;
    /**
     * Answers `--help` itself, for a command whose arguments select a page the
     * frame cannot see. Without it the frame prints this command's own page.
     */
    help?(ctx: Context): Promise<void> | void;
    /**
     * Tab completion past the command's name, for a command whose words the
     * usage line cannot describe. `args` is what came after the name, without
     * `cur`, the word being completed.
     */
    complete?(args: readonly string[], cur: string, cwd: string): Promise<Candidate[]>;
    /**
     * The programs outside Node this command runs on, for `zen version`. A
     * command in another package names its own, since only it knows them.
     */
    subsystems?(): Promise<Subsystem[]>;
    run(ctx: Context): Promise<void>;
}

export interface Subsystem {
    readonly name: string;
    /** absent when it is not there */
    readonly version?: string;
    /** where it was found, or what to do about it */
    readonly detail?: string;
}
