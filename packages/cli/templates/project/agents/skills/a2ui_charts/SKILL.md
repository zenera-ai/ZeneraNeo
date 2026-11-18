---
name: a2ui_charts
description: How to show a chart in an A2UI surface with Zenera's EChart component - choosing the chart type and writing the ECharts option file it loads. Load together with a2ui.
tags: [ui, a2ui, charts]
version: 1.0.0
---

# Charts in A2UI (Zenera `EChart`)

`EChart` draws an [Apache ECharts](https://echarts.apache.org) chart. It does
not take data inline: it loads an ECharts **option** — the object
`echarts.setOption` takes, data included — as JSON from `apiUrl`. So a chart is
two steps:

1. Write the option to a JSON file under `/workspace` with `write_file`.
2. Emit a surface whose `EChart` points at it as a `file:///workspace/...` URL.

Without `write_file` you cannot make a chart: answer with a Markdown table
instead. Load the `a2ui` skill too — it has the message format.

## When a chart helps

Draw one only for numbers you actually have — from a tool, a file, or the user.
Never invent, round off or "illustrate" data. A single number, or two or three
values, reads better as a sentence.

## Choosing the type

| The question                      | `series.type`                                         |
| --------------------------------- | ----------------------------------------------------- |
| How does it change over time?     | `line` (`area` = `line` with `areaStyle: {}`)         |
| How do categories compare?        | `bar` (horizontal bars when labels are long)          |
| How is a whole split? (≤ 6 parts) | `pie` — otherwise a sorted `bar`                      |
| How do two measures relate?       | `scatter`                                             |
| How are values distributed?       | `bar` over bucketed ranges                            |
| Parts of a whole over time        | `bar` or `line` with `stack: "total"` on every series |
| Two dimensions × intensity        | `heatmap` with `visualMap`                            |
| Progress against one target       | `gauge`                                               |

Keep it readable: at most ~5 series, ~12 pie/bar categories (group the rest as
"Other"), and sort bars by value unless the categories have a natural order.

## The option file

Write strict JSON — no JavaScript. Function-valued options (`formatter`
functions, callbacks) cannot be expressed; use string templates such as
`"{b}: {c}"` instead.

```json
{
    "title": { "text": "Monthly revenue, 2026", "subtext": "USD thousands" },
    "tooltip": { "trigger": "axis" },
    "legend": {},
    "xAxis": { "type": "category", "data": ["Jan", "Feb", "Mar", "Apr"] },
    "yAxis": { "type": "value", "name": "USD k" },
    "series": [
        { "name": "Online", "type": "line", "data": [120, 132, 101, 134] },
        { "name": "Retail", "type": "line", "data": [220, 182, 191, 234] }
    ]
}
```

- Always a `title`, and units in the subtitle or axis `name`.
- `tooltip.trigger`: `axis` for line/bar, `item` for pie/scatter.
- Add `legend` only with more than one series (or for a pie).
- Pie and gauge take no `xAxis`/`yAxis`; pie data is `[{"name", "value"}]`.
- Leave colours and fonts to the theme.
- Name the file after what it shows: `/workspace/charts/revenue_2026.json`.
  Write a new file for a changed chart rather than rewriting one already shown.

## The surface

```a2ui
[
  {
    "version": "1.0",
    "createSurface": {
      "surfaceId": "revenue_chart_1",
      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
      "components": [
        { "id": "root", "component": "Card", "child": "body" },
        {
          "id": "body",
          "component": "Column",
          "children": ["chart", "note"]
        },
        {
          "id": "chart",
          "component": "EChart",
          "@catalogId": "https://zenera.ai/a2ui/catalogs/zenera/v1_0/catalog.json",
          "apiUrl": "file:///workspace/charts/revenue_2026.json"
        },
        {
          "id": "note",
          "component": "Text",
          "variant": "caption",
          "text": "Source: sales ledger, Jan–Apr 2026"
        }
      ]
    }
  }
]
```

- Every `EChart` carries the Zenera `@catalogId`; the surface keeps the basic
  `catalogId`.
- Put a caption `Text` under the chart naming the data source.
- Several charts: one `EChart` each, stacked in a `Column` — or in `Tabs` when
  they are alternative views of the same data.
- In your text, state the one finding the chart shows; do not list its numbers
  again.
