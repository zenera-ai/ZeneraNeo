import type { StreamDelta } from './events.ts';
import type { Message, TokenUsage, ToolCall, ToolSchema } from './types.ts';

// ---------------------------------------------------------------------------
// Model abstraction
// ---------------------------------------------------------------------------

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

export interface ModelRequest {
    system?: string;
    messages: Message[];
    tools: ToolSchema[];
    toolChoice?: 'auto' | 'required' | 'none';
    signal?: AbortSignal;
}

export interface ModelResponse {
    text: string;
    /** reasoning chain, when the provider returns one */
    thinking?: string;
    toolCalls: ToolCall[];
    usage?: TokenUsage;
    stopReason?: StopReason;
}

export interface Model {
    readonly id: string;
    /**
     * The ref that names this model again — `openai/gpt-5-mini` — when it was
     * built from one. `id` is only what goes on the wire, and has lost which
     * provider that was.
     */
    readonly ref?: string;
    generate(req: ModelRequest): Promise<ModelResponse>;
    /** optional: non-streaming models simply never produce deltas */
    stream?(req: ModelRequest, onDelta: (d: StreamDelta) => void): Promise<ModelResponse>;
}
