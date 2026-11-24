---
name: data-analysis
description: Analysing data - CSV, Excel, JSON, Parquet or tables in files or tool results - with Python, pandas and DuckDB in the sandbox, then presenting the findings as text, a table, a DataTable, a chart or an interactive HTML dashboard. Load before any calculation over more than a handful of values.
tags: [data, analysis, python, duckdb, charts, dashboard]
version: 1.1.0
---

# Data analysis

Compute, do not estimate: every number in your answer comes from code you ran
over the real data. Arithmetic done in your head is a guess.

## Tools in the sandbox

The project's sandbox image is expected to provide:

| Tool                                                                                           | Use it for                                                                                          |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `python` (standard library: `csv`, `json`, `statistics`, `sqlite3`, `datetime`, `collections`) | Counts, sums, averages, group-bys and joins on moderate data                                        |
| `pandas` + `openpyxl`                                                                          | Dataframes, messy data, reading and writing Excel                                                   |
| `duckdb` (Python)                                                                              | SQL straight over CSV, Parquet, JSON and dataframes; large files that do not fit pandas comfortably |
| `pyarrow`                                                                                      | Parquet and Arrow files; fast CSV reading; moving data between pandas and DuckDB                    |
| `scikit-learn` (`sklearn`)                                                                     | Regression, classification, clustering, scaling and encoding, train-test splits, metrics            |
| `lightgbm`                                                                                     | Gradient-boosted trees on tabular data: stronger predictions and feature importance                 |
| `sqlite3` (CLI and Python)                                                                     | SQLite databases and SQL dumps                                                                      |
| `jq`                                                                                           | Quick looks at and filters over JSON                                                                |
| `pdftotext` (poppler-utils), `pandoc`                                                          | Pulling tables and text out of PDFs and documents                                                   |
| `node`                                                                                         | Scripts, if easier than Python                                                                      |

If an import fails, `pip install --user <package>` for this run and suggest
adding it to the project's sandbox image (its `Dockerfile`).

## 1. Look at the data first

- Find the file (or save the tool result under `/workspace/.tmp/`) and look
  at its shape before analysing: the first rows, the column names, the row
  count, and the types.
- Note what is missing or odd - empty cells, mixed units, duplicate rows,
  dates in several formats - and say how you handled it.

## 2. Compute with Python

Write the script to a file under `/workspace/.tmp/` and run it with `python`, so it can
be fixed and rerun. Print only the results you need.

- The standard library is enough for counts, sums, averages, group-bys and
  joins on moderate data.
- For larger or messier data, or Excel files, use pandas (with openpyxl for
  Excel).
- Read Excel with `pandas.read_excel(path, sheet_name=None)` to see every
  sheet before picking one.
- Large CSV, Parquet or JSON files, or a question that is naturally SQL: query
  them in place with DuckDB (`duckdb.sql("SELECT ... FROM '/workspace/data/*.parquet'")`,
  `.df()` for a dataframe) instead of loading everything into memory.
- Parquet or Arrow files: read with `pyarrow` or DuckDB; write cleaned
  intermediate data as Parquet when it will be reused.
- SQLite or a SQL dump: query it with `sqlite3` rather than loading it all.
- Predicting, segmenting or explaining what drives a number: start with a
  simple scikit-learn baseline (linear or logistic regression), then LightGBM
  if the data is tabular and the baseline is weak. Hold out a test set (or
  cross-validate), report the metric on data the model never saw next to the
  baseline's, and list the most important features. Fix `random_state` so
  the numbers are reproducible. A model is evidence, not proof: say how
  sure it is and on how many rows.

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
- A complex report - several related charts, tables and breakdowns, or data
  the user will want to filter, sort or drill into - is an interactive HTML
  dashboard, not a long reply: load the `html-page` skill. Its page shows
  only numbers your script wrote to its `data.json`.
- When the result is a file the user will keep (a cleaned CSV, a report),
  write it to the workspace and name it in the answer.
- Say which file and which rows or filters the numbers came from, and any
  assumption that changes them.
