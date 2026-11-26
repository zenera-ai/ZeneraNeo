---
name: zen-wait
description: 'Pausing a run until a time in a Zenera project - the `wait:*` tool group (`wait`) that Zenera provides, where it works and where it only refuses, how to grant it in `agents.yaml`, the house rules `agents/wait-instructions.md` that reach every agent granted the group, how a wait ends (time, Run now, Stop, a new message), loops that wait again after each round, cron schedules and time zones, and debugging a wait that never ends. Load before adding, reviewing or debugging `wait:*` or the `wait` tool in a project, a prompt or skill that tells an agent to wait, repeat, or check back later, and whenever `wait.uninstructed` is reported.'
user-invocable: false
---

# Waits in a project

A run can pause until a time comes and then go on by itself: in N minutes, at a
given moment, or at the next slot of a cron schedule. Zenera provides this as
one tool, `wait`, in group `wait`. A project grants the group; Zenera records
the wait, computes when it ends, and resumes the run then. Nothing runs and
nothing is spent meanwhile, and the user's agent pod may sleep.

| Argument  | What it is                                                                 |
| --------- | -------------------------------------------------------------------------- |
| `minutes` | Wait this many minutes, 1 to 43200 (30 days)                               |
| `until`   | Wait until this ISO 8601 time, 1 minute to 30 days ahead; no offset: local |
| `cron`    | Wait for the next slot of this 5-field schedule, within 30 days            |
| `tz`      | An IANA zone, e.g. `Asia/Dubai`; the user's own zone without it            |
| `reason`  | One short line shown on the chat's card                                    |

Exactly one of `minutes`, `until`, `cron`. The call returns
`{ waited: true, firedAt }`, with `early: true` after Run now, and for cron
`slot` and `missed` (slots passed while it was late).

## 1. Where it comes from

- **The tool is Zenera's, not the project's.** Nothing goes in `agents.yaml`
  except the grant, which `zen init` writes for the default agent where a
  plugin provides the tool (`--wait` / `--no-wait` decide instead). How to use
  it reaches the agent as zen's own house rules,
  `agents/wait-instructions.md`, which every scaffold carries and which
  `requires: [tools:wait]` delivers only to agents granted the group.
- **Zenera computes the time.** The model passes minutes, a time or a schedule;
  it never works out a timestamp itself.
- **Each user has a limit** of pending waits (20). A call over it is refused.

## 2. Where it works, and where it only refuses

| Run                                                  | `wait`                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| A chat in the Zenera app; the editor's Test tab      | Pauses, and the run goes on when the wait ends                     |
| `zen run`, `zen meta`, batches, datasets, gym, a job | Present; every call fails _"Waiting is not available in this run"_ |
| Outside Zenera                                       | `zen check` / `zen run` fail with `unknown tool "wait:*"`          |

So you cannot exercise a wait from the terminal; check it in the Test tab. A
dataset case that depends on a wait fails for reasons unrelated to the change
under test. Outside Zenera, do not remove the grant - check the project in
Zenera instead.

## 3. How a wait ends

| Event                        | What the paused call returns                                            |
| ---------------------------- | ----------------------------------------------------------------------- |
| Its time comes               | `{ waited: true, firedAt, slot?, missed? }`                             |
| The user presses **Run now** | The same, with `early: true`                                            |
| The user presses **Stop**    | Fails: the user stopped the wait; the agent does not wait again unasked |
| A new message in that chat   | Fails as superseded, then the agent sees the message. The loop stops    |

A wait ends a few seconds to about 30 seconds late, plus the time the agent pod
takes to start if it was asleep.

**Loops** are the agent calling `wait` again with the same arguments after each
round. Each wait lives in the chat that started it, so a message there ends the
loop; the house rules tell the agent to say so and to restart only when asked.
Each round adds a turn to the chat: keep rounds short. A loop meant to run for
weeks, or alongside other chatting, is not what waits are for.

## 4. What a project with `wait:*` needs

`zen check` reports the house rules missing (`wait.uninstructed`) or edited
(`rules.stale`). It does not report the rest of this list.

1. **Grant it only to agents the user may ask to wait, repeat or check back.**
   `tools: [wait:*, ...]`. A router or a summariser does not get it.
2. **Keep zen's house rules.** `agents/wait-instructions.md` is the only thing
   that tells a running agent when not to wait, how to give the time, and what
   Stop and a new message mean. Never edit it; `zen check --fix` restores it.
   Project policy (for example, the shortest interval this project allows, or
   which jobs may loop) goes in `agents/wait-policy-instructions.md` with
   `requires: [tools:wait]`.
3. **A prompt line saying when to reach for it**, for example: _"When the user
   asks you to check again later or on a schedule, use `wait`."_
4. **Side effects outside the wait.** A prompt or skill that loops must do its
   sends, posts and writes in the agent's turn, and say whether to ask first.
5. **Time zones.** Times of day are in the user's own zone, which Zenera takes
   from their browser. A prompt or skill needs a fixed `tz` only when the
   project is about another place (a store's opening hours, a market's close);
   then it says which zone.

## 5. Review checklist

- [ ] `agents/wait-instructions.md` is present and not `rules.stale`.
- [ ] Only agents that should pause have `wait:*`.
- [ ] No prompt or skill tells the agent to wait on its own initiative, or to
      sleep or poll in a command instead of `wait`.
- [ ] Loops do their writes in the agent's turn, and say when to ask first.
- [ ] Schedules about a place other than the user's say which `tz`.
- [ ] No dataset or `zen run` check expects a wait to complete.

## 6. When it goes wrong

| Symptom                                                    | Cause and fix                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `unknown tool "wait:*"` at load                            | Not a Zenera environment - §2. Not a project error                                     |
| Every call: _"Waiting is not available in this run"_       | A terminal, batch or job run. Use the chat or Test tab                                 |
| `wait.uninstructed`                                        | The house rules file is missing or empty. `zen check --fix`                            |
| `give exactly one of minutes, until or cron`               | The agent passed none or several - check the prompt does not ask for both              |
| `until is an ISO 8601 time …` / `time zone is not known`   | An impossible date; or a local time from a user whose browser never reported a zone    |
| A cron wait fires at the wrong hour                        | The user's zone is not known yet (UTC), or a prompt fixes the wrong `tz` - §4.5        |
| `you already have 20 waits pending`                        | Old waits in other chats. Stop them from their cards                                   |
| The card shows the wait ended, but the agent did not go on | The chat or user was busy; it is retried every 15 s. Or the run failed: send a message |
| A loop stopped after the user asked something              | Expected: a new message ends the wait - §3. Ask the agent to restart it                |
| The agent waits when nobody asked                          | A prompt or skill invites it. Remove that line; the house rules forbid it              |
