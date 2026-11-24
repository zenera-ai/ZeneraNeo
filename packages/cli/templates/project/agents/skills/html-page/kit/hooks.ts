import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

/** Anything thrown, as an Error with a message to show. */
export function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

export interface Call<T> {
    /** the last result; undefined until the first one arrives */
    data: T | undefined;
    /** what the last call threw, until the next one succeeds */
    error: Error | undefined;
    loading: boolean;
    /** call again, e.g. after a change was saved */
    reload: () => Promise<void>;
    /** replace the data in place, e.g. with what a save returned */
    setData: (data: T) => void;
}

/**
 * Calls `fn` when the component mounts and whenever `deps` change, and keeps its result,
 * error and loading state. A slower earlier call never overwrites a later one.
 *
 *   const list = useCall(() => items.list_items({ show }), [show]);
 */
export function useCall<T>(fn: () => Promise<T>, deps: DependencyList = []): Call<T> {
    const [data, setData] = useState<T>();
    const [error, setError] = useState<Error>();
    const [loading, setLoading] = useState(true);
    const latest = useRef(0);
    const fnRef = useRef(fn);
    fnRef.current = fn;

    const reload = useCallback(async () => {
        const id = ++latest.current;
        setLoading(true);
        try {
            const value = await fnRef.current();
            if (id === latest.current) {
                setData(() => value);
                setError(undefined);
            }
        } catch (err) {
            if (id === latest.current) setError(toError(err));
        } finally {
            if (id === latest.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void reload();
        return () => {
            latest.current++;
        };
    }, deps);

    const set = useCallback((value: T) => setData(() => value), []);
    return { data, error, loading, reload, setData: set };
}

/** A JSON file by its path relative to the page. */
export async function fetchJson<T = any>(file: string): Promise<T> {
    const res = await fetch(file);
    if (!res.ok) throw new Error(`${file}: ${res.status} ${res.statusText}`.trim());
    return (await res.json()) as T;
}

/** A JSON file beside the page, `data.json` by default, as a useCall. */
export function useData<T = any>(file = 'data.json'): Call<T> {
    return useCall(() => fetchJson<T>(file), [file]);
}

export interface Action<A extends unknown[]> {
    /** runs the action; resolves true when it (and `after`) succeeded */
    run: (...args: A) => Promise<boolean>;
    busy: boolean;
    error: Error | undefined;
    clear: () => void;
}

/**
 * A change the user makes: runs `fn`, then `after` (usually a list's reload), keeping busy and
 * error state for the button and the error box.
 *
 *   const add = useAction((title: string) => items.add_item({ title }), list.reload);
 *   <button disabled={add.busy} onClick={() => add.run(text)}>Add</button>
 */
export function useAction<A extends unknown[]>(
    fn: (...args: A) => Promise<unknown>,
    after?: () => unknown,
): Action<A> {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<Error>();
    const fnRef = useRef(fn);
    fnRef.current = fn;
    const afterRef = useRef(after);
    afterRef.current = after;

    const run = useCallback(async (...args: A) => {
        setBusy(true);
        setError(undefined);
        try {
            await fnRef.current(...args);
            await afterRef.current?.();
            return true;
        } catch (err) {
            setError(toError(err));
            return false;
        } finally {
            setBusy(false);
        }
    }, []);
    const clear = useCallback(() => setError(undefined), []);
    return { run, busy, error, clear };
}

function hashParams(): URLSearchParams {
    return new URLSearchParams(location.hash.replace(/^#/, ''));
}

/**
 * A piece of view state kept in the page's `#hash` (`#tab=orders&id=7`), so a reload or a
 * shared link opens the same view. Storage is not available to pages; this is.
 */
export function useHashState(key: string, initial = ''): [string, (value: string) => void] {
    const [value, setValue] = useState(() => hashParams().get(key) ?? initial);
    useEffect(() => {
        const sync = () => setValue(hashParams().get(key) ?? initial);
        window.addEventListener('hashchange', sync);
        return () => window.removeEventListener('hashchange', sync);
    }, [key, initial]);
    const set = useCallback(
        (next: string) => {
            const params = hashParams();
            if (next === initial) params.delete(key);
            else params.set(key, next);
            location.hash = params.toString();
            setValue(next);
        },
        [key, initial],
    );
    return [value, set];
}

const DARK = '(prefers-color-scheme: dark)';

/** Whether the page is shown in dark mode; follows the system as it changes. */
export function useDarkMode(): boolean {
    const [dark, setDark] = useState(
        () => typeof matchMedia === 'function' && matchMedia(DARK).matches,
    );
    useEffect(() => {
        const media = matchMedia(DARK);
        const sync = () => setDark(media.matches);
        media.addEventListener('change', sync);
        return () => media.removeEventListener('change', sync);
    }, []);
    return dark;
}
