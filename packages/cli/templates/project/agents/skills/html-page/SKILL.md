---
name: html-page
description: Building an interactive page the user opens from the chat - a dashboard or report with charts, tables, filters and headline numbers, or a small app whose page calls Python functions to read and change data (a tracker, a CRUD tool, a mail or ticket view, a form that saves, a page that queries a database each time it opens). The page is a React component in TypeScript (app.tsx) that a build checks and turns into one HTML file. Where to write it, how it gets its data, the kit of components, the layout that works in the chat's side panel and full page, and how to build and check it. Load when an answer has more than one chart or table, data the user will want to filter or explore, or the user wants something to use and change.
tags: [html, react, typescript, dashboard, report, app, charts, api, python, ui]
version: 2.1.0
---

# Interactive pages

A page is the answer when a reply would be too long or too static: several
related charts and tables, a breakdown to filter, sort or drill into, or
something the user will use and change (add items, edit records, run a
query). One chart or a short table is better inline in the chat (load `a2ui`
and `a2ui-charts`).

You write the page as **one React component in TypeScript, `app.tsx`**. The
build checks it (types, what a sandboxed page may do, a first render) and
writes **`index.html`**, the file the user opens: React, the kit and your code
inlined, nothing else to copy.

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
├── app.tsx              the page: export default function App() - you write this
├── components/          more components it imports, if it grows (optional)
├── index.html           written by the build - never edit it
├── data.json            data it shows, written by your script        (static data)
└── api/
    ├── orders.api.py    functions the page calls                      (functions)
    ├── db.py            helpers they import (not callable from the page)
    └── .data/           the page's own data (SQLite); never downloadable
```

- Name the folder after the content (`sales-q1`, `expense-tracker`),
  lowercase with dashes. Rewriting a page keeps its folder, its link and its
  data.
- A script that builds `data.json` goes under `/workspace/.tmp/`, so the page
  can be refreshed by running it again.
- Every `.tsx` directly in the folder is a page: `app.tsx` builds
  `index.html`, `report.tsx` builds `report.html`. Components it imports go
  in a subfolder (`components/Inbox.tsx`), never beside `app.tsx`.

## Start from a template

Copy one and edit it rather than writing a page from scratch:

```sh
# a dashboard or report: filters, KPIs, charts, table, from data.json
mkdir -p /workspace/pages/sales-q1
cp /skills/html-page/assets/dashboard.tsx /workspace/pages/sales-q1/app.tsx

# an app: a list kept in SQLite, with add, check off, filter and delete
cp -r /skills/html-page/assets/app /workspace/pages/todo
```

Keep the template's structure - imports from `@page/kit`, the data's types,
then `App` - and replace the part marked `The page: replace from here`. A
dashboard with live data is the dashboard template with `useCall` and an
`*.api.py`: its comment says what to change.

## The kit: `@page/kit`

Import everything from `@page/kit`; React from `react`. Nothing else is
installed - no npm packages, no CSS frameworks. The kit's source is in
`/skills/html-page/kit/` if you need to look something up.

| Need                                               | Use                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Call `*.api.py` functions                          | `api<ItemsApi>('api/items')` - an interface of the functions you call (python-functions.md)       |
| Load data, with loading and error state            | `useCall(() => items.list_items({ show }), [show])`, `useData<Report>('data.json')`               |
| A change the user makes, then reload               | `useAction((title: string) => items.add_item({ title }), list.reload)`: `.run`, `.busy`, `.error` |
| View state that survives a reload (tab, open item) | `useHashState('tab', 'orders')` - kept in `#tab=...`                                              |
| Layout                                             | `Page` (`width="narrow"` for an app), `Stack`, `Toolbar`, `Grid`, `Card` (`wide`) - see "Layout"  |
| A list and what opens from it (item, edit, new)    | `Split` - list or detail when narrow, side by side when wide; see "Layout"                        |
| Controls                                           | `Select`, `Field` around any input, plain `<input>`, `<button className="primary">`               |
| Headline numbers                                   | `Kpis` with `Kpi` (`value` formatted, `delta` a fraction)                                         |
| Charts                                             | `Chart` with an ECharts `option` (charts-and-tables.md)                                           |
| Tables                                             | `Table` with Tabulator `columns` (charts-and-tables.md)                                           |
| States                                             | `Loading`, `Empty`, `ErrorBox`                                                                    |
| Delete and other destructive actions               | `ConfirmButton` - acts on the second click                                                        |
| HTML from outside (an email, an article)           | `SafeHtml` - a sandboxed frame; never put such HTML in the page                                   |
| Numbers, money, percents, dates                    | `fmt.num`, `fmt.money`, `fmt.pct`, `fmt.date`; `sum`, `groupSum`, `uniq` for rows                 |

## How it is shown, and what that allows

The chat opens the page in a side panel next to the conversation (often 400 -
600 px wide) or in a full browser tab. Either way it runs sandboxed. The
build reports most of these; know them so you do not write them:

- It reaches files and functions of its folder **by a path relative to the
  page**: `useData('data.json')`, `<img src="logo.png">`, `api('api/orders')`,
  and `..` to go up. Never `file:///`, `/workspace/...`, `http://localhost`
  or an `.api.py` name in the page.
- Images and other small files can also be imported (`import logo from
'./logo.png'`) and are inlined.
- Scripts, styles and fonts load only from `cdn.jsdelivr.net`, `unpkg.com`
  and `cdnjs.cloudflare.com`. Any other host is blocked - no external APIs,
  images, map tiles or analytics from the page. A page that needs an outside
  service calls a Python function that does.
- No `localStorage`, `sessionStorage`, cookies or `IndexedDB`. Keep view
  state in hooks or `useHashState`, and anything to keep in the database.
- No `alert`, `confirm` or `prompt` (blocked): `ConfirmButton` for a delete,
  `ErrorBox` for a message. No form submission: handle `onClick` /
  `onKeyDown`, or a `<form onSubmit>` that calls `e.preventDefault()`.
- Links to other sites need `target="_blank" rel="noopener"`.
- The page cannot call the agent or any tool.

## Layout - narrow first

The page is opened **most often in the chat's side panel, 360 - 600 px
wide**, and sometimes in a full tab up to 1600 px. Design it for the narrow
panel first, then let it spread out when there is room - never the other way
round. At every width:

1. **Everything is reachable.** Every list, form, button and piece of
   content the wide page shows can be reached on the narrow one - shown
   stacked, or one tap away. Nothing is hidden because there is no room.
2. **Nothing scrolls sideways.** The page scrolls down, never across; long
   text wraps.
3. **Controls stay usable**: inputs full width in forms, buttons that wrap to
   the next line instead of shrinking or overflowing.

How, with the kit:

- One column by default: `Stack` for blocks one under another. `Grid` puts
  cards side by side only when each gets at least `min` px, and stacks them
  otherwise.
- **A list and what opens from it** (mail and a message, orders and an
  order, items and an edit form) is always `Split`. Narrow, it shows the list,
  or only what is open with a Back button; wide, both side by side. Whatever
  the user can open - **including a "New …" or edit form** - goes in
  `detail`, and `detail` is `null` when nothing is open:

    ```tsx
    const [openId, setOpenId] = useHashState('open');
    const [composing, setComposing] = useState(false);
    <Split
        list={<Inbox onOpen={setOpenId} onNew={() => setComposing(true)} />}
        detail={
            composing ? (
                <Compose onDone={() => setComposing(false)} />
            ) : openId ? (
                <Message id={openId} />
            ) : null
        }
        onBack={() => {
            setComposing(false);
            setOpenId('');
        }}
        placeholder="Pick a message, or write a new one."
    />;
    ```

    Never place a second panel beside a list any other way (two `Card`s in a
    `Grid`, your own two-column css): on a narrow panel one of them ends up
    below the other or out of reach.

- `Toolbar` and `.row` wrap their controls; keep each control at its natural
  width. A form is a `Stack` of `Field`s inside a `Card`: its inputs take the
  full width.
- A row of a list (sender, subject, date, actions) is a `.row` that wraps, or
  two lines - not fixed columns.
- Your own css: no fixed widths over 360 px, no fixed grid columns
  (`grid-template-columns: 160px 1fr`), no `display: none` in a media or
  container query, no `100vh` or `overflow: hidden` on the page. The build
  rejects them. Wider layouts go inside `@container page (min-width: …)` - the
  page's width, not the window's, since the panel can be narrow on a wide
  screen.
- Anything you add inside a grid or flex row gets `min-width: 0` (the kit's
  cards and stacks have it), or a chart, table or long text pushes the page
  wider than the panel.
- Light and dark: colours come from the kit's CSS variables, switched by
  `prefers-color-scheme`. Use `var(--fg)`, `var(--muted)`, `var(--line)`,
  `var(--accent)`, `var(--danger)` - no hard-coded colours. For styles of
  your own, `import './app.css'`.
- Order, top to bottom: controls in one wrapping row; then headline numbers;
  then charts or the list; the detailed table last.

## Page code

- `export default function App()` in `app.tsx`. The build mounts `App` -
  never call `createRoot`.
- `export const title = '...'` names the page: the browser tab and the
  chat's card for it ("Gmail simulation", "Sales Q1 dashboard").
- `export const description = '...'`: one sentence, in the user's words, on
  what the page shows or lets them do ("Inbox with search, folders, stars
  and drafts; demo messages only."). The chat shows it on the page's card
  under the title. No "built with", file or function names. The build
  reminds you when it is missing.
- State lives in hooks; everything on the page is drawn from it, so the
  numbers, charts and lists always agree. Derive filtered rows and chart
  options with `useMemo` from the data and the filters.
- **The page speaks the user's language, never the builder's.** Nothing the
  user sees - titles, subtitles, labels, footers, empty states, error
  messages, tooltips - names how it is made: no "stored in SQLite", "saved
  to the database", "via the API", "calls a Python function", "loaded from
  data.json", "built with React", no table, file, function or endpoint
  names. Say what it means for the user instead: "Saved", "Your items",
  "Updated just now", "Couldn't load orders - try again". A source line
  names where the numbers come from in business terms ("Q1 orders export"),
  not the file or service.
- Show "Loading…", an empty state ("No orders yet", "No data for these
  filters") and errors on the page with `Loading`, `Empty` and `ErrorBox` -
  never fail silently. `useCall` and `useAction` catch errors for you.
- JSX escapes values: `{row.name}` is always safe. Never
  `dangerouslySetInnerHTML` or `innerHTML`; `SafeHtml` for HTML from outside.
- Touch `window` and `document` only in `useEffect` and in handlers: the
  build renders `App` once without a browser.
- Type the data: an interface for each row and for the functions you call
  (`ItemsApi`). The build then catches a misspelt field before the user does.
- A long page is several components: put them in `components/` and import
  them (`import { Inbox } from './components/Inbox'`).

## Build and check before you link it

```sh
node /skills/html-page/scripts/build.ts /workspace/pages/sales-q1
```

It type-checks, checks the rules above, renders `App` once, and writes
`index.html` - or writes nothing and lists what to fix as `file:line:col
message`. Fix each one and build again until it prints `✓ wrote index.html`.

- Build after **every** change to the page's `.tsx`, `.ts` or `.css`. The user
  sees `index.html`, not your source. `node .../build.ts <folder> --check`
  says whether it is out of date.
- Never edit `index.html` by hand: the next build replaces it.
- A page with functions: call each of them from the shell first
  (python-functions.md, "Test before you link it").
- The build runs in the sandbox, where its tools are installed.

## Hand it over

- The main findings with their numbers in two to four sentences, or for an
  app what it does - the reply must stand on its own for someone who never
  opens the page.
- Then the page as a link, alone in its own paragraph (the build prints it).
  The link's text is the page's name, as its `title` - not an instruction
  ("Open the …", "Click here"): the chat shows it as a card with the title,
  the description and buttons to open it.

[Sales Q1 dashboard](file:///workspace/pages/sales-q1/index.html)

- Say what the user can do there ("filter by region", "add and check off
  items"), where an app keeps its data, and what is left out.
