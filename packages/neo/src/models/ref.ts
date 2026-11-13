// ---------------------------------------------------------------------------
// Model references
//
// One grammar, read the same way by the library, the CLI and the meta agent:
//
//     provider/id                     openai/gpt-5-mini
//                                     vertex/anthropic/claude-opus-5
//                                     openrouter/anthropic/claude-sonnet-5
//
// The first segment is always a provider name and everything after the first
// slash is the id as that provider spells it — slashes and colons included. It
// is also how Bifrost names a model, so the string in `agents.yaml`, the trace
// and the gateway's logs is the same one.
//
// Two older spellings are still read:
//
//     provider[/api]:id               openai:gpt-4o, openai/responses:o3
//     id                              gpt-4o — the registry's default provider
//
// The colon form stays the way to write an id the slash form cannot carry back
// (`openai:ft:gpt-4o:acme::a1b2`), and the only shorthand that names an api.
// ---------------------------------------------------------------------------

export const MODEL_APIS = ['chat', 'responses'] as const;

export type ModelRefForm = 'slash' | 'colon' | 'bare';

export interface ModelRefParts {
    provider?: string;
    /** colon form only: `openai/responses:o3` */
    api?: string;
    model: string;
    form: ModelRefForm;
}

/** What an api selector looks like, as opposed to a model name: `responses`, not `llama3`. */
const API_LIKE = /^[a-z]+$/;

/**
 * The syntax of a ref, without deciding whether its provider exists.
 *
 * `isProvider` decides whether a leading `name/` is a provider or the start of
 * an id: `openai/gpt-5-mini` splits, `meta-llama/Llama-3-8B` does not. The colon
 * form is recognised by its shape alone, so a typo in it still reaches the
 * caller as an unknown provider rather than as a strange model id.
 */
export function splitModelRef(ref: string, isProvider: (name: string) => boolean): ModelRefParts {
    const colon = ref.indexOf(':');
    if (colon > 0) {
        const head = ref.slice(0, colon).split('/');
        if (head.length === 1 || (head.length === 2 && API_LIKE.test(head[1]!))) {
            return { provider: head[0], api: head[1], model: ref.slice(colon + 1), form: 'colon' };
        }
    }
    const slash = ref.indexOf('/');
    if (slash > 0 && isProvider(ref.slice(0, slash))) {
        return { provider: ref.slice(0, slash), model: ref.slice(slash + 1), form: 'slash' };
    }
    return { model: ref, form: 'bare' };
}

/**
 * `provider/id`, unless that would read back as something else — a fine-tuned
 * `ft:gpt-4o:acme::a1b2` would, its `ft:` looking like an api — in which case
 * the colon form, which carries any id.
 */
export function formatModelRef(
    provider: string,
    model: string,
    isProvider: (name: string) => boolean,
): string {
    const slash = `${provider}/${model}`;
    const back = splitModelRef(slash, isProvider);
    return back.form === 'slash' && back.provider === provider && back.model === model
        ? slash
        : `${provider}:${model}`;
}
