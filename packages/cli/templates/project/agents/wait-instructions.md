---
requires: [tools:wait]
---

# Waiting (the `wait` tool)

`wait` pauses this run until a time comes, then continues it by itself: the
call returns, and you go on from there. Meanwhile nothing runs and nothing is
spent. The chat shows a card with the time, **Run now** and **Stop**.

It works only in a chat or the Test tab. If a call says _"Waiting is not
available in this run"_, tell the user and do not try to wait another way
(no sleeping in a command, no polling).

## When to wait

Only when the user asked to wait, to do something later, or to repeat
something on a schedule ("check again in 10 minutes", "every weekday at 9").
Never wait instead of answering, to "give it time" on your own, or to space
out your own steps.

## Before you call it

1. Finish this turn's work: anything the user should see now is in this
   answer, before the wait.
2. Tell the user in one sentence what you wait for and until when, and that
   they can press Stop, or Run now to go on early.
3. Do side effects - sending, posting, writing, deleting - before or after a
   wait, never relying on the wait to do them. Ask before writes in a loop
   unless the user's message asked for exactly those writes.

## Giving the time

Give exactly one of:

- `minutes`: from now, 1 to 43200.
- `until`: an ISO 8601 time **with its offset**, e.g.
  `2026-11-27T09:00:00+04:00`, from 1 minute to 30 days ahead.
- `cron`: a 5-field schedule (minute hour day-of-month month day-of-week),
  with `tz` - the user's IANA time zone, e.g. `Asia/Dubai`. The wait ends at
  the next matching slot. Without `tz` it is UTC: if you do not know the
  user's zone, ask.

The time is computed by the host, not by you: never work out a timestamp from
what you remember the date to be. Add a short `reason` - it is shown on the
card.

## When it ends

The call returns `{ waited: true, firedAt }`, and:

- `early: true` - the user pressed Run now.
- For `cron`: `slot`, the slot it waited for, and `missed`, how many slots
  passed while it was late. Do not catch up on missed slots unless asked.

## Loops

To repeat, do the round's work, answer briefly, then call `wait` again with
the same arguments. Keep each round's answer short: the chat grows by one
turn per round.

## When it fails

- **Stop**: the call fails saying the user stopped the wait. Say the loop
  stopped, and do not wait again unless they ask.
- **A new message while waiting** ends the wait: the call fails as
  superseded, then you see the message. Answer it, and do not wait again on
  your own. If a loop was running, end your answer with one sentence: the loop
  stopped, and the user can ask to restart it. On "go on" or "restart", call
  `wait` with the same arguments.
- **Refused** (a time out of range, too many waits pending): fix the arguments
  once, or tell the user what was refused.
