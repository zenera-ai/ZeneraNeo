# Charts, tables and headline numbers

For a page built from `/skills/html-page/assets/dashboard.html`. The core
rules (where it goes, the sandbox, adaptive layout, checks) are in `SKILL.md`.

## Its data

- Default: `data.json` beside the page, loaded with `fetch` (the template's
  `loadData()`).
- Very small data (a few KB) may be inlined instead, in a JSON `<script>`
  block with `id="data"` - `loadData()` uses it when present.
- Live data instead: copy `api.js` beside the page, add
  `<script src="api.js"></script>` before the page's script, and make
  `loadData()` return `api('api/report').get_data()` - a function of
  `api/report.api.py` that returns the same shape (`python-functions.md`).
- Ship the data the page needs, not the raw source: aggregate in Python, SQL
  or DuckDB first. Keep it under ~5 MB; past ~20 000 rows send aggregates plus
  the top rows, and say so on the page.
- Plain JSON shapes the page can use directly: `{ "title", "subtitle",
"source", "updated", "kpis": [...], "rows": [{...}] }`, or one array per
  chart. Numbers as numbers, dates as ISO strings (`2026-03-31`), no `NaN`
  (write `null`).
- Several pages can share one data file by a relative path that starts with
  `..`.

## Sizing

- Chart cards: `grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr))`;
  KPI cards `minmax(150px, 1fr)`. `.wide` spans the full row.
- Charts: width 100% of their card, a fixed height (`320px`, `260px` under
  520 px). Never size charts in `vh` or by the window. The template's
  `chart()` resizes them with a `ResizeObserver`, so they follow the panel
  being dragged, not only the window, and re-theme on light/dark.
- Tables: the template's `table()` collapses columns that do not fit and
  paginates. Put the most important columns first.

## Components

Use these, from the CDN URLs in the template, pinned to the version shown
there:

| Need                                                                                        | Use                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Charts of any kind - bar, line, area, pie, scatter, heatmap, treemap, sankey, funnel, gauge | ECharts (`chart()` helper). Same library as the chat's charts, so `a2ui-charts` advice on choosing a chart type applies. |
| Tables - sort, filter per column, pagination, many rows                                     | Tabulator (`table()` helper)                                                                                             |
| Headline numbers with change vs. a previous period                                          | KPI cards (`kpis()` helper)                                                                                              |
| Filters across the whole page                                                               | `<select>` per field (`filters()` helper); `<input type="date">` or `type="range"` for ranges                            |
| Number, money, percent and date formatting                                                  | `Intl.NumberFormat` and `Intl.DateTimeFormat` (`fmt` helper) - never format by hand                                      |
| Long time series                                                                            | ECharts `dataZoom` (`inside`, plus `slider` on wide pages)                                                               |
| Text sections, notes, method                                                                | Plain HTML in a `.card`; `<details>` for anything secondary                                                              |
| Tabs between views                                                                          | Buttons that show and hide sections; keep the active tab in `location.hash`                                              |

Avoid: CSS frameworks and Tailwind's browser build (heavy, and the template
styles are enough), React or Vue (no build step here), Leaflet or any map
with tiles (blocked - use an ECharts `map` with GeoJSON you write to the
folder), Plotly unless a chart type ECharts lacks is needed (it is ~3 MB).

Every chart and table has a short heading saying what it shows, with units.
The page footer names the source and the date of the data.

## Interactivity

- One `render(state)` draws everything from the filtered rows; every control
  just updates `state` and calls it. KPIs, charts and table then always agree.
- Tooltips on every chart (on by default in `chart()`), `confine: true` so
  they stay inside a narrow panel.
- Clicking a bar or slice may set a filter: `bar.on('click', (p) => ...)`
  with `p.name` the category clicked; the handler survives a theme switch.
- Show "No data for these filters" rather than an empty chart.
- Filters over live data with many rows: pass them to the function
  (`get_data({ region })`) and filter in SQL, instead of loading every row.
