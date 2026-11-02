// The ES-module face of index.cjs, so there is one implementation.
//
// `import 'zenera'` only resolves from a directory with this package in a
// node_modules above it — ES modules do not search $HOME/.node_modules the way
// `require` does. Anywhere else, import it by path:
//
//     import { identity } from '/home/agent/.node_modules/zenera/index.mjs';
import { createRequire } from 'node:module';

const lib = createRequire(import.meta.url)('./index.cjs');

export const identity = lib.identity;
export const requireIdentity = lib.requireIdentity;
export const NoIdentityError = lib.NoIdentityError;
export default lib;
