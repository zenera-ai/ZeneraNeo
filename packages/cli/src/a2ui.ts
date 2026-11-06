// ---------------------------------------------------------------------------
// A2UI in an answer
//
// An agent that is told to answer with a user interface replies with a JSON
// array of A2UI v0.9 messages. Nothing marks that reply as different from any
// other text, so the check here is deliberately strict: an answer that merely
// *contains* JSON, or JSON of another shape, is prose and is drawn as prose.
// ---------------------------------------------------------------------------

export interface A2uiMessage {
    version: 'v0.9' | 'v0.9.1';
    [operation: string]: unknown;
}

/** The operations of the v0.9 server-to-client protocol. */
const OPERATIONS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];

const FENCE = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

const isA2UIMessage = (value: unknown): value is A2uiMessage => {
    const version = (value as { version?: unknown } | null)?.version;
    return (
        typeof value === 'object' &&
        (version === 'v0.9' || version === 'v0.9.1') &&
        OPERATIONS.some((operation) => operation in (value as object))
    );
};

/**
 * The A2UI v0.9 messages an answer consists of, or nothing when it is anything
 * else. Accepts a bare array, one message, `{ "messages": [...] }`, and any of
 * those inside a single code fence, which models add whatever they are told.
 */
export function parseA2ui(text: string): A2uiMessage[] | undefined {
    let body = text.trim();
    const fenced = FENCE.exec(body);
    if (fenced) {
        body = fenced[1]!.trim();
    }
    if (!body.startsWith('[') && !body.startsWith('{')) {
        return undefined;
    }
    let data: unknown;
    try {
        data = JSON.parse(body);
    } catch {
        return undefined;
    }
    const list = Array.isArray(data)
        ? data
        : isA2UIMessage(data)
          ? [data]
          : (data as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(list) || list.length === 0 || !list.every(isA2UIMessage)) {
        return undefined;
    }
    return list;
}
