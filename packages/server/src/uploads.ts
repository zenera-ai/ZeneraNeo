// Files attached to a chat message. Each file is uploaded on its own, before the message, and waits
// in the session's staging folder (.data/uploads, outside the agent's view); the message names the
// ones it carries, and starting its run moves them into the workspace (runs.ts, commitUploads).
//   uploadsRouter(store, refusing) - POST /:tid/uploads?name=&type= (the raw file, sent as
//                                    application/octet-stream: a JSON body would be parsed away),
//                                    DELETE /:tid/uploads/:id (a file taken off before sending)
//   uploadIdOf    - the upload a message part names: a media part whose source is a `file`
//                   handle this server issued
//   contentOf     - a sent message as the run log records it: its text, then a part per file,
//                   each pointing at where the agent finds it
//   uploadHttpError - an UploadError as an HTTP answer (413, 410 upload_gone, 400)
import type { ContentPart } from '@ag-ui/core';
import {
    discardUpload,
    MAX_UPLOAD_BYTES,
    stageUpload,
    sweepUploads,
    UploadError,
    type UploadedFile,
} from '@zenera/engine';
import { Router } from 'express';
import { HttpError } from './http.ts';
import type { ChatStore } from './store.ts';

/** Who issues the handles of uploaded files, in their parts' `source.provider`. */
export const UPLOAD_PROVIDER = 'zenera';

const MEDIA = new Set(['image', 'audio', 'video', 'document']);

export function uploadHttpError(err: unknown): unknown {
    if (!(err instanceof UploadError)) return err;
    const status = err.code === 'too_large' ? 413 : err.code === 'gone' ? 410 : 400;
    return Object.assign(new HttpError(status, err.message), {
        code: err.code === 'gone' ? 'upload_gone' : err.code,
    });
}

/** The upload id a part names, or undefined when it is no media part with a `file` source. */
export function uploadIdOf(part: unknown): string | undefined {
    const p = part as { type?: unknown; source?: { type?: unknown; value?: unknown } } | null;
    if (!p || typeof p.type !== 'string' || !MEDIA.has(p.type)) return undefined;
    return p.source?.type === 'file' && typeof p.source.value === 'string'
        ? p.source.value
        : undefined;
}

function kindOf(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
    const top = mimeType.split('/')[0];
    return top === 'image' || top === 'audio' || top === 'video' ? top : 'document';
}

/** A message as its run log records it: the text alone, or the text and a part per file. */
export function contentOf(text: string, files: readonly UploadedFile[]): string | ContentPart[] {
    if (!files.length) return text;
    return [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...files.map((f): ContentPart => ({
            type: kindOf(f.mimeType),
            source: { type: 'url', value: f.path, mimeType: f.mimeType },
            metadata: { name: f.name, size: f.size },
        })),
    ];
}

/**
 * `refusing` says why no new work is taken (the server stops or drains), or null. A store
 * without `uploads` takes no files: these routes answer 404 for it.
 */
export function uploadsRouter(store: ChatStore, refusing: () => string | null): Router {
    const router = Router();

    router.post('/:tid/uploads', async (req, res) => {
        const t = store.thread(req);
        if (!store.uploads) throw new HttpError(404, 'this chat takes no files');
        if (req.is('application/json')) {
            throw new HttpError(415, 'send the file as application/octet-stream');
        }
        const why = refusing();
        if (why) {
            res.set('Retry-After', '5');
            throw new HttpError(503, why);
        }
        const name = typeof req.query.name === 'string' ? req.query.name : '';
        if (!name.trim()) throw new HttpError(400, 'name the file: ?name=');
        const declared = Number(req.get('content-length'));
        if (declared > MAX_UPLOAD_BYTES) {
            throw uploadHttpError(new UploadError('too_large', 'the file is too large'));
        }
        // Over its storage quota, a user gets no new file either.
        await store.admit?.(t);
        const places = store.uploads(t);
        sweepUploads(places.staging);
        let upload;
        try {
            upload = await stageUpload(places.staging, req, {
                name,
                mimeType: typeof req.query.type === 'string' ? req.query.type : undefined,
            });
        } catch (err) {
            throw uploadHttpError(err);
        }
        store.changed?.(t, 'changed');
        res.status(201).json({
            id: upload.id,
            name: upload.name,
            size: upload.size,
            mimeType: upload.mimeType,
        });
    });

    router.delete('/:tid/uploads/:id', (req, res) => {
        const t = store.thread(req);
        if (!store.uploads) throw new HttpError(404, 'this chat takes no files');
        const session = store.existingSession(t);
        if (session && discardUpload(store.uploads(t).staging, String(req.params.id))) {
            store.changed?.(t, 'changed');
        }
        res.status(204).end();
    });

    return router;
}
