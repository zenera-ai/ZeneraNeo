# A saved meeting missing from the calendar list

A scheduling agent said a meeting was booked after receiving HTTP 200 and a confirmed event. The mock saved that event and returned it through a lookup by ID, but its primary calendar list omitted the event for the same time window.

This contribution provides captured evidence and an offline diagnostic that makes the disagreement reproducible.

## What happened

The test used ZeneraNeo at `00d1017e9becfbb03bb3f5586d1518f8cd96e2b2`, Node 24.22.2 and `openai/responses:gpt-4.1-mini-2025-04-14`. The service used the Calendar example, the Northwind launch story and an existing `booking-lab` world. No explicit seed was supplied, so this revision's server chose a random seed per request. The captured handlers and records are the reproducible artifact. [Reproduction details](REPRODUCE.md) include the service flags, agent setup, snapshot method and capture format. Generating a fresh world may produce different handlers and data.

The requested meeting was **Booking verification 01**, November 6, 2026, from 14:00 to 14:45 in Europe/Berlin. The equivalent UTC interval is 13:00 to 13:45. All attendee addresses and account details in the evidence belong to generated mock data. No real calendar or invitations were involved.

| Observation                                   | Evidence                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| The user confirmed creation                   | The agent received an explicit instruction to create this meeting once                                   |
| The service accepted the request              | One create HTTP request returned 200 with the requested times and attendees                              |
| The event was stored before read verification | A direct database snapshot contained the exact returned event ID and body                                |
| The agent said it was booked                  | Its claim is retained verbatim in `capture.json`                                                         |
| The primary calendar list omitted it          | A live list request for the exact interval returned `{"items":[],"timeZone":"UTC"}`                      |
| Lookup by the existing ID worked              | A live GET returned 200 and the exact stored event body                                                  |
| Reads did not fabricate or remove it          | All 15 records, population markers and report fingerprints were unchanged across the list and GET checks |

The database contained one new event. Its `status` was `confirmed`, and its three attendees had `needsAction`. That status does not mean the attendees accepted an invitation. The event had no `calendarId`. Its organizer came from the mock's existing owner account, which differed from the identity in the user's meeting prompt.

## How the evidence was collected

1. Preserve the running world and generated handlers. Record a database snapshot before creation.
2. Have the agent propose the meeting and wait for human confirmation.
3. Capture the create request, response and the agent's conclusion separately.
4. Read the database directly before any API read verification. Do not retry an ambiguous create.
5. List the same calendar for the exact interval and capture the response. Compare the database again.
6. Read the exact returned ID from the completed create command's saved output, then perform one GET. Compare its body and the database again.

There were two create command attempts. The first lacked a UTC offset and failed local client validation before sending HTTP. The agent then corrected the offset and launched the command in the background despite instructions to stop after an error and use the foreground. It stopped waiting after about eight seconds. The single HTTP create completed after 15.706 seconds. Recovering that existing job's output avoided a duplicate booking.

The final list took 112 ms and the exact-ID GET took 56 ms. These are individual observations, not a performance benchmark. The list was also run in the background despite the foreground instruction. Its final result was captured successfully.

## Ranked causes

**1. Confirmed mechanism in this mock: inconsistent calendar association.** The generated [insert handler](fixtures/insert-original.mjs) reads the route's calendar ID but does not put it in the event. The generated [list handler](fixtures/list-original.mjs) resolves `primary` to the owner's ID and excludes every event without that association. Replaying the list offline omitted the stored event. Adding `calendarId: "@me"` to an in-memory copy made that same event appear. The live data was not changed.

**2. A build check does not cover the whole workflow.** The [handler judge](../../packages/gym/src/generate.ts) checks one operation's responses, path echo and paging. That check does not establish that creating an event makes it visible to its sibling list operation. The example's `Event` schema also has no calendar association field, so the omission is not itself a response-schema violation. Adding a required field needs care: the generic path-echo check expects a literal matching path value, while alias guidance normalizes `primary`. An untested field change could create another disagreement. A useful next product test is create, inspect storage, list the same calendar, then confirm exclusion from another calendar in an isolated world.

**3. Agent confirmation was stronger than its verification.** The agent based its initial booked claim on the create response. The controlled prompts explicitly told it to stop after creation and make no further calendar requests while recovering the result, so it was not allowed to check list visibility at that point. The narrower problem is the wording: it should have said creation was accepted but visibility was not independently verified. This did not cause the service omission. The agent later reported the empty list accurately when authorized to check.

The final create and list used the correct interval, and the new event never had a calendar association. Stable read-boundary snapshots rule out deletion during those observations. The encoded URL rules out a lost plus sign in the time-zone offset. Earlier exploration is outside this captured reproduction.

### Contract, meaning and state

| Layer    | What the evidence establishes                                                                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract | The captured create request and all three response bodies pass the pinned repository's `Checks` validators against `calendar.yaml`. A missing `calendarId` does not violate that schema. The standalone diagnostic checks consistency, not the complete OpenAPI contract.                                       |
| Meaning  | Creation and listing disagree about calendar membership. The pinned [handler prompt](../../packages/gym/src/prompt.ts) says later reads must see created records and caller aliases must resolve consistently. The in-memory calendar-association control isolates the disagreement in these captured handlers. |
| State    | This revision's [store](../../packages/gym/src/store.ts) persists records in SQLite. The row was already there before either verification read, and the snapshots stayed unchanged. Stateless behavior does not explain this observation.                                                                       |

## What I would tell the customer

“Sorry for the confusion with your booking. I found a similar issue in testing where a meeting was saved but didn’t appear on the calendar. I’ll check whether that happened with yours and whether invitations were sent. Please hold off on booking it again while I check, since that could create a duplicate. Could you send the meeting date, time, time zone and the calendar you checked? I’ll update you within 30 minutes, even if I’m still investigating.”

The supplied scenario contains only the customer's report that the booking is missing. It gives no meeting date, time, time zone or calendar identifier, so those questions remain. In a real support case, I would first retrieve any of these details from the existing conversation and request logs, then ask only for what is missing. The 30-minute commitment is for a progress update while the investigation continues. I would compare the customer's meeting details and confirmation message with the corresponding request logs to establish the cause.

## The diagnostic improvement

Run from the repository root with Node 24.22.2 or later:

```sh
node reports/calendar-booking-consistency/diagnose.mjs reports/calendar-booking-consistency/capture.json
node --test reports/calendar-booking-consistency/diagnose.test.mjs reports/calendar-booking-consistency/replay.test.mjs
```

The offline reproduction needs only Node and this folder. It needs no API key, container, installed project dependencies or access to the original machine. It replays saved evidence and selected handlers, not a newly generated Gym world.

The diagnostic compares the create response, a database snapshot taken before read verification, the list result, the exact-ID GET and the final database snapshot. It separates a saved event omitted from a complete list from absence in the supplied snapshots or inconclusive evidence. An `absent_from_snapshots` verdict also requires the complete records to match a pre-create baseline. A different saved ID, disappearing records or a missing baseline makes that verdict inconclusive. When encoded request targets or raw response text are supplied, they must agree with the parsed fields. Duplicate URL parameters and an unescaped plus in a time-zone offset cannot silently change the interpretation. It does not send requests, load credentials or execute supplied handler code. A completed diagnosis exits zero even when it identifies an inconsistency. Invalid input exits nonzero.

For the supplied capture, the expected verdict is `persisted_omitted_from_list`: the event was stored and retrievable by ID, while the calendar list omitted it.

The same evidence structure makes the next investigation shorter. Preserve the exact returned ID, calendar, time window and complete response pages. Check storage before read-back when the service may synthesize missing data. A timeout should trigger investigation of the existing attempt, not an automatic retry.

The agent should say that creation was accepted while verification is pending, and only confirm visibility after a same-calendar read-back succeeds. If results disagree, it should report the disagreement without retrying the write. Validate this proposed prompt change in a separate agent run before adopting it. Existing Gym request dumps can supply HTTP evidence without adding another logger. When direct storage access is unavailable or the serving store cannot be identified, report the HTTP observations and leave persistence unresolved.

### A faster next investigation

1. Confirm which calendar and account the customer checked, the requested time zone, whether a success message included an event ID, and whether any retry happened.
2. Save the original create attempt, its completed output and elapsed time. Correlate its returned ID with the agent's claim instead of treating a background job's wait time as API latency.
3. Preserve the world before read verification. Use the returned ID, the same calendar and an overlapping time window. Save all pages or leave the result inconclusive.
4. Run the diagnostic against that evidence. Record the source revision, model, seed configuration, handler fingerprints and response cache headers when available. The original client did not retain cache headers. Include them in future captures.

The server can build a handler or generate missing data on demand. A slow initial request and fast repeat warrant checking those phases before optimizing a database query or adding retries. Separate cold setup, model generation, handler execution and agent waiting in future timing traces. The measurements here do not isolate those phases or establish a speed improvement.

### What the tests establish

| Check                              | Acceptance criterion                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded incident                  | Exactly one matching stored row, no read-time change, matching GET and omission from the complete list                                                    |
| Counterexample                     | A consistently stored and listed event reports visible                                                                                                    |
| Incomplete or conflicting evidence | Wrong calendars or IDs, partial pages, filters, changed records, missing timing and contradictory wire fields do not produce a confident omission finding |
| Captured-handler replay            | Insert stores the event, list omits it, and adding the association only to a copy restores list visibility while another calendar stays excluded          |
| Scope boundary                     | GET by ID can work for another calendar, so it cannot establish membership by itself                                                                      |

The replay uses an in-memory substitute for the runtime context to isolate how the captured handlers behave. The tests verify that the diagnostic detects the problem and rejects the covered counterexamples. A future runtime patch would also need an end-to-end test.

## Scope and decisions

- This was one run against one generated handler set. It does not establish a failure rate across regenerations.
- The captured GET handler ignores calendar ownership. A successful GET proves retrieval by ID, not membership in the primary calendar. It can also synthesize a missing ID, which is why the exact existing ID and before/after snapshots matter.
- The diagnostic covers one nonrecurring timed event and complete captured list results. It requires explicit UTC offsets with at most millisecond precision, exact full-body equality, and comparable wall clocks for requests and snapshots. Missing or inconsistent timing is inconclusive. A page at its requested size, or this captured handler's default of 20, is conservatively inconclusive even without a continuation token. It is not a recurrence engine, a full schema validator, or a live calendar checker. Its omission label describes an observation, not a universal guarantee that the event belongs in that calendar.
- The baseline includes records generated and rewritten during earlier reads. I preserved that state before creating a uniquely titled meeting, making it possible to identify the new record and compare what changed.
- The public guidance describes a mock that keeps no state, while the pinned [Gym design](../../packages/gym/DESIGN.md) and [Gym documentation](../../packages/gym/README.md) describe a persisted world. If a mock were actually stateless, a later missing event alone would not establish a write defect. This report follows the observed SQLite implementation and asks maintainers to clarify the version mismatch.
- The original service and its records remain unchanged. A later contract or builder fix needs a separate isolated world and meaningful create/list/other-calendar tests. Generic merge behavior would not fix a brand-new event missing its association.

## Questions for maintainers

- Should the public stateless-mock guidance be updated for this persisted-world revision, or is the exercise intended for a different version?
- What canonical calendar identity should sibling handlers share, and how should that identity coexist with the literal path-echo check?
- Should a diagnostic read have a way to refuse missing-record synthesis, so checking whether a write happened cannot create the evidence being checked?

## Provenance and assistance

`capture.json` retains the HTTP bodies, encoded request targets and all captured database records. Request origins were removed, SQLite JSON strings were decoded into objects, and machine paths and credentials were excluded. It includes source revision, model, original snapshot fingerprints and hashes for the byte-exact captured handlers. These handlers were generated during this run and are included as captured evidence. A scoped Git attribute preserves their bytes across Windows checkouts.

`agent-excerpts.json` contains only five controlled test turns covering planning, creation, recovery of the create result, listing and exact-ID lookup. It includes the actual prompts, tool calls, results and agent answers. Its local service origin is replaced with a reserved `.invalid` address. It does not include the full conversation.

I drove this investigation by running the booking workflow and asking for direct checks that the meeting was actually saved and appeared in the calendar. I ran the offline diagnostic and tests myself, questioned the slow response, and pushed for another review of the source code, setup and failure cases before submission. I also made checking for exposed credentials part of the review. Under my direction, Codex helped write the setup, API client, evidence extraction, diagnostic, tests and report, and Claude Code independently reviewed and tested the work. My focus was on understanding what happened, challenging the results and making the explanation clear enough for someone else to verify.
