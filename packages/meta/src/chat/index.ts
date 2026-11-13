// packages/meta/src/chat/index.ts
//
// `@zenera/meta/chat`: the meta agent as a conversation, for a host that draws its own chat (no terminal, no Ink).
// Main: `openMetaChat`, and the event and permission types it speaks in.
// Used by: hosts such as the ZeneraLite project manager; `zen meta chat` itself goes through `chat/run.ts`.

export { openMetaChat, type MetaChat, type MetaChatOptions } from './open.ts';
export { EFFORTS, type ChatEvent, type Connect, type TurnResult } from './session.ts';
export type { Answer, Described } from './permissions.ts';
export type { MetaCall } from '../tokens.ts';
