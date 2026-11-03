// Run as a child process by memory-sqlite.test.ts: one writer among several.
// Usage: node memory-writer.ts <dir> <prefix> <commits, 0 for until killed>
import { MemoryStore } from '../src/memory/store.ts';

const [dir, prefix, many] = process.argv.slice(2);
const limit = Number(many);
const at = '2026-01-01T00:00:00.000Z';

const store = await MemoryStore.open(dir!);
for (let i = 0; limit === 0 || i < limit; i++) {
    store.write(() => {
        const id = `${prefix}-${i}`;
        store.graph.add({ id, kind: 'fact', text: `${prefix} wrote ${i}`, audience: ['*'] }, at);
        if (i > 0) {
            store.graph.link(`${prefix}-${i - 1}`, id, 'INFORMED', at);
        }
    });
    process.stdout.write(`${i}\n`);
}
store.release();
