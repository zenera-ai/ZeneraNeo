---
name: data-analysis
description: Analysing data - CSV, Excel, JSON or tables in files or tool results - with Python in the sandbox, then presenting the findings as text, a table, a DataTable or a chart. Load before any calculation over more than a handful of values.
tags: [data, analysis, python, charts]
version: 1.0.0
---

# Data analysis

Compute, do not estimate: every number in your answer comes from code you ran
over the real data. Arithmetic done in your head is a guess.

## 1. Look at the data first

- Find the file (or save the tool result under `/workspace/.tmp/`) and look
  at its shape before analysing: the first rows, the column names, the row
  count, and the types.
- Note what is missing or odd - empty cells, mixed units, duplicate rows,
  dates in several formats - and say how you handled it.

## 2. Compute with Python

Write the script to a file under `/workspace/.tmp/` and run it with `python`, so it can
be fixed and rerun. Print only the results you need.

- The standard library is always there: `csv`, `json`, `statistics`,
  `sqlite3`, `datetime`, `collections`. It is enough for counts, sums,
  averages, group-bys and joins on moderate data.
- For larger or messier data, or Excel files, use pandas (with openpyxl for
  Excel). The project's sandbox image installs both; if `import pandas` fails,
  `pip install --user pandas openpyxl` and suggest adding them back to the
  project's sandbox image.
- Read Excel with `pandas.read_excel(path, sheet_name=None)` to see every
  sheet before picking one.
- SQLite or a SQL dump: query it with `sqlite3` rather than loading it all.

Keep the script honest: no hard-coded results, no sample data standing in for
the real file. If the data cannot answer the question, say what is missing.

## 3. Present the findings

- Lead with the answer in one or two sentences, with the numbers that matter
  and their units.
- A few values: a sentence. Up to 20 rows: a Markdown table. More than 20
  rows: an A2UI `DataTable` (load the `a2ui` skill).
- A trend, a comparison or a distribution: a chart - load `a2ui` and
  `a2ui-charts`, write the chart data to `/workspace/charts/`, and state the
  one finding it shows.
- When the result is a file the user will keep (a cleaned CSV, a report),
  write it to the workspace and name it in the answer.
- Say which file and which rows or filters the numbers came from, and any
  assumption that changes them.
