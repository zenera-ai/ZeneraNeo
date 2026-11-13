# Specification

## Purpose

Help a user coordinate a meeting by finding relevant requests in a mailbox,
checking calendar availability, proposing a time, and - after the user confirms
the exact time and recipients - calling the calendar and mail APIs to create an
event and send a confirmation.

This example uses mock APIs only. It demonstrates integrations and workflow
boundaries; it does not book real meetings or deliver real email.

## Scope

- Work on one meeting request at a time.
- Search the mock mailbox for relevant messages, then fetch a message before
  relying on its full contents. Summarize the source message and extract its
  requested attendees, duration, date range, and other scheduling constraints.
- Ask the user for missing information that prevents a useful availability
  check or proposal. Do not guess attendee addresses, a duration, or a time
  zone.
- Check availability using the Calendar API's free/busy operation. Propose a
  specific available interval and state the time zone and attendees used for
  the check.
- Do not create an event or send a message until the user explicitly confirms
  the proposed interval and recipients in the current run. A request to find or
  propose a meeting is not approval to perform either write.
- After confirmation, call the Calendar API to create the event and the Mail
  API to send the confirmation. Report each call and its response separately.
- If a call fails, a response is missing, or the response is ambiguous, say so.
  Do not claim that an event was saved or a message delivered based only on an
  attempted call.

## Models

- `openai/gpt-5.6-luna` — one model for the whole project.

## Agents

`default` — the only agent.

It manages the workflow, reads messages,
coordinates availability, obtains approval before writes, and reports the API
calls and their results. It may use sandbox command tools to call the local
integration scripts. No other agent is needed.

## Integrations

The project keeps copies of both OpenAPI contracts in the `mock-apis/spec`:
`mock-apis/specs/calendar.yaml` and `mock-apis/specs/mail.yaml`. The mock server is already started (you do not run it):

```sh
zen gym serve \
  --schema mock-apis/specs \
  --story mock-apis/stories/northwind-launch.md \
  --docs mock-apis/kb \
  --host 0.0.0.0 \
  --port 8787 \
  --requests-dir .tmp/gym-requests
```

Implement small, readable integrations in the generated project that use the
available sandbox networking and standard Node.js `fetch`. Read API base URLs
from the environment, remove a trailing slash before adding endpoint paths,
encode path and query values correctly, send JSON with the correct content
type, and check HTTP status before interpreting a response. Never embed a key
or other credential in source code or a prompt. The mock APIs require no
service credentials.

Use `me` for the Mail API's user ID and `primary` for the user's calendar. Treat
calendar IDs and message IDs as opaque strings. When creating an event, include
the attendee response status required by the mock schema. Do not invent API
fields or silently substitute an endpoint when a call fails.

## Environment

- The mock service is started separately with both OpenAPI documents. It is not
  part of the generated project's lifecycle.
- Default both API base URLs to `http://host.containers.internal:8787`.
- The sandbox needs network access to the mock service. The host running Gym
  must listen on an address reachable from the sandbox.
- Give the coordinator `sandbox:*` so it can invoke the generated integration
  scripts.
- Gym simulates a stateful mailbox and calendar that follow a story: writes are
  visible to later reads, but nothing is delivered or booked for real. Never
  claim a create/send response proves real booking or delivery.
- No document index, persistent memory, real credentials, or real mail/calendar
  account is in scope.

## Done means

- A read-only request finds and fetches a relevant message, identifies its
  constraints, checks availability, and proposes a specific slot with the time
  zone and attendees stated.
- An incomplete request results in a focused clarification rather than an
  invented value.
- No create-event or send-message request is made before explicit user approval
  of both the proposed time and recipients.
- After approval, the agent reports whether the Calendar and Mail calls each
  succeeded and what their mock responses contained.
- The final answer clearly distinguishes generated mock responses from real
  availability, persistence, booking, or email delivery.

## Out of scope

- Accessing real accounts or sending real email.
- Persistent state in the project itself between runs.
- Automatically accepting or declining invitations, changing existing events,
  or deleting events.
- Resolving conflicts by moving or cancelling other meetings.
