---
name: html-dashboard
description: Building an interactive HTML page - a dashboard or a report with charts, tables, filters and headline numbers - that the user opens from the chat. Where to write it, how it loads its data, the layout that works both in the chat's side panel and full page, and which libraries to use. Load when an answer has more than one chart or table, or data the user will want to filter or explore.
tags: [html, dashboard, report, charts, ui]
version: 1.0.0
---

# Interactive HTML pages

A page is the answer when a reply would be too long or too static: several
related charts and tables, a breakdown the user will want to filter, sort or
drill into. One chart or a short table is better inline in the chat (load
`a2ui` and `a2ui-charts`).

Compute first (load `data-analysis`): the page only shows numbers your script
produced. It never invents, estimates or hard-codes a value.

## Where it goes

One folder per page, under `/workspace/reports/`:

```
/workspace/reports/sales-q1/
├── index.html      the page
└── data.json       the data it shows, written by your script
```

- Name the folder after the content (`sales-q1`, `churn-by-plan`), lowercase
  with dashes. Rewriting a page keeps its folder and link.
- Keep the script that builds `data.json` under `/workspace/.tmp/` so the page
  can be refreshed by running it again.

## Start from the template

Copy the starter page and edit it rather than writing one from scratch:

```sh
mkdir -p /workspace/reports/sales-q1
cp /skills/html-dashboard/assets/template.html /workspace/reports/sales-q1/index.html
```

It already has the layout, light and dark themes, a chart helper, a table
helper, KPI cards, filters and number formatting, all tested in the chat's
panel and full page. Keep the helpers; replace the part marked
`The page: replace from here` with the real fields, charts and columns.

## How it is shown, and what that allows

The chat opens the page in a side panel next to the conversation (often 400 -
600 px wide) or in a full browser tab. Either way it runs sandboxed:

- It reads files of this session **by a path relative to the page**:
  `fetch('data.json')`, `<img src="logo.png">`, and `..` to go up a folder.
  Never `file:///`, `/workspace/...` or `http://localhost`.
- Scripts, styles and fonts load only from `cdn.jsdelivr.net`, `unpkg.com`
  and `cdnjs.cloudflare.com`. Any other host is blocked - no external APIs,
  images, map tiles or analytics.
- No `localStorage`, `sessionStorage`, cookies or `IndexedDB` (the page has
  no origin of its own; touching them throws). Keep state in variables or in
  `location.hash`.
- No `<form>` submission: use inputs and `change` listeners.
- Links to other sites need `target="_blank" rel="noopener"`.
- The page cannot call the agent or any tool. Everything it shows must be in
  its files when you link it.

## Loading data

- Default: `data.json` beside the page, loaded with `fetch` (the template's
  `loadData()`).
- Very small data (a few KB) may be inlined instead, in a JSON `<script>`
  block with `id="data"` - `loadData()` uses it when present.
- Ship the data the page needs, not the raw source: aggregate in Python or
  DuckDB first. Keep `data.json` under ~5 MB; past ~20 000 rows send
  aggregates plus the top rows, and say so on the page.
- Plain JSON shapes the page can use directly: `{ "title", "subtitle",
"source", "updated", "kpis": [...], "rows": [{...}] }`, or one array per
  chart. Numbers as numbers, dates as ISO strings (`2026-03-31`), no `NaN`
  (write `null`).
- Several pages can share one data file by a relative path that starts with `..`.

## Layout - always adaptive

Every page must work at 360 px (narrow panel) and 1600 px (wide tab) without
horizontal scrolling. The template does this; keep to its rules when you
change it:

- `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- No fixed widths. Use CSS grid that reflows:
  `grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr))` for
  chart cards, `minmax(150px, 1fr)` for KPI cards. `.wide` spans the full row.
- Every grid or flex child gets `min-width: 0` (the template's `.card` has it),
  or a chart or table will push the page wider than the panel.
- Charts: width 100% of their card, a fixed height (`320px`, `260px` under
  520 px). Never size charts in `vh` or by the window. The template's
  `chart()` resizes them with a `ResizeObserver`, so they follow the panel
  being dragged, not only the window.
- Tables: the template's `table()` collapses columns that do not fit and
  paginates. Put the most important columns first.
- Filters sit in one wrapping row at the top; KPIs below them; then charts;
  the detailed table last.
- Let the page scroll; do not lock the body to `100vh`.
- Light and dark: colours come from the CSS variables in `:root`, switched by
  `prefers-color-scheme`. Use `var(--fg)`, `var(--muted)` and the rest - no
  hard-coded colours in new elements. Charts re-theme on their own.

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
The page footer names the source file and the date of the data.

## Interactivity

- One `render(state)` function draws everything from the filtered rows;
  every control just updates `state` and calls it. KPIs, charts and table
  then always agree.
- Tooltips on every chart (on by default in `chart()`), `confine: true` so
  they stay inside a narrow panel.
- Clicking a bar or slice may set a filter: `bar.on('click', (p) => ...)`
  with `p.name` the category clicked; the handler survives a theme switch.
- Show "No data for these filters" rather than an empty chart.

## Check before you link it

Run these and fix what they find:

```sh
cd /workspace/reports/sales-q1
python -c "import json; json.load(open('data.json'))" && echo "data ok"
grep -nE "file://|/workspace|localhost|localStorage|sessionStorage|<form" index.html || echo "paths ok"
grep -noE "(src|href)=\"https?://[^\"]+" index.html | grep -vE "cdn.jsdelivr.net|unpkg.com|cdnjs.cloudflare.com" || echo "hosts ok"
```

And confirm every relative file the page loads exists in its folder.

## Hand it over

- Two to four sentences with the main findings and their numbers - the reply
  must stand on its own for someone who never opens the page.
- Then the page as a link, alone in its own paragraph:

[Sales Q1 dashboard](file:///workspace/reports/sales-q1/index.html)

- Say what the user can do there ("filter by region, sort the deals table")
  and what is left out (rows dropped, periods missing).
