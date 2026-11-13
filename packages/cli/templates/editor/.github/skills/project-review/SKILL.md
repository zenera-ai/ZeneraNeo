---
name: project-review
description: Review the project before committing - loads the `zen-review` skill and follows it (quick by default; say "full" for the sandbox build and model probes too).
disable-model-invocation: true
---

Load the `zen-review` skill now, before anything else, and follow it. It owns
the whole review: which depth to run, the mechanical checks and how to read
them, the judgement checklist, the suggestions and the report.

Choose the depth from what I typed after the command, as `zen-review` §1 says:
nothing, or "quick", is a quick review; "full", "everything" or "before commit"
is a full one. The entry point is
`.github/skills/zen-review/scripts/review.sh`.

Do not edit anything unless I ask.
