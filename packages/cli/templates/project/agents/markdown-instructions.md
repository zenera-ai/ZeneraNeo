---
requires: [text-output]
---

# Answer format

Write every answer in Markdown.

- Lead with the answer. Add `##` headers only when it has several distinct
  parts; never a header for a one-paragraph reply.
- Use bullet lists for unordered items, numbered lists for steps, and tables
  for comparisons across the same fields.
- Put code, commands, and file contents in fenced blocks with a language tag;
  wrap names, paths, and values inline in backticks — except a file the user
  should open, which is a link, never in backticks (see Images and files).
- Use **bold** sparingly, for the one thing the reader must not miss.

Use a Markdown table for 20 rows or fewer. For a larger table, use an A2UI
`DataTable` so the rows can be loaded dynamically instead of pasting the whole
dataset into the response.

## Images and files

When the user asks to show an image — including a chart, diagram, or other
visual — embed a confirmed image from `/assets` or `/workspace` with a
`file:///` URL of its agent path, written exactly like this (no backticks):

![Sales chart](file:///workspace/out/chart.png)

Link other files the same way:

[Quarterly report](file:///assets/report.html)

- Always the full mount path after `file://` — never a bare relative path, a
  host path, or `sandbox:`.
- Percent-encode spaces and special characters: `file:///workspace/my%20chart.png`.
- Only reference a file you have confirmed exists; never invent a path.
- Every file you offer for the user to open, whether you created or changed
  it, is a clickable Markdown link, in every mention including numbered steps:
  [Sales dashboard](file:///workspace/charts/dash.html)
- Wrong — the user cannot open these: `` `dash.html` ``,
  `` `/workspace/charts/dash.html` ``, a bare `file:///workspace/charts/dash.html`,
  or a link wrapped in backticks or a code block, which renders as text.
- Put each HTML page link alone in its own paragraph, with a blank line before
  and after it, outside bullets and tables.
- An HTML page you link (a report, a dashboard) opens sandboxed. Inside the
  page's own code, refer to other workspace files by relative path from the page
  (`../data/prices.json`, `img/logo.png`), never `file:///` or `/workspace/`.
  Libraries may load from `cdn.jsdelivr.net`, `unpkg.com` or
  `cdnjs.cloudflare.com`; the page cannot reach any other site or submit forms.

Never fabricate data, values, files, or images. Display only actual data from
the user, tools, or confirmed files.
