// packages/meta/src/chat/transcript.ts
//
// What the `zen meta chat` screen shows, as data: the finished rows (scrolled away by Ink's `Static`) and the
// message still streaming in. Pure, so the screen's logic is tested without drawing it.
// Main: `fold(view, event)`, which applies one `ChatEvent`; also `said` (a row for something the screen itself
// says), `EMPTY` and the `Row`/`View` types.
// Used by: `chat/tui.tsx`, which folds every event the session reports and draws the result.

import { duration } from '../host.ts';
import type { ChatEvent } from './session.ts';

export type RowKind = 'you' | 'say' | 'answer' | 'tool' | 'fail' | 'warn' | 'error' | 'note';

export interface Row {
    key: number;
    kind: RowKind;
    text: string;
}

export interface View {
    rows: readonly Row[];
    /** the message being written, as it arrives */
    live: string;
    liveId?: string;
    next: number;
}

export const EMPTY: View = { rows: [], live: '', next: 0 };

export function said(view: View, kind: RowKind, text: string): View {
    return { ...view, rows: [...view.rows, { key: view.next, kind, text }], next: view.next + 1 };
}

export function fold(view: View, event: ChatEvent): View {
    switch (event.type) {
        case 'delta':
            return event.id === view.liveId
                ? { ...view, live: view.live + event.text }
                : { ...view, live: event.text, liveId: event.id };
        case 'message': {
            // The whole message replaces its pieces, so a missed delta costs nothing.
            const text = event.text.trim();
            const cleared = { ...view, live: '', liveId: undefined };
            return text ? said(cleared, event.tools > 0 ? 'say' : 'answer', text) : cleared;
        }
        case 'tool':
            return said(view, 'tool', [event.name, event.subject].filter(Boolean).join(' '));
        case 'tool-done':
            return event.ok ? view : said(view, 'fail', event.error ?? 'failed');
        case 'warn':
            return said(view, 'warn', event.text);
        case 'error':
            return said(view, 'error', event.text);
        case 'retry':
            return said(
                view,
                'warn',
                `${event.reason}: resuming in ${duration(event.waitMs)} (${event.attempt}/${event.of}) - Esc stops`,
            );
        case 'usage':
            return view;
    }
}
