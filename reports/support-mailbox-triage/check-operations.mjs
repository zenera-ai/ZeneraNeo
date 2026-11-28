// Checks the API claims in SPECIFICATION.md against the two OpenAPI files.
// Run from the repository root: node reports/support-mailbox-triage/check-operations.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const specs = join(here, '..', '..', 'examples', 'mock-apis', 'specs');

// operationId -> { method, path, file }
const operations = new Map();
for (const file of ['mail.yaml', 'calendar.yaml']) {
    const doc = parse(readFileSync(join(specs, file), 'utf8'));
    for (const [path, item] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(item)) {
            if (op?.operationId) {
                operations.set(op.operationId, { method: method.toUpperCase(), path, file });
            }
        }
    }
}

// The table under "Tools and boundaries": | `op` | API | yes/no | agent |
const spec = readFileSync(join(here, 'SPECIFICATION.md'), 'utf8');
const rows = [...spec.matchAll(/^\|\s*`(\w+)`\s*\|[^|]*\|\s*(\*\*yes\*\*|no)\s*\|/gm)];
if (rows.length === 0) {
    console.error('no operations table found in SPECIFICATION.md');
    process.exit(1);
}

let failed = false;
const claimedWrites = new Set();
for (const [, id, writes] of rows) {
    if (!operations.has(id)) {
        console.error(`not in the OpenAPI files: ${id}`);
        failed = true;
    }
    if (writes === '**yes**') {
        claimedWrites.add(id);
    }
}

// POST, PUT, PATCH and DELETE change something, except queryFreeBusy, which is
// a POST only because its query is a body.
const readOnlyPosts = new Set(['queryFreeBusy']);
const actualWrites = new Set(
    [...operations]
        .filter(([id, op]) => op.method !== 'GET' && !readOnlyPosts.has(id))
        .map(([id]) => id),
);

const same =
    claimedWrites.size === actualWrites.size &&
    [...claimedWrites].every((id) => actualWrites.has(id));
if (!same) {
    console.error(`writes in the spec: ${[...claimedWrites].sort().join(', ')}`);
    console.error(`writes in the APIs: ${[...actualWrites].sort().join(', ')}`);
    failed = true;
}

console.log(
    `${rows.length} operations checked, ${operations.size} in the APIs, writes: ${[...actualWrites].sort().join(', ')}`,
);
process.exit(failed ? 1 : 0);
