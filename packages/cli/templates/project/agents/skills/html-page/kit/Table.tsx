import { useEffect, useRef } from 'react';

/**
 * A Tabulator column: `title`, `field`, and any of its options - `sorter: 'number'`,
 * `hozAlign: 'right'`, `headerFilter: 'input'`, `formatter: (cell) => …`, `minWidth`.
 * https://tabulator.info/docs/6.3/columns
 */
export type Column = { title: string; field?: string; [option: string]: any };

interface Tabulator {
    on(event: string, handler: (...args: any[]) => void): void;
    replaceData(data: unknown[]): Promise<void>;
    setColumns(columns: Column[]): void;
    destroy(): void;
}

// Loaded from the CDN by the page's html; the build adds it when a page uses Table.
declare const Tabulator: new (el: HTMLElement, options: Record<string, any>) => Tabulator;

const columnsKey = (columns: readonly Column[]) =>
    JSON.stringify(columns.map(({ title, field }) => [title, field]));

/**
 * A Tabulator table: sorts, filters per column with `headerFilter`, pages through many rows,
 * and collapses the columns that do not fit a narrow panel - put the important ones first.
 * New `data` replaces the rows; columns are set again when their titles or fields change.
 *
 *   <Table data={rows} columns={[{ title: 'Amount', field: 'amount', sorter: 'number' }]} />
 */
export function Table<T extends object>({
    data,
    columns,
    options,
    onRowClick,
    placeholder = 'No rows match the filters',
}: {
    data: readonly T[];
    columns: Column[];
    /** more Tabulator options, e.g. `{ paginationSize: 50 }` or `{ pagination: false }` */
    options?: Record<string, any>;
    onRowClick?: (row: T) => void;
    placeholder?: string;
}) {
    const el = useRef<HTMLDivElement>(null);
    const table = useRef<{ tabulator: Tabulator; built: Promise<void> } | null>(null);
    const first = useRef({ data, columns, options, placeholder });
    const shown = useRef({ data, columns: columnsKey(columns) });
    const clickRef = useRef(onRowClick);
    clickRef.current = onRowClick;

    useEffect(() => {
        const { data, columns, options, placeholder } = first.current;
        const tabulator = new Tabulator(el.current!, {
            data: [...data],
            columns,
            layout: 'fitDataStretch',
            responsiveLayout: 'collapse',
            pagination: true,
            paginationSize: 25,
            paginationCounter: 'rows',
            placeholder,
            ...options,
        });
        const built = new Promise<void>((done) => tabulator.on('tableBuilt', () => done()));
        tabulator.on('rowClick', (_event, row) => clickRef.current?.(row.getData() as T));
        table.current = { tabulator, built };
        return () => {
            table.current = null;
            tabulator.destroy();
        };
    }, []);

    const key = columnsKey(columns);
    useEffect(() => {
        const current = table.current;
        if (!current || shown.current.columns === key) return;
        shown.current.columns = key;
        void current.built.then(() => current.tabulator.setColumns(columns));
    }, [key]);

    useEffect(() => {
        const current = table.current;
        if (!current || shown.current.data === data) return;
        shown.current.data = data;
        void current.built.then(() => current.tabulator.replaceData([...data])).catch(() => {});
    }, [data]);

    return <div ref={el} className="table" />;
}
