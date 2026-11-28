# Questions and assumptions

For the customer, before anything is built. Blocking questions first. Each one
says what goes wrong without an answer and what the specification assumes
meanwhile.

## Blocking

**Q1. What does a support person do with the triage result?**
Without an answer the report is guessed at. The mail API cannot label, archive
or mark a message read, so the result cannot live in the mailbox. Assumed: a
report in the chat, one line per case.

**Q2. What are the categories and the severity rules?**
Without them the project invents a scheme that sounds right. Assumed, for
testing only: the mock handbook's rules (S1 outage, S2 wrong data with no
workaround, S3 wrong data with a workaround, calendar sync bugs that shift
times always S2), and `unrated` for anything else.

**Q3. Who can be booked, and whose calendar can the project read?**
A customer's own calendar usually cannot be read, so free time for them is
unknown, not free. Assumed: only internal calendars are checked, and external
attendees are reported as unchecked.

**Q4. Who approves a booking, and how?**
Assumed: the person in the session who asked for the call, once per booking,
by naming the time, the zone and the recipients.

**Q5. Is the shared mailbox the `me` mailbox, or does the project act for a
named user?**
A real shared mailbox often needs delegated access. Assumed: `me` is the shared
mailbox.

## Ambiguous

**Q6. Working hours, time zone and call length.**
The proposed slot has to sit inside something. Assumed: the person gives a time
zone and hours in the request, there is no default, and the call is 30 minutes
unless a case type has its own length.

**Q7. How big is a batch and how fresh must it be?**
Assumed: unread only, newest first, 50 per run, with the leftover count
reported. Real volume may need paging or a time window.

**Q8. Who gets the confirmation, from whom, in what words?**
`sendMessage` always sends as the mailbox owner. Assumed: the approved
recipients only, a short plain message with the time, zone and the thread it
belongs to.

**Q9. Which model provider is allowed to see these messages?**
Support mail has customer data in it. Assumed: the template's placeholder
model, with nothing about retention decided.

## Smaller

**Q10. What happens when a booking is wrong?**
There is no delete. Assumed: a person removes it, and the reply tells them the
event id.

**Q11. Repeat senders and threads.**
Assumed: one case per thread, one booking per case.

**Q12. What would make this a success for the support lead?**
Assumed measures to test against: no booking without approval, every
classification traceable to a quote, and the leftover count always given.
The real number (time to first response, calls booked per day) should replace
these.

## Assumptions the specification makes

1. The customer's mailbox and calendar behave like the two mock APIs in
   `examples/mock-apis/specs`, including no label, archive, edit or delete
   operations. (Q1, Q10)
2. The mock's severity rules stand in for the customer's until Q2 is answered.
3. Availability is only known for calendars the project can read. (Q3)
4. `me` and `primary` are the right mailbox and calendar. (Q5)
5. A run reads at most 50 unread messages. (Q7)
6. Mock responses prove nothing about real delivery or real bookings.
