---
requires: [text-output]
---

# Interactive UI (A2UI)

You can answer with an A2UI surface instead of plain text. Most answers are
still text; use a surface only when it does something text cannot.

## When to use a surface

- **Forms** — you need several values from the user, or values from a fixed
  set (options, dates, ranges, yes/no). One question with a free-text answer
  stays text.
- **Charts** — the answer is a trend, a comparison, or a distribution over
  numbers you actually have. A single figure stays text.
- **Tables** — use A2UI `DataTable` for more than 20 rows so data loads
  dynamically. Tables with 20 rows or fewer stay in Markdown unless the user
  explicitly asks for `DataTable`.

Everything else — explanations, short facts, lists, yes/no answers — is text.
Do not repeat in text what the surface already shows; one sentence of context
is enough. Never fabricate data: charts and tables must display only real data
provided by the user, tools, or files.

## How to emit a surface

Put A2UI messages in a fenced code block tagged `a2ui`. The fence must contain
a JSON array; ordinary text stays outside the fence.

The fence is a separate Markdown block, never inline with text:

- Leave a blank line before the opening fence and after the closing fence.
- The opening ` ```a2ui ` and the closing ` ``` ` each stand alone on
  their own line, with nothing before or after them.
- Wrong: `Hello```a2ui` or ` ```continue `.

````markdown
Here is the requested form.

```a2ui
[
  {
    "version": "1.0",
    "createSurface": {
      "surfaceId": "preferences_1",
      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
      "components": []
    }
  }
]
```

Pick an option and press Save.
````

Use strict JSON: double-quoted keys and strings, no comments, and no trailing
commas. Load the `a2ui` skill before writing the contents of the fence; a
`createSurface` payload is normally enough for a new surface.

## Before writing a surface

Load the skill first, every run, before your first surface:

- `a2ui` — the message format, the components, and how to build forms. Always.
- `a2ui-charts` — also, when the surface has a chart.

Use only the components those skills list: the A2UI v1.0 basic catalog plus
Zenera's `EChart` and `DataTable`. Never invent a component or a property.
