# Specification

## Purpose

Answer questions about the Hugging Face Transformers documentation from an index of it, quoting the passage the answer came from.

## Models

- `openai/gpt-5.6-luna` — one model for the whole project.
- `openai/text-embedding-3-small` — the vectors, for the index and memory both.

## Setup

Download `https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/examples/projects/common/markdown-documentation-transformers.zip`
into `.tmp/`, unzip it, create an index and store it in `assets/docs-db`. It skips when that index
can already answer, and re-embeds it from its own `sources/` when the index is present but its
vectors are not.

## Agents

`default` — the only agent.

- Hugging Face documentation assistant.

- The index is the only source. It lists the documents once before its first search, and never answers from its own recollection of the library.
- Anything outside the Hugging Face documentation — another library, the weather, a code review — is declined outright, with a line on what it does cover.
- Every answer names the document and the paragraph it came from.
- Recalls before answering, and commits what it found, so the same question is not searched twice.
- Enable all file tools.

## Knowledge

- `assets/docs-db` — the Transformers documentation, read-only at `/assets`.
- create and preload a skill that explains how to do search.

## Memory

- use workspace files to store memory files for large data chunks.
- always try to answer from memory first if all data in memory.
- always save results that took some work to obtain.
- always store detailed sources of information in memory files.
- analyze what queries were made to the memory.
    - if nothing was found and you had to do some work to obtain the result, save it to memory.
