import * as Projects from '@zenera/engine';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// What a completion offers
//
// Shared by the engine in `complete.ts` and by a command that knows more
// about its own words than the engine can, so neither has to import the other.
// ---------------------------------------------------------------------------

export interface Candidate {
    value: string;
    description?: string;
}

/** Candidates the word being typed is a prefix of. */
export const matching = (found: readonly Candidate[], prefix: string): Candidate[] =>
    found.filter((c) => c.value.startsWith(prefix));

/** Registered projects whose directory is still there. */
export async function projectNames(): Promise<Candidate[]> {
    try {
        const registry = await Projects.Registry.open();
        return registry.entries
            .filter((e) => existsSync(e.path))
            .map((e) => ({ value: e.name, description: e.path }));
    } catch {
        return [];
    }
}
