// An app: a list kept in SQLite by api/items.api.py, with add, check off, filter and delete.
// Copy the whole folder, rename api/items.api.py to what it holds, and change both together.
import { useState } from 'react';
import {
    api,
    Card,
    ConfirmButton,
    Empty,
    ErrorBox,
    Loading,
    Page,
    Select,
    useAction,
    useCall,
} from '@page/kit';

// ---- The page: replace from here ----
// The functions of api/items.api.py as the page calls them: keep this in step with the Python.

type Show = 'all' | 'open' | 'done';

interface Item {
    id: number;
    title: string;
    done: boolean;
    created: string;
}

interface Me {
    id: string;
    name: string;
    role: string | null;
}

interface ItemsApi {
    me(): Promise<Me | null>;
    list_items(args: { show: Show }): Promise<Item[]>;
    add_item(args: { title: string }): Promise<Item>;
    set_done(args: { id: number; done: boolean }): Promise<Item>;
    remove_item(args: { id: number }): Promise<{ removed: number }>;
}

const items = api<ItemsApi>('api/items');

export const title = 'Items';
export const description = 'A list of items to add, check off and remove.';
export const previewAlt = 'A checklist with a box to add items and a filter';

const SHOW = [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open' },
    { value: 'done', label: 'Done' },
];

export default function App() {
    const [show, setShow] = useState<Show>('all');
    const [text, setText] = useState('');

    // Who is signed in comes from the server (me() in api/items.api.py), never the page.
    const me = useCall(() => items.me(), []);
    const list = useCall(() => items.list_items({ show }), [show]);

    // Every change: call, then load the list again, so the page shows what is really saved.
    const add = useAction(async (title: string) => {
        await items.add_item({ title });
        setText('');
    }, list.reload);
    const setDone = useAction(
        (id: number, done: boolean) => items.set_done({ id, done }),
        list.reload,
    );
    const remove = useAction((id: number) => items.remove_item({ id }), list.reload);

    const submit = () => {
        const title = text.trim();
        if (title) void add.run(title);
    };
    const error = add.error ?? setDone.error ?? remove.error ?? list.error ?? me.error;

    return (
        <Page
            width="narrow"
            title={title}
            subtitle="Add, check off and remove items. Changes are saved."
            actions={me.data && <span className="muted">Signed in as {me.data.name}</span>}
        >
            <ErrorBox error={error} onRetry={list.error ? list.reload : undefined} />

            <Card>
                <div className="row">
                    <input
                        type="text"
                        placeholder="New item"
                        aria-label="New item"
                        maxLength={200}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && submit()}
                    />
                    <button
                        className="primary"
                        disabled={add.busy || !text.trim()}
                        onClick={submit}
                    >
                        Add
                    </button>
                    <Select
                        value={show}
                        options={SHOW}
                        onChange={(value) => setShow(value as Show)}
                    />
                </div>
            </Card>

            <Card>
                {list.loading && !list.data ? (
                    <Loading />
                ) : !list.data?.length ? (
                    <Empty>{show === 'all' ? 'Nothing here yet.' : `No ${show} items.`}</Empty>
                ) : (
                    <ul className="list">
                        {list.data.map((item) => (
                            <li key={item.id} className={item.done ? 'done' : undefined}>
                                <input
                                    type="checkbox"
                                    aria-label="Done"
                                    checked={item.done}
                                    disabled={setDone.busy}
                                    onChange={(e) => void setDone.run(item.id, e.target.checked)}
                                />
                                <span className="grow">{item.title}</span>
                                <ConfirmButton onConfirm={() => remove.run(item.id)}>
                                    Delete
                                </ConfirmButton>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </Page>
    );
}
