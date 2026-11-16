# Specification

What this project is for. The files around it are the implementation; where the
two disagree, this one wins.

## Purpose

Help a support team work through a shared mailbox. Read the new messages, say
what each one is and how urgent it is, and when a person asks for a call about a
case, find a free slot, propose it, and book it and send the confirmation only
after that person approves.

Reading and proposing are free. Anything that changes the calendar or sends mail
waits for a yes.

## Scope

- One run covers one batch: the unread messages in the shared mailbox, newest
  first, at most 50 per run. If more are waiting, the reply says how many were
  left. It never drops them quietly.
- A message is fetched in full before it is classified. Listing returns ids
  only, so a classification made from a list entry has nothing behind it.
- Messages in one thread are one case. A customer who wrote three times is one
  line in the report, not three.
- A call is booked for a case only when a person names that case and asks for
  it. Triage on its own never books anything.
- One booking at a time, one case at a time.

## Models

- `openai/gpt-5.4-mini` - one model for the whole project, the same one
  `zen init` writes. This is a placeholder until the customer answers Q9 in
  [QUESTIONS.md](QUESTIONS.md), and it is named once in `agents.yaml` so it can
  be changed in one place.

## Setup

- No steps. Nothing has to be built before a run.
- The mock mail and calendar APIs must already be running. The project does not
  start them. See Environment.

## Agents

- `triage` - the entry point. Lists the unread messages, fetches each one,
  groups them by thread, and writes the triage report. It has no tool that
  writes. When a person asks to book a call for a case, it hands off to
  `scheduler` with the case, the people involved and what the person asked for.
- `scheduler` - checks availability, proposes one slot, and waits. After the
  person approves that slot and those recipients, it creates the event and sends
  the confirmation. It hands back to `triage` when the booking is done or
  refused.

Two agents because the line between "reads" and "writes" is the one that
matters, and it is easier to hold when one agent has no write tools at all than
when one agent is told to be careful.

## Tools and boundaries

| Operation       | API      | Changes anything | Used by     |
| --------------- | -------- | ---------------- | ----------- |
| `listMessages`  | Mail     | no               | `triage`    |
| `getMessage`    | Mail     | no               | `triage`    |
| `listThreads`   | Mail     | no               | `triage`    |
| `queryFreeBusy` | Calendar | no               | `scheduler` |
| `listEvents`    | Calendar | no               | `scheduler` |
| `getEvent`      | Calendar | no               | `scheduler` |
| `insertEvent`   | Calendar | **yes**          | `scheduler` |
| `sendMessage`   | Mail     | **yes**          | `scheduler` |

- `insertEvent` and `sendMessage` are the only two calls that change anything,
  and neither is made until the person has approved the exact time, the time
  zone and the recipients in this run. "Find a time" is not approval.
- The mock APIs have no operation to label, archive or mark a message read, and
  none to edit or delete an event. So the project cannot mark a case as handled
  in the mailbox and cannot undo a booking. The triage report is where the
  result lives, and a wrong booking is for a person to remove.
- `sendMessage` sends as the mailbox owner. It takes `to`, `cc`, `subject`, `body`
  and `threadId`, and nothing else. No attachments, no other sender.
- The calendar can only be checked for calendars the project is given access
  to. An attendee whose calendar it cannot read is reported as unchecked, not
  as free.
- Use `me` for the mail user and `primary` for the calendar. Treat message ids,
  thread ids and event ids as opaque strings. Do not invent a field the API
  does not have, and do not swap in a different endpoint when one fails.
- No key or credential goes in source or in a prompt.

## Environment

- Both API base URLs come from the environment and default to
  `http://host.containers.internal:8787`. A trailing slash is removed before a
  path is added.
- The calls are made by small scripts in the project that use `fetch` from
  inside the sandbox, which needs network access to the host running Gym.
- Requests are recorded with `--requests-dir .tmp/gym-requests` when Gym is
  started, which is what the tests below read.
- The time zone comes from the person asking. It is never guessed from the
  server or from an address.
- Do not rely on a later read showing an earlier write. After `insertEvent`,
  call `getEvent` on the returned id and report what came back. If it does not
  match, say so.

## Testing

- `zen check` passes.
- Coverage: for a batch of N ids returned by `listMessages`, the request log
  shows N `getMessage` calls, one per id, before the report exists, and the
  report lists all N (or all cases, with N ids behind them).
- Evidence: every line in the report quotes the sentence it relied on, and that
  quote is an exact substring of the message body returned by `getMessage`.
- No invented rating: a case gets a severity only from the rules the customer
  gave. Without a rule that applies, it is `unrated` and the reason is stated.
- Approval: in the request log, no `POST` to the events or send endpoints appears
  before a turn in which the person approved a named time, zone and recipient
  list. Count of such writes before approval: 0.
- Missing input: a booking request with no attendee, no duration or no time zone
  gets one question naming what is missing, and no availability call is made
  until it is answered.
- Availability: the `queryFreeBusy` request lists every attendee whose calendar
  the project can read, and the proposed slot overlaps none of the busy
  intervals returned.
- Confirmation: after approval, the reply reports `insertEvent` and
  `sendMessage` separately, each with its status and the id it returned.
- Worked check against the mock world in `examples/mock-apis` (see
  [README.md](README.md)): the Acme message about recurring events arriving an
  hour late after the DST change is classified as a bug at S2, because the
  handbook says calendar sync bugs that shift times are always S2.

## Done means

- Every unread message in the batch is either in the report under a case with a
  category, a severity (or `unrated` with a reason) and a quoted sentence, or
  named as left over with a count.
- A booking exists only if a person approved it, and the reply says what was
  created, what was sent, and what each call returned.
- The reply says when something could not be checked (a calendar it cannot read,
  a call that failed, a response that did not match) and does not fill the gap
  with a guess.
- Anything the mock produced is called a mock response, never proof that a real
  meeting was booked or a real email was delivered.

## Out of scope

- Labelling, archiving, assigning or closing cases. The API cannot, and the
  report is the output.
- Replying to customers about their problem. Only the confirmation of a booked
  call is sent, and only after approval.
- Moving, editing or cancelling existing events, or resolving a clash by moving
  somebody else's meeting.
- Memory between runs, a document index, a second mailbox.
- Real accounts and real credentials. This is built against the mock.
