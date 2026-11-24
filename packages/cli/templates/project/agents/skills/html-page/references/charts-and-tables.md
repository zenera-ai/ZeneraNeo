# Charts, tables and headline numbers

For a page built from `/skills/html-page/assets/dashboard.tsx`. The core
rules (where it goes, the sandbox, adaptive layout, the build) are in
`SKILL.md`.

## Its data

- Default: `data.json` beside the page, loaded with
  `const report = useData<Report>('data.json')` - `report.data`,
  `report.error`, `report.loading`, `report.reload`. Give `Report` the
  data's real shape: the build then checks every field the page reads.
- Live data instead: `useCall(() => api<ReportApi>('api/report').get_data(), [])`,
  a function of `api/report.api.py` that returns the same shape
  (`python-functions.md`). Filters over many rows go to the function as
  arguments (`useCall(() => report.get_data({ region }), [region])`) and are
  applied in SQL, instead of loading every row.
- Ship the data the page needs, not the raw source: aggregate in Python, SQL
  or DuckDB first. Keep it under ~5 MB; past ~20 000 rows send aggregates plus
  the top rows, and say so on the page.
- Plain JSON shapes the page can use directly: `{ "title", "subtitle",
"source", "updated", "kpis": [...], "rows": [{...}] }`, or one array per
  chart. Numbers as numbers, dates as ISO strings (`2026-03-31`), no `NaN`
  (write `null`).
- Several pages can share one data file by a relative path that starts with
  `..` (`useData('../shared/data.json')`).

## Charts: `Chart`

```tsx
const byCategory = useMemo(() => {
    const totals = groupSum(rows, 'category', 'amount').sort((a, b) => b[1] - a[1]);
    return {
        xAxis: { type: 'category', data: totals.map((d) => d[0]) },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', data: totals.map((d) => d[1]) }],
    };
}, [rows]);

<Card title="Amount by category, USD">
    <Chart option={byCategory} onClick={(e) => setCategory(e.name)} />
</Card>;
```

- `option` is a plain ECharts option object - every chart type ECharts has:
  bar, line, area, pie, scatter, heatmap, treemap, sankey, funnel, gauge,
  `map` with GeoJSON you write to the folder. Same library as the chat's
  charts, so `a2ui-charts` advice on choosing a chart type applies.
- Build `option` in `useMemo` from the filtered rows: the chart redraws when
  it changes, not on every render.
- Defaults: an axis tooltip (`confine: true`, stays inside a narrow panel)
  and a tight grid. A top-level key of `option` replaces its default: a pie
  wants `tooltip: { trigger: 'item' }`.
- `height` (default 320) is the chart's; its width is the card's. It follows
  the panel being resized and switches light/dark by itself. Never size a
  chart in `vh` or by the window.
- `onClick` gets the clicked bar, point or slice: `e.name` is its category -
  set a filter from it.
- Long time series: `dataZoom: [{ type: 'inside' }]`, plus
  `{ type: 'slider' }` on wide pages.
- Show `Empty` ("No data for these filters") instead of an empty chart.

## Tables: `Table`

```tsx
const columns: Column[] = [
    { title: 'Date', field: 'date', headerFilter: 'input', minWidth: 100 },
    { title: 'Customer', field: 'customer', headerFilter: 'input' },
    {
        title: 'Amount',
        field: 'amount',
        hozAlign: 'right',
        sorter: 'number',
        formatter: (cell: { getValue(): number }) => fmt.money(cell.getValue()),
    },
];

<Card title="Orders" wide>
    <Table data={rows} columns={columns} onRowClick={(row) => setOpen(row.id)} />
</Card>;
```

- Tabulator underneath: `columns` take its column options
  (`sorter`, `hozAlign`, `headerFilter`, `formatter`, `minWidth`, `width`).
  Define `columns` outside `App` or in `useMemo`.
- It sorts, filters per column, pages (25 rows) and collapses the columns
  that do not fit a narrow panel - put the most important columns first.
- New `data` replaces the rows in place (page and sort are kept). `options`
  passes more Tabulator options (`{ paginationSize: 50 }`,
  `{ pagination: false }` for a short table).
- A short, fixed table (under ~15 rows, no sorting needed) can be a plain
  `<table>` in a `Card` instead.

## Headline numbers and filters

| Need                                               | Use                                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Headline numbers with change vs. a previous period | `<Kpis><Kpi label="Revenue" value={fmt.money(total)} delta={0.12} hint="vs. Q4" /></Kpis>`                 |
| A filter over the whole page                       | `<Select label="Region" all="All" value={region} options={uniq(rows, 'region')} onChange={setRegion} />`   |
| A date or number range                             | `<Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>` |
| Number, money, percent and date formatting         | `fmt.num(v, 2)`, `fmt.money(v, 'EUR')`, `fmt.pct(0.12)`, `fmt.date('2026-03-31')` - never by hand          |
| Totals and groups of rows                          | `sum(rows, 'amount')`, `groupSum(rows, 'region', 'amount')`, `uniq(rows, 'region')`                        |
| Text sections, notes, method                       | JSX in a `Card`; `<details>` for anything secondary                                                        |
| Tabs between views                                 | Buttons that set `useHashState('tab', 'summary')`, and render the active view                              |

Avoid: CSS frameworks and other npm packages, and other chart or table
libraries - the page has React, the kit, and ECharts and Tabulator from the
CDN, added by the build when `Chart` or `Table` is used. No Leaflet or any map
with tiles (blocked): use an ECharts `map` with GeoJSON you write to the
folder.

Every chart and table has a short heading saying what it shows, with units.
The page footer (`Page footer=...`) names the source and the date of the data.

## Interactivity

- Filters are `useState` in `App`; the filtered rows are a `useMemo` of the
  data and the filters; KPIs, chart options and the table all come from
  those rows. They then always agree.
- Clicking a bar or slice may set a filter (`onClick` above); show the
  active filters in the `Toolbar` so they can be cleared.
- Keep the view a user would share (the tab, the open record) in
  `useHashState`, so a reload or a link opens it again.
