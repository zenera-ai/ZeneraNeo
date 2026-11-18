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
- **Tables** — many rows of the same fields. `DataTable` is not fully
  supported yet: prefer a Markdown table unless you were asked for `DataTable`.

Everything else — explanations, short facts, lists, yes/no answers — is text.
Do not repeat in text what the surface already shows; one sentence of context
is enough.

## Before writing a surface

Load the skill first, every run, before your first surface:

- `a2ui` — the message format, the components, and how to build forms. Always.
- `a2ui_charts` — also, when the surface has a chart.

Use only the components those skills list: the A2UI v1.0 basic catalog plus
Zenera's `EChart` and `DataTable`. Never invent a component or a property.
