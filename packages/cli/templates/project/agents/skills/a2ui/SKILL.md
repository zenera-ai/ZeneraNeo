---
name: a2ui
description: How to answer with an A2UI v1.0 surface (forms, cards, tables, layouts, images) - message format, components, data binding and actions. Load before writing any A2UI.
tags: [ui, a2ui]
version: 1.0.0
---

# A2UI surfaces

A2UI is a JSON description of UI that the chat renders in place of your text.
You write it; the user sees and uses it.

## Emitting it

Put the messages in a fenced block tagged `a2ui` as a JSON array. The block may
sit between ordinary Markdown paragraphs, but always as its own block: a blank
line before the opening fence and after the closing fence, and ` ```a2ui `
and the closing ` ``` ` each alone on their own line. Never glue a fence to
text, as in `Hello```a2ui` or ` ```continue `.

````markdown
Here is the booking form.

```a2ui
[
  {
    "version": "1.0",
    "createSurface": {
      "surfaceId": "main",
      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
      "components": []
    }
  }
]
```

Fill it in and press Book.
````

- The array contains complete JSON objects, each with `"version": "1.0"` and
  exactly one of `createSurface`, `updateComponents`, `updateDataModel`,
  `deleteSurface`.
- Use strict JSON: no comments or trailing commas.
- Prefer a single `createSurface` that carries both `components` and
  `dataModel`. Send `updateComponents` / `updateDataModel` only to change a
  surface you already created.

## The surface

```json
{
    "version": "1.0",
    "createSurface": {
        "surfaceId": "trip_booking_1",
        "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
        "sendDataModel": true,
        "components": [],
        "dataModel": {}
    }
}
```

- `surfaceId` is unique for the whole conversation: never reuse one without a
  `deleteSurface` first. Use a descriptive name plus a counter.
- `catalogId` is always the basic catalog above. Zenera components add their
  own `@catalogId` (see below).
- Set `sendDataModel: true` on forms, so the user's input reaches you with the
  action.
- `components` is a **flat** list. Each has a unique `id` and a `component`
  type; containers refer to children by id. Exactly one component has
  `"id": "root"` — that is what is shown.
- `dataModel` is a plain JSON object. Bind to it with `{"@path": "/pointer"}`
  (JSON Pointer) wherever a property accepts a dynamic value.

## Components

Basic catalog (A2UI v1.0). Only these, and only these properties:

| Component       | Required                                              | Optional                                                                                                               |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Text`          | `text`                                                | `variant`: `body` \| `caption`                                                                                         |
| `Image`         | `url`                                                 | `description`, `fit`, `variant`: `icon` \| `avatar` \| `smallFeature` \| `mediumFeature` \| `largeFeature` \| `header` |
| `Icon`          | `name` (e.g. `check`, `warning`)                      | —                                                                                                                      |
| `Video`         | `url`                                                 | `posterUrl`                                                                                                            |
| `AudioPlayer`   | `url`                                                 | `description`                                                                                                          |
| `Row`, `Column` | `children`                                            | `justify`, `align`                                                                                                     |
| `List`          | `children`                                            | `direction`: `vertical` \| `horizontal`, `align`                                                                       |
| `Card`          | `child` (exactly one id)                              | —                                                                                                                      |
| `Tabs`          | `tabs`: `[{title, child}]`                            | —                                                                                                                      |
| `Divider`       | —                                                     | `axis`                                                                                                                 |
| `Modal`         | `trigger`, `content`                                  | —                                                                                                                      |
| `Button`        | `child`, `action`                                     | `variant`: `default` \| `primary` \| `borderless`                                                                      |
| `TextField`     | `label`, `value`                                      | `placeholder`, `variant`: `shortText` \| `longText` \| `number` \| `obscured`                                          |
| `CheckBox`      | `label`, `value` (boolean)                            | —                                                                                                                      |
| `ChoicePicker`  | `options`: `[{label, value}]`, `value` (string array) | `label`, `variant`: `mutuallyExclusive` \| `multipleSelection`, `displayStyle`: `checkbox` \| `chips`, `filterable`    |
| `Slider`        | `value`, `max`                                        | `label`, `min`, `steps`                                                                                                |
| `DateTimeInput` | `value` (ISO 8601, `""` if unset)                     | `enableDate`, `enableTime`, `min`, `max`                                                                               |

Zenera catalog — each instance must carry
`"@catalogId": "https://zenera.ai/a2ui/catalogs/zenera/v1_0/catalog.json"`:

| Component   | Required | Optional           | Notes                                         |
| ----------- | -------- | ------------------ | --------------------------------------------- |
| `EChart`    | `apiUrl` | —                  | Load the `a2ui-charts` skill before using it. |
| `DataTable` | `apiUrl` | `pageSize` (1–100) | Not fully supported yet; see below.           |

Rules that catch most mistakes:

- A `Card` holds one child — wrap several in a `Column`.
- `children` is an array of ids, or a template
  `{"componentId": "row_tpl", "path": "/items"}` that repeats one component per
  array element; inside the template, bind relative to the element.
- A `Button` shows its `child` (usually a `Text`), never a `label`.
- Media URLs are `https:` or `data:` ones you actually have. Never invent one;
  omit the component instead.

## Forms

Pick the input by the value you need:

| Value                          | Component                                   |
| ------------------------------ | ------------------------------------------- |
| Short / long free text         | `TextField` `shortText` / `longText`        |
| Number without a natural range | `TextField` `number`                        |
| Number within a known range    | `Slider`                                    |
| Yes / no, consent              | `CheckBox`                                  |
| One of a fixed set             | `ChoicePicker` `mutuallyExclusive`          |
| Several of a fixed set         | `ChoicePicker` `multipleSelection`          |
| Date, time, or both            | `DateTimeInput` (enable only what you need) |

- Bind every input's `value` to its own path in `dataModel`, and give that path
  a starting value: `""`, `false`, `[]`, a number, or what you already know.
  Never ask for something you already have — prefill it.
- Use `displayStyle: "chips"` for up to ~6 short options, `filterable: true`
  for more than ~10.
- Validate with `@checks`, e.g.
  `"@checks": [{"condition": {"@call": "required", "args": {"value": {"@path": "/email"}}}, "message": "Email is required"}]`.
  Available checks: `required`, `email`, `regex`, `length`, `numeric`, and
  `and` / `or` / `not` to combine them.
- Ask only for what the next step needs; past 5–6 fields, split the form.
- End with one `primary` `Button` whose label names the outcome ("Book
  flight", not "Submit"). Secondary actions are `default` or `borderless`.

## Actions

A `Button` sends an event back to you as the user's next message:

```json
"action": {
    "event": {
        "name": "book_flight",
        "context": { "from": { "@path": "/from" }, "date": { "@path": "/date" } }
    }
}
```

- `name` is a snake_case verb you will recognise when it comes back.
- Put in `context` exactly what you need to act — bound paths for user input,
  literals for fixed ids.
- When the event arrives, act on it. Then update the same surface with
  `updateDataModel` / `updateComponents`, or reply in text — do not create a
  second copy of the form.
- Put destructive actions behind a `Modal` whose content asks for
  confirmation.

## Tables

`DataTable` is not fully supported yet. Show up to 20 rows as a Markdown table
unless the user explicitly asked for `DataTable`. For more than 20 rows, use
`DataTable` so the data loads dynamically instead of being pasted into the
response. Write one page of JSON to a file under `/workspace` and point `apiUrl`
at it as a `file:///workspace/...` URL:

```json
{
    "columns": [{ "key": "name", "label": "Name", "type": "string" }],
    "rows": [{ "name": "Ada" }],
    "total": 1,
    "page": 1,
    "pageSize": 10
}
```

`type` is `string`, `number`, `date` or `boolean`.

## Example: a form

```a2ui
[
  {
    "version": "1.0",
    "createSurface": {
      "surfaceId": "meeting_request_1",
      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
      "sendDataModel": true,
      "dataModel": {
        "topic": "",
        "when": "",
        "length": 30,
        "remote": false
      },
      "components": [
        { "id": "root", "component": "Card", "child": "form" },
        {
          "id": "form",
          "component": "Column",
          "children": ["title", "topic", "when", "length", "remote", "submit"]
        },
        { "id": "title", "component": "Text", "text": "Request a meeting" },
        {
          "id": "topic",
          "component": "TextField",
          "label": "Topic",
          "value": { "@path": "/topic" },
          "@checks": [
            {
              "condition": {
                "@call": "required",
                "args": { "value": { "@path": "/topic" } }
              },
              "message": "Give the meeting a topic"
            }
          ]
        },
        {
          "id": "when",
          "component": "DateTimeInput",
          "value": { "@path": "/when" },
          "enableDate": true,
          "enableTime": true
        },
        {
          "id": "length",
          "component": "Slider",
          "label": "Minutes",
          "min": 15,
          "max": 120,
          "steps": 7,
          "value": { "@path": "/length" }
        },
        {
          "id": "remote",
          "component": "CheckBox",
          "label": "Remote",
          "value": { "@path": "/remote" }
        },
        {
          "id": "submit",
          "component": "Button",
          "variant": "primary",
          "child": "submit_label",
          "action": {
            "event": {
              "name": "request_meeting",
              "context": {
                "topic": { "@path": "/topic" },
                "when": { "@path": "/when" },
                "length": { "@path": "/length" },
                "remote": { "@path": "/remote" }
              }
            }
          }
        },
        {
          "id": "submit_label",
          "component": "Text",
          "text": "Request meeting"
        }
      ]
    }
  }
]
```
