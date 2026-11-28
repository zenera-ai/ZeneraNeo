# Support mailbox triage and call booking

A specification for a Zenera project, written from a short brief.

> A support team triages a shared mailbox and books follow-up calls.

- [SPECIFICATION.md](SPECIFICATION.md) is the project, in the template's
  sections.
- [QUESTIONS.md](QUESTIONS.md) is what I would ask the customer first, and what
  the specification assumes until they answer.
- [check-operations.mjs](check-operations.mjs) checks the API claims in the
  specification against the two OpenAPI files.

## Check the API claims

```sh
node reports/support-mailbox-triage/check-operations.mjs
```

It reads the table under "Tools and boundaries" and fails if an operation named
there is not in `examples/mock-apis/specs`, or if the set of operations that
change anything is not exactly the two the specification says (`insertEvent`
and `sendMessage`).

## Worked check

Start the mock world as in
[examples/projects/02-api-integration](../../examples/projects/02-api-integration/README.md),
then give a project built from this specification the batch of unread
messages. In that world, Jonas Weber forwards Dana Kim's report that recurring
events from the Outlook integration show up an hour late after the DST change.
The handbook in `examples/mock-apis/kb/support.md` says calendar sync bugs that
shift times are always S2, so the report should show that case as a bug at S2
with a sentence quoted from the message.
