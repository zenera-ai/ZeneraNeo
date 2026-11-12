import { vertexEndpoint } from '@zenera/neo';
import { GoogleAuth } from 'google-auth-library';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Claude on Vertex, for copilot
//
// Vertex serves Claude only at `publishers/anthropic/models/<id>:rawPredict`,
// with the model in the path and its own `anthropic_version` in the body.
// Copilot's Anthropic client posts to `<base>/v1/messages` and has no hook to
// change that, so `zen meta` runs this relay on loopback for the session and
// does the rewrite the runtime's `rawPredictFetch` does.
// ---------------------------------------------------------------------------

export interface Relay {
    url: string;
    close(): Promise<void>;
}

export interface RelaySpec {
    /** the per-session secret copilot must present; anything else on the machine is refused */
    key: string;
    /** `https://…/v1/projects/<project>/locations/<location>` */
    base: string;
    token: () => Promise<string>;
}

export interface VertexRelaySpec {
    key: string;
    project: string;
    location: string;
    keyFile: string;
}

const VERTEX_VERSION = 'vertex-2023-10-16';

export async function startVertexRelay(spec: VertexRelaySpec): Promise<Relay> {
    const auth = new GoogleAuth({
        keyFile: spec.keyFile,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const at = vertexEndpoint({
        project: spec.project,
        location: spec.location,
        token: async () => {
            const token = await auth.getAccessToken();
            if (!token) {
                throw new Error(`${spec.keyFile} minted no access token`);
            }
            return token;
        },
    });
    return startRelay({ key: spec.key, base: at.base, token: at.token });
}

export async function startRelay(spec: RelaySpec): Promise<Relay> {
    const server = createServer((req, res) => {
        relay(spec, req, res).catch((err: unknown) => {
            fail(res, 502, 'api_error', `relay to vertex: ${(err as Error).message}`);
        });
    });
    await new Promise<void>((done, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', done);
    });
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}

async function relay(spec: RelaySpec, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(spec.key, req)) {
        fail(res, 401, 'authentication_error', 'not this session’s relay key');
        return;
    }
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    const counting = path === '/v1/messages/count_tokens';
    if (req.method !== 'POST' || (path !== '/v1/messages' && !counting)) {
        fail(res, 404, 'not_found_error', `vertex serves no ${req.method} ${path} for Claude`);
        return;
    }
    let parsed: { model?: string; stream?: boolean };
    try {
        parsed = JSON.parse(await readBody(req)) as typeof parsed;
    } catch {
        fail(res, 400, 'invalid_request_error', 'the body is not JSON');
        return;
    }
    const { model, ...rest } = parsed;
    if (!model) {
        fail(res, 400, 'invalid_request_error', 'no model in the body');
        return;
    }
    const url = counting
        ? `${spec.base}/publishers/anthropic/models/count-tokens:rawPredict`
        : `${spec.base}/publishers/anthropic/models/${encodeURIComponent(model)}:${rest.stream ? 'streamRawPredict' : 'rawPredict'}`;
    const body = counting ? parsed : { ...rest, anthropic_version: VERTEX_VERSION };

    const abort = new AbortController();
    res.on('close', () => {
        if (!res.writableFinished) {
            abort.abort();
        }
    });
    const beta = req.headers['anthropic-beta'];
    const upstream = await fetch(url, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${await spec.token()}`,
            'content-type': 'application/json',
            ...(typeof beta === 'string' ? { 'anthropic-beta': beta } : {}),
        },
        body: JSON.stringify(body),
        signal: abort.signal,
    });
    res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    if (!upstream.body) {
        res.end();
        return;
    }
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
        .on('error', () => res.destroy())
        .pipe(res);
}

function authorized(key: string, req: IncomingMessage): boolean {
    const header = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /i, '');
    const given = Buffer.from(typeof header === 'string' ? header : '');
    const wanted = Buffer.from(key);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((done, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** Anthropic's error shape, so copilot reports it as it would a direct call. */
function fail(res: ServerResponse, code: number, type: string, message: string): void {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}
