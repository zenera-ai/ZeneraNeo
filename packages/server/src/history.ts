// GET /:tid - a chat so far, and the run going on it, if any. No engine, no lock, no model.
// The ended runs' logs replayed in order are the chat, with reasoning and subagents; the run
// still going is left out, its follower replays it. A thread from before run logs has only its
// saved trajectory, sent as AG-UI messages instead.
//   historyRouter(store)  - the route, for a ChatStore (sessions.ts)
//   toMessages     - a @zenera/neo trajectory as AG-UI messages (the trunk only)
import type { AGUIEvent, Message } from '@ag-ui/core';
import {
    FilePayloadStore,
    PayloadResolver,
    type AgentState,
    type TrajectoryNode,
} from '@zenera/neo';
import { Router } from 'express';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { clip, type Resolve } from './agui.ts';
import { readRunLog, threadRunLogs } from './runLog.ts';
import { currentRun } from './runs.ts';
import type { ChatStore } from './store.ts';

export async function toMessages(
    trajectory: TrajectoryNode[],
    resolve: Resolve,
): Promise<Message[]> {
    const out: Message[] = [];
    for (const node of trajectory) {
        if (node.type === 'user_input' && !node.synthetic) {
            const texts = await Promise.all(
                node.content.flatMap((part) => (part.type === 'text' ? [resolve(part.text)] : [])),
            );
            const content = texts.join('\n');
            if (content) out.push({ id: node.id, role: 'user', content });
        } else if (node.type === 'llm_call') {
            const text = await resolve(node.text);
            const toolCalls = await Promise.all(
                node.toolCalls.map(async (call) => ({
                    id: call.callId,
                    type: 'function' as const,
                    function: { name: call.name, arguments: await resolve(call.args) },
                })),
            );
            if (!text.trim() && toolCalls.length === 0) continue;
            out.push({
                id: node.id,
                role: 'assistant',
                name: node.agent,
                ...(text.trim() ? { content: text } : {}),
                ...(toolCalls.length ? { toolCalls } : {}),
            });
        } else if (node.type === 'tool_result') {
            out.push({
                id: node.id,
                role: 'tool',
                toolCallId: node.callId,
                content: clip(await resolve(node.result)),
                ...(node.isError ? { error: 'the tool reported an error' } : {}),
            });
        }
    }
    return out;
}

export function historyRouter(store: ChatStore): Router {
    const router = Router();
    router.get('/:tid', async (req, res) => {
        const t = store.thread(req);
        const running = currentRun(t);
        const logs = await threadRunLogs(store.runsDir(t));
        if (logs.length > 0) {
            const events: AGUIEvent[] = [];
            for (const log of logs) {
                if (log.runId !== running?.runId) events.push(...(await readRunLog(log.file)));
            }
            res.json({ threadId: t.id, messages: [], events, running });
            return;
        }
        const session = store.existingSession(t);
        if (!session || !existsSync(session.state)) {
            res.json({ threadId: t.id, messages: [], events: [], running });
            return;
        }
        const state = JSON.parse(await readFile(session.state, 'utf8')) as AgentState;
        const payloads = new PayloadResolver(
            new FilePayloadStore({ dir: session.blobs, id: 'file' }),
        );
        const messages = await toMessages(state.trajectory, (p) => payloads.get(p));
        res.json({ threadId: t.id, messages, events: [], running });
    });
    return router;
}
