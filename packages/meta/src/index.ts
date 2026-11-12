// packages/meta/src/index.ts
//
// The meta package's internal barrel: the launcher, model choice, prompts, relay, tokens, sink, wiring, dataset, finetune.
// Main: `export *` of those modules. Not a public entry point - the package exports only `./command`.
// Used by: `command.ts`, and the package's tests.

export * from './dataset/index.ts';
export * from './finetune/index.ts';
export * from './launch.ts';
export * from './model.ts';
export * from './prompts.ts';
export * from './relay.ts';
export * from './tokens.ts';
export * from './sink.ts';
export * from './wire.ts';
