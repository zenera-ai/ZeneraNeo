---
name: html-page
description: Building an interactive HTML page the user opens from the chat - a dashboard or report with charts, tables, filters and headline numbers, or a small app whose page calls Python functions to read and change data (a tracker, a CRUD tool, a form that saves, a page that queries a database each time it opens). Where to write it, how it gets its data, the layout that works in the chat's side panel and full page, and how to check it. Load when an answer has more than one chart or table, data the user will want to filter or explore, or the user wants something to use and change.
tags: [html, dashboard, report, app, charts, api, python, ui]
version: 1.0.0
---

# Interactive HTML pages

A page is the answer when a reply would be too long or too static: several
related charts and tables, a breakdown to filter, sort or drill into, or
something the user will use and change (add items, edit records, run a
query). One chart or a short table is better inline in the chat (load `a2ui`
and `a2ui-charts`).

## First: where its data comes from

| The page                                                      | Its data                                                   | Read next                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Shows numbers you compute now (a report, a dashboard)         | `data.json` beside the page, written by your script        | `references/charts-and-tables.md`                                  |
| Shows live data (queried each time it opens) or saves changes | Python functions in `*.api.py` files, called from the page | `references/python-functions.md`, and charts-and-tables for charts |

Read the reference before writing the page: `cat /skills/html-page/references/<file>`.
Functions also know who is signed in (`zenera.identity()`: id, name, email,
role), for per-user data and permissions - python-functions.md, "Who is
calling".

Static data first when it will do: it opens at once and needs no code at
view time. A page that only shows numbers never invents, estimates or
hard-codes one: compute it first (load `data-analysis`).

## Where it goes

One folder per page, under `/workspace/pages/`:

```
/workspace/pages/sales-q1/
├── index.html           the page
├── data.json            data it shows, written by your script        (static data)
├── api.js               calls the functions - copied, never edited    (functions)
└── api/
    ├── orders.api.py    functions the page calls
    ├── db.py            helpers they import (not callable from the page)
    └── .data/           the page's own data (SQLite); never downloadable
```

- Name the folder after the content (`sales-q1`, `expense-tracker`),
  lowercase with dashes. Rewriting a page keeps its folder, its link and its
  data.
- A script that builds `data.json` goes under `/workspace/.tmp/`, so the page
  can be refreshed by running it again.
- More pages of one app are more `.html` files in the folder.

## Start from a template

Copy one and edit it rather than writing a page from scratch:

```sh
# a dashboard or report: charts, KPIs, filters, table
mkdir -p /workspace/pages/sales-q1
cp /skills/html-page/assets/dashboard.html /workspace/pages/sales-q1/index.html

# an app: a list kept in SQLite, with add, check off, filter and delete
cp -r /skills/html-page/assets/app /workspace/pages/todo
cp /skills/html-page/assets/api.js /workspace/pages/todo/
```

Keep the templates' layout, theme and helpers; replace the part marked
`The page: replace from here`. A dashboard with live data is the dashboard
template plus `api.js` and an `*.api.py`: its `loadData()` says what to
change.

## How it is shown, and what that allows

The chat opens the page in a side panel next to the conversation (often 400 -
600 px wide) or in a full browser tab. Either way it runs sandboxed:

- It reaches files and functions of its folder **by a path relative to the
  page**: `fetch('data.json')`, `<img src="logo.png">`, `api('api/orders')`,
  and `..` to go up. Never `file:///`, `/workspace/...`, `http://localhost`
  or an `.api.py` name in the page.
- Scripts, styles and fonts load only from `cdn.jsdelivr.net`, `unpkg.com`
  and `cdnjs.cloudflare.com`. Any other host is blocked - no external APIs,
  images, map tiles or analytics from the page. A page that needs an outside
  service calls a Python function that does.
- No `localStorage`, `sessionStorage`, cookies or `IndexedDB` (the page has
  no origin of its own; touching them throws). Keep view state in variables
  or `location.hash`, and anything to keep in the database.
- No `<form>` submission: use inputs, buttons and `click` / `change`
  listeners. No `alert`, `confirm` or `prompt` (blocked): confirm a delete
  with a second click, as the app template does.
- Links to other sites need `target="_blank" rel="noopener"`.
- The page cannot call the agent or any tool.

## Layout - always adaptive

Every page must work at 360 px (narrow panel) and 1600 px (wide tab) without
horizontal scrolling. The templates do this; keep to their rules:

- `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- No fixed widths: CSS grid that reflows
  (`repeat(auto-fit, minmax(min(100%, 420px), 1fr))`), flex rows that wrap.
- Every grid or flex child gets `min-width: 0` (the templates' `.card` has
  it), or a chart, table or long text pushes the page wider than the panel.
- Let the page scroll; do not lock the body to `100vh`.
- Light and dark: colours come from the CSS variables in `:root`, switched by
  `prefers-color-scheme`. Use `var(--fg)`, `var(--muted)` and the rest - no
  hard-coded colours in new elements.
- Controls in one wrapping row at the top; then headline numbers; then
  charts or the list; the detailed table last.

## Page code

- One `state` object and one `render()` that draws everything from it; every
  control only changes `state` and calls `render()` (or reloads first). The
  numbers, charts and lists then always agree.
- Show "Loading…", an empty state ("No orders yet", "No data for these
  filters") and errors in a box on the page - never fail silently.
- Put values from data into the page with `textContent` (or the templates'
  `esc()`), never raw into `innerHTML`.
- Libraries: ECharts for charts, Tabulator for tables, from the CDN URLs in
  `dashboard.html`. No CSS frameworks, React or Vue (no build step here).

## Check before you link it

```sh
cd /workspace/pages/sales-q1
grep -nE "file://|/workspace|localhost|localStorage|sessionStorage|<form|alert\(|confirm\(|prompt\(" *.html || echo "paths ok"
grep -noE "(src|href)=\"https?://[^\"]+" *.html | grep -vE "cdn.jsdelivr.net|unpkg.com|cdnjs.cloudflare.com" || echo "hosts ok"
[ ! -f data.json ] || python3 -c "import json; json.load(open('data.json'))" && echo "data ok"
```

Confirm every relative file the page loads exists in its folder. A page with
functions: call each of them from the shell first (`python-functions.md`,
"Test before you link it").

## Hand it over

- The main findings with their numbers in two to four sentences, or for an
  app what it does - the reply must stand on its own for someone who never
  opens the page.
- Then the page as a link, alone in its own paragraph:

[Sales Q1 dashboard](file:///workspace/pages/sales-q1/index.html)

- Say what the user can do there ("filter by region", "add and check off
  items"), where an app keeps its data, and what is left out.
