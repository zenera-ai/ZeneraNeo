import type { Provider } from '@zenera/engine';
import { formatModelRef, splitModelRef } from '@zenera/neo';

// ---------------------------------------------------------------------------
// Model refs as people type them
//
// `vertex/gemini-3.8-flash`, or the older `openai:gpt-5.6-sol`. Read by
// `zen inspect ask` and by `zen meta`, so it lives with neither; the grammar
// itself is the library's (`splitModelRef`), so the two cannot disagree on
// where a provider ends.
// ---------------------------------------------------------------------------

export const PROVIDER_NAMES: ReadonlySet<string> = new Set([
    'openai',
    'anthropic',
    'google',
    'vertex',
    'openrouter',
]);

const isProviderName = (name: string): boolean => PROVIDER_NAMES.has(name);

/**
 * `vertex/gemini-3.8-flash` splits; `gpt-5.6-sol` does not. Only a known
 * provider counts as a prefix, because `meta-llama/Llama-3-8B` is also a
 * perfectly good bare id on an endpoint that speaks publisher names.
 *
 * Without a project's registry there is no default provider to weigh a slash
 * against, so this is the plain reading; `ModelRegistry.parse` is the one a
 * run uses.
 */
export function splitRef(ref: string): { provider?: Provider; id: string } {
    const parts = splitModelRef(ref, isProviderName);
    return parts.provider && isProviderName(parts.provider)
        ? { provider: parts.provider as Provider, id: parts.model }
        : { id: ref };
}

/**
 * The ref `zen models` prints for a catalog row: `provider/id`, with Claude on
 * Vertex under its publisher, as `ModelRegistry.refOf` writes it.
 */
export function catalogRef(provider: Provider, id: string): string {
    const model = provider === 'vertex' && /^claude-/.test(id) ? `anthropic/${id}` : id;
    return formatModelRef(provider, model, isProviderName);
}
