# Terminal display width

The repainting stream calls `windowOf` in `packages/cli/src/tui/app.tsx`.
Before this change, `wrap` in `packages/cli/src/tui/wrap.ts` used UTF-16
lengths for terminal columns. For example, `wrap('你好世界你好', 4)`
returned `['你好世界', '你好']`: its first row occupies eight columns in
Ink's width model, although the caller allowed four. Counting that as one
row understates the frame height.

## Change

Use `string-width` (the same major version Ink uses) for display columns,
and `Intl.Segmenter` for grapheme boundaries. Long words break between
complete graphemes; word spacing and ASCII wrapping retain their existing
behavior. `clip` reserves one column for its ellipsis. In a one-column
`wrap` call, an otherwise unrepresentable wide grapheme becomes U+FFFD,
rather than overflowing or being split. The streaming window retains the
complete grapheme intersecting its tail cut. Table padding joins adjacent
spans before measuring, and code/table box sizing uses display columns.

The follow-up also covers the models browser's table: IDs determine their
column width in display columns; `padEndCols`/`padStartCols` align the ID,
publisher, role, context and price fields and headers. The production row is
a pure `ModelTableRow` component so a deterministic Ink render can exercise
the actual formatting path.

## Reproduction

Node 26.9.0; upstream base `395c05293aeb10a49f2ec2bfc84f6c97a3ff9cde`.
No model, sandbox container, provider key or random seed is needed.

```sh
npm install
node node_modules/vitest/vitest.mjs run packages/cli/test/display-width.test.ts
npm run typecheck
```

The original nine tests were also run against a temporary copy of the upstream
implementation: eight failed and the ASCII compatibility test passed. At the initial commit, all nine passed. Failures covered CJK overflow, grapheme splitting,
clipping, the streaming window, table alignment and code-box sizing.

## Full checks

`npm run typecheck`, `npx tsc -p tsconfig.json --noEmit` and
`npm run format:check` passed. The complete offline suite passed with
121 files, 2,424 tests passing and two skipped after the follow-up:

```sh
env -u OPENROUTER_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
    -u GOOGLE_API_KEY -u GEMINI_API_KEY \
    npm test -- --exclude '**/live-*' --maxWorkers=2 --testTimeout=30000
```

The initial default-concurrency run failed: seven test timeouts and one
Gym embedding assertion affected by an inherited provider key. A subsequent
run with two workers but the original environment also encountered a timeout
and an unrelated concurrent SQLite writer failure; it was stopped in favor
of the isolated run above. No test configuration or production behavior was
changed to hide these outcomes. Live provider and Linux bubblewrap tests
were not run on this macOS host.

## Follow-up checks and mutation

`model-layout.test.ts` renders five production model rows with CJK IDs and
publishers, emoji graphemes, combining marks and ASCII. All rows have the
same display width; role starts at column 24 and context at column 33
(zero-based). ASCII rows are characterized byte-for-byte, with and without
the publisher column.

Mutation: replace the two `padEndCols(clip(...), width)` expressions in
`models.tsx` with `clip(...).padEnd(width)`, then run:

```sh
node node_modules/vitest/vitest.mjs run packages/cli/test/model-layout.test.ts
```

The mutation exits 1: one test fails and two pass. The rendered Unicode rows
have five different widths instead of one; the ASCII check still passes.
Restoring the two column pads and rerunning exits 0: all three tests pass.

A seeded printable-ASCII comparison against `0984871` also passed 14,403
byte-for-byte cases for `term.cut`, `term.pad`, `term.table`, `wrapSpans` and
banner output (seed 53, terminal widths 1–24, banner widths 40/80/120).
This is bounded evidence, not a claim about every input or terminal.

## CLI audit

A source-line audit used:

```sh
git grep -n -E 'padEnd|padStart|\.length|\.slice\(' 0984871 -- packages/cli/src
rg -n 'padEnd|padStart|\.length|\.slice\(' packages/cli/src
```

The baseline has 586 matching lines. The follow-up corrects variable-text
width arithmetic at these sites:

- `tui/models.tsx`: model/provider field widths, padding, headers, numeric
  alignment and model detail labels.
- `tui/markdown.ts`: styled word widths, grapheme-safe splitting across span
  boundaries, prefix widths and list continuation indent.
- `term.ts`: shared ANSI table widths/padding and SGR-aware grapheme clipping.
- `resources.ts`: styled resource-field padding, note placement and
  project/container-name clipping. Whitespace-preserving clipping keeps
  existing ASCII names intact.
- `tui/app.tsx`: activity subject budgets, prompt label widths, branch-box
  rules and activity row measurements.
- `banner.ts`: art width and subtitle centering.
- `commands/cache.ts`, `commands/memory.ts`, `commands/inspect.ts`: cache
  preview clipping, memory table remaining width, and panel title width.

Other matching lines were checked as array lengths/windows, parser/path/URL
coordinates, emptiness checks, data-retention/record budgets, keyboard
editing, or fixed ASCII labels/numeric formatting. They retain their own
units. Remaining `word.length` in styled Markdown is a stored display-column
count, not JavaScript string length. The complete before/after line-by-line
audit and raw red/green logs accompany the local review bundle.

## Limits

- Widths follow `string-width`, not measurements from an interactive terminal.
  Fonts, terminal configuration and Unicode versions can disagree, including
  VS16 emoji such as ❤️, ZWJ sequences and East Asian ambiguous characters.
  Ambiguous characters use the dependency's default narrow setting.
- Ink virtual rendering tests actual model-row components but does not prove
  the absence of repaint artifacts in every terminal emulator. Live-provider
  and Linux bubblewrap tests were not run on this macOS host.
- `term.cut` handles its existing SGR style-code contract. Arbitrary OSC
  sequences, tabs, cursor motion and untrusted control-code sanitization are
  not added here. Plain-text helpers still expect text without ANSI escapes
  or cursor controls.
- Streaming retention remains an approximate code-unit budget. A long
  combining sequence can exceed it; high code-unit-per-column text can
  underfill a requested window. Segmentation is not promised constant-time.
- Search-field backspace semantics, record/Markdown/Mermaid character budgets
  and parser offsets are not terminal-width operations and were not changed.
  Oversized prefixes or nonpositive terminal widths are not covered by the
  printable-ASCII characterization.

## Assistance

OpenAI Codex prepared the implementation, regression tests and this report,
and executed the checks. This follow-up was prepared with Codex in response
to Copilot's model-table finding and user-supplied Claude guidance. No claim
of unaided authorship is made.
