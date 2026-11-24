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

## Reproduction

Node 26.9.0; upstream base `395c05293aeb10a49f2ec2bfc84f6c97a3ff9cde`.
No model, sandbox container, provider key or random seed is needed.

```sh
npm install
node node_modules/vitest/vitest.mjs run packages/cli/test/display-width.test.ts
npm run typecheck
```

The final nine tests were also run against a temporary copy of the upstream
implementation: eight failed and the ASCII compatibility test passed. With
the change, all nine pass. Failures covered CJK overflow, grapheme splitting,
clipping, the streaming window, table alignment and code-box sizing.

## Full checks

`npm run typecheck`, `npx tsc -p tsconfig.json --noEmit` and
`npm run format:check` passed. The complete offline suite passed with
120 files, 2,417 tests passing and two skipped:

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

## Limits

- This fixes the plain-text measurement helpers and their streaming callers.
  It does not replace the separate styled `wrapSpans` renderer in
  `tui/markdown.ts`, ANSI-aware `cut` in `term.ts`, or every `.length` in
  `app.tsx`. Settled styled output still needs a separate audit.
- These are deterministic width-model tests, not an interactive emulator
  recording proving the absence of terminal artifacts on every terminal.
- East Asian ambiguous characters follow the dependency's default narrow
  setting. Terminal fonts, emoji support and Unicode versions can disagree.
- Plain-text helpers still expect text without ANSI escapes or terminal
  controls. Tabs and cursor movement are not expanded or sanitized here.
- The tail budget is approximate: a long combining sequence can exceed it,
  and text with many code units per column can underfill the requested
  window. This change avoids splitting the cluster; it does not redesign
  streaming retention or promise constant-time segmentation.

## Assistance

OpenAI Codex prepared the implementation, regression tests and this report,
and executed the checks. No claim of unaided authorship is made.
