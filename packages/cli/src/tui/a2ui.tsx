import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { A2uiSurface, basicCatalog } from '@evanyu/a2ui-ink/v0_9';
import React from 'react';
import type { A2uiMessage } from '../a2ui.ts';

// ---------------------------------------------------------------------------
// An agent's user interface, drawn in the terminal
//
// Loaded by a dynamic import the first time an answer turns out to be A2UI, so
// the protocol library costs nothing to a session that never sees one.
// ---------------------------------------------------------------------------

/** The renderer's own type for one surface, so the app never imports the library. */
export type Surface = React.ComponentProps<typeof A2uiSurface>['surface'];

/** What a button or input sends back: the library's action, passed on as it is. */
export type Action = Parameters<NonNullable<ConstructorParameters<typeof MessageProcessor>[1]>>[0];

/**
 * The first surface the messages describe. Throws when the library rejects
 * them — it validates strictly, so an unknown property is an error — and the
 * caller falls back to showing the answer as text.
 */
export function openSurface(
    messages: readonly A2uiMessage[],
    onAction: (action: Action) => void,
): Surface {
    const processor = new MessageProcessor([basicCatalog], async (action) => onAction(action));
    processor.processMessages([...messages] as unknown as Parameters<
        typeof processor.processMessages
    >[0]);
    const surface = [...processor.model.surfacesMap.values()][0];
    if (!surface) {
        throw new Error('the messages did not create a surface');
    }
    return surface;
}

export function A2uiView({ surface }: { surface: Surface }): React.ReactElement {
    return <A2uiSurface surface={surface} />;
}
