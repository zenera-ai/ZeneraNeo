# Writing Python scripts

Every script you write is a tool for the next question like this one, not an
answer to this one. Write it once, generically, so it can be remembered and run
again unchanged.

## Before writing

If you hold `memory_search`, search for a script that already answers this kind
of question, and load the best match with `memory_load`. If it fits, run it with
this question's arguments and write nothing new. If it needs a change, change
it the way the rest of this skill says - usually by adding an argument - and
commit the new version as superseding the old one.

## Writing

1. **Solve the kind of question, not this one.** Anything that would differ the
   next time - inputs, ids, names, paths, urls, dates and date ranges, filters,
   thresholds, limits, the output path - is a named `argparse` argument such as
   `--resource-id`, never a literal in the code. A default is allowed only for a
   value that is the same for every question.
2. **Name the file for what it does**, verb first: `list_overdue_invoices.py`,
   `compare_quarterly_revenue.py`. Never `script.py`, `test.py`, `tmp.py` or a
   name that only makes sense in this conversation.
3. **Describe it.** Line one is a docstring saying what question it answers. The
   same sentence is the `argparse` description, and every argument has a
   `help=`, so `--help` is all a later reader needs.
4. **Print the result to stdout** and anything else to stderr. Exit non-zero
   with a message saying what failed when it cannot answer. A file it produces
   goes to the path given by `--output`.
5. **Take credentials from environment variables by name.** Never write a key,
   token or password into the code or an argument default.
6. **Take the user you act for from the run, never from an argument.** When the
   answer depends on who is asking - their records, their permissions, their
   account - read it with `zenera.require_identity()` (`import zenera`; `.id`,
   `.email`, `.role`, `.source`). It exits with a clear error when the run has no
   signed-in user. Never add `--user-id` or `--email` for the person asking, and
   never copy their id from the conversation into the code or the command: the
   model cannot vouch for who someone is, and the run already knows. An argument
   is right only for a _different_ user the question names - `--assignee` - and
   then the script still checks `require_identity().role` before acting for them.
7. **Use only what the sandbox image already has.** Do not `pip install` from
   the script or before running it.
8. **Write it to a file and run the file**:
   `python /workspace/scripts/<name>.py --resource-id 42`. Never run Python
   with `python -c` or a heredoc.

## Before using its output

- Run it, and fix the script - not the output - when it fails or prints
  something wrong.
- Read your own code against a different question of the same kind. If
  answering it would mean editing the script rather than passing other
  arguments, a value is still hard-coded: make it an argument and run again.
  Asked by a different user, the same script must answer for them with the
  same command: if it would not, the user is hard-coded or passed in - read it
  from `zenera.require_identity()` instead.
- If you hold `memory_commit`, commit the working script as a `file` node. Its
  text says what kind of question it answers and names its arguments, so that a
  later search for a similar question finds it.
