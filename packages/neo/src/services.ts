import { PayloadResolver, type PayloadStore } from './payload.ts';
// The composition root is the one place in the core allowed to name a backend:
// it has to fall back to something when the caller supplies no store.
import { systemClock, type IdClock } from './ids.ts';
import type { WorkspaceFiles } from './memory/files.ts';
import type { MemoryIndex } from './memory/index.ts';
import { InMemoryPayloadStore } from './payload-stores/in-memory.ts';
import type { SkillProvider } from './skills.ts';

/**
 * The I/O the kernel is not allowed to do itself: payload resolution, the
 * memory graph and skill catalogs. Held by the driver (runner or Temporal
 * activity) and handed to the kernel and to tools explicitly, so nothing reads
 * ambient state.
 *
 * There is one memory, not a map of them: an agent sees a slice of the single
 * graph through its `sees` mask, which is what makes a memory shareable
 * between agents at all.
 */
export class Services {
    readonly payloads: PayloadResolver;
    /** the one memory graph, when the project has one */
    readonly memory?: MemoryIndex;
    /**
     * The agent's workspace, for the two memory tools that cross into it:
     * remembering a file reads from it, and copying a remembered file back
     * writes to it — memory is never mounted, so that copy is the only way its
     * files reach the sandbox. Supplied by whoever built the workspace, because
     * only it knows the mounts. Without it both are refusals, not crashes.
     */
    readonly files?: WorkspaceFiles;
    /** the driver's clock, so a tool that stamps a node stays replayable */
    readonly clock: IdClock;
    readonly #skills = new Map<string, SkillProvider>();

    constructor(
        opts: {
            payloads?: PayloadResolver | PayloadStore;
            memory?: MemoryIndex;
            skills?: SkillProvider[];
            clock?: IdClock;
            files?: WorkspaceFiles;
        } = {},
    ) {
        const p = opts.payloads ?? new InMemoryPayloadStore();
        this.payloads = p instanceof PayloadResolver ? p : new PayloadResolver(p);
        this.memory = opts.memory;
        this.files = opts.files;
        this.clock = opts.clock ?? systemClock;
        for (const s of opts.skills ?? []) {
            this.#skills.set(s.id, s);
        }
    }

    skillProvider(id: string): SkillProvider {
        const p = this.#skills.get(id);
        if (!p) {
            throw new Error(`unknown skill provider: ${id} (known: ${[...this.#skills.keys()]})`);
        }
        return p;
    }

    hasMemory(): boolean {
        return this.memory !== undefined;
    }

    hasSkills(id: string): boolean {
        return this.#skills.has(id);
    }
}
