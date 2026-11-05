import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryFs, localFs } from '../src/index.ts';
import { describeFsDriver } from '../src/testing.ts';

// The two drivers this package ships, held to the contract it exports for
// everyone else's.
describeFsDriver('this machine’s disk', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-fs-contract-')));
    return { fs: localFs, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
});

describeFsDriver('a filesystem in memory', () => ({
    fs: new InMemoryFs().dir('/workspace'),
    root: '/workspace',
}));
