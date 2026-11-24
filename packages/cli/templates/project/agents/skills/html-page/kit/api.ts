/*
 * Calls the functions of the page's *.api.py files.
 *
 *   interface ItemsApi {
 *       list_items(args?: { show?: string }): Promise<Item[]>;
 *       add_item(args: { title: string }): Promise<Item>;
 *   }
 *   const items = api<ItemsApi>('api/items');      // api/items.api.py, relative to the page
 *   const list = await items.list_items();          // list_items()
 *   await items.add_item({ title: 'Milk' });        // add_item(title="Milk")
 *
 * Each call is a POST of the arguments as JSON to `<file>/<function>`. It resolves with what the
 * function returned, or rejects with an ApiError: `.status` (0 when the server could not be
 * reached) and `.message` (the function's HttpError message, or what went wrong).
 * A server still starting (503) or busy (429) is waited for and asked again, up to 3 times.
 */

export class ApiError extends Error {
    readonly status: number;
    readonly body: unknown;

    constructor(message: string, status: number, body?: unknown) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

/** What `api()` gives without an interface: any function name, any result. */
export type AnyApi = Record<string, (args?: Record<string, unknown>) => Promise<any>>;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One call of `name` in `file` (relative to the page, without `.api.py`). */
export async function call<T = unknown>(file: string, name: string, args?: object): Promise<T> {
    const url = `${String(file).replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
    for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
            // text/plain keeps this a "simple" request: the sandboxed page has no origin, and a
            // JSON content type would need a CORS preflight the app's host does not answer.
            res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'text/plain;charset=UTF-8', accept: 'application/json' },
                body: JSON.stringify(args ?? {}),
            });
        } catch (err) {
            throw new ApiError(`${name}: the app's server could not be reached`, 0, err);
        }
        if ((res.status === 503 || res.status === 429) && attempt < 3) {
            const seconds = Number(res.headers.get('retry-after')) || 2 * (attempt + 1);
            await sleep(Math.min(seconds, 10) * 1000);
            continue;
        }
        const text = await res.text();
        let body: unknown = null;
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
        }
        if (!res.ok) {
            const error =
                body && typeof body === 'object' && 'error' in body ? String(body.error) : '';
            const message =
                error ||
                (typeof body === 'string' && body ? body.slice(0, 300) : '') ||
                `${name} failed (${res.status})`;
            throw new ApiError(message, res.status, body);
        }
        return body as T;
    }
}

/**
 * The functions of one .api.py file, by its path relative to the page without `.api.py`.
 * Give it an interface of the functions to have their arguments and results checked.
 */
export function api<T extends object = AnyApi>(file: string): T {
    return new Proxy(
        {},
        {
            get(_, name) {
                // `then` too: an object returned from an async function must not look like a promise.
                if (typeof name !== 'string' || name === 'then') return undefined;
                return (args?: object) => call(file, name, args);
            },
        },
    ) as T;
}
