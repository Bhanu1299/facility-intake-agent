# Vendor calls

[Overview](../README.md) · [Design](design.md) · **Vendor calls** · [Eval](eval.md) · [Setup](setup.md)

The optional AI voice agent that phones vendors after a manager approves a work order.

After a manager approves a work order, an AI voice agent can phone vendors: to collect rough
quotes, or to book the job and an arrival time. Drafted emails stay as the fallback and the record.
Starting calls needs the admin key; without it, approval dispatches by email as before.

**Three call modes**

| Mode                             | Default for          | What the agent does                                                                                                                                                                                                  |
| -------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quote**                        | routine, low, urgent | Calls the top 2 vendors, one at a time, for a rough estimate and earliest arrival. Never books. A "Quotes ready" proposal shows them side by side; the manager picks (no auto-pick)                                  |
| **Book**                         | emergency            | Calls vendor #1 to book now. With "auto-call backup vendors" ticked, a miss or decline moves straight to #2, then #3                                                                                                 |
| **Confirm** (booking the winner) | after a Quote pick   | A booking call that reminds the vendor of the quote call and asks if their arrival time still works. On a yes: work order accepted with the ETA and the agreed estimate; the other vendor gets a decline email draft |

The manager picks the mode when approving (defaulted from urgency). Advise mode disables all calls.

**Script style.** Short and plain, like a person on the phone: one question per turn, about 15
words at most, contractions, no lists, no filler ("We'll note that"), and never a work order or
reference number. Vendor names are shortened in speech only ("Queen City Drain & Pipe" → "Queen
City Drain"). The job is one sentence in the requester's own words from the original request,
then the timing ("Not urgent, sometime this week" / "Urgent, today if possible" / "Emergency, as
soon as possible"). If the vendor asks something, the agent answers only from the request, the
work order and the site; otherwise it says "I don't have that detail. Our manager can fill you
in." and repeats its question, and the question is logged as "Vendor asked: …". All fixed lines
are in `server/src/calls/script.ts`, and golden-transcript tests pin them word for word.

A quote call:

> **Agent:** Hi, this is an automated assistant calling for Harbor and Hearth Kitchen. Is this Queen City Drain?
>
> **Vendor:** Yeah.
>
> **Agent:** Great. The mop sink at our Elmwood location is clogged and backing up. Not urgent, sometime this week. Roughly what would that cost?
>
> **Vendor:** Is it just that sink?
>
> **Agent:** I don't have that detail. Our manager can fill you in. Roughly what would that cost?
>
> **Vendor:** About fifty an hour.
>
> **Agent:** Got it. When's the earliest you could get there?
>
> **Vendor:** Tuesday at eleven.
>
> **Agent:** Tuesday the 3rd at 11 AM, got it. Thanks. Our manager will get back to you soon. If you need us, this number calls us back. Have a good one.

The booking call after the manager picks that quote:

> **Agent:** Hi, this is the automated assistant from Harbor and Hearth Kitchen. We called you Saturday about the clogged mop sink at our Elmwood location.
>
> **Vendor:** Oh yeah.
>
> **Agent:** Great news, we'd like to book you. Does Tuesday at 11 AM still work?
>
> **Vendor:** Yep.
>
> **Agent:** Perfect, Tuesday at 11 AM. The address is 812 Elmwood Ave. Thanks!

**Quote calls.** If the vendor hesitates on the price, the agent nudges once ("Ballpark, or your
hourly rate is fine."). It accepts a fixed price, a range, rates, or no estimate. If the estimate
(or the call-out fee plus 2 hours at the hourly rate) is above the NTE, it asks once: "Our budget's
about $N. Could you work with that?" and records yes, no or maybe. It never negotiates further,
never asks again and never mentions other vendors or their prices. Each call produces a
strict-schema result (`quoteType`, amounts, `withinNte`, `earliestArrival`, `notes`,
`confidence`). **Estimates are approximate** and labeled that way everywhere.

**Booking calls.** Booking a quote winner opens with the reminder above and waits for an
acknowledgement; a vendor who doesn't recall hears the job again before the question. The quote
and the NTE are not restated. In Book mode (no quote call first) the agent uses the normal opener,
the one-sentence job, then "Can you take it, and when's the earliest you could get there?"

**Fallbacks**

| Situation                    | Routine / low                                                                                                                        | Urgent                                    | Emergency (Book mode)                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------ |
| Quote call missed            | Request-for-quote email draft, one retry after `DEMO_RETRY_MINUTES`; the next vendor is called meanwhile. Retry missed → next vendor | Next vendor at once                       | n/a                                                                      |
| Booking call missed          | One retry after the delay, then the runner-up as a one-click proposal                                                                | Runner-up as a one-click proposal at once | Auto-backup on: call #2 at once, then #3. Off: propose the next vendor   |
| Vendor declines or says stop | Next vendor (quotes) or runner-up proposal (booking)                                                                                 | Same                                      | Auto-backup on: next vendor at once. Off: the existing reassign proposal |
| Manager rejects all quotes   | Quote call to the next unused vendor                                                                                                 | Same                                      | n/a                                                                      |
| Every vendor tried           | Needs a human: "No vendor reached", red banner at the top of Inbox                                                                   | Same                                      | Same                                                                     |

Every step (call started, outcome, quote captured, retry scheduled, chain advanced, manager pick,
email drafted) is written to the Activity Log.

**Scheduling.** Every call goes to the same demo phone, so calls are strictly sequential: the next
one is scheduled when the previous call reaches a final status, and the scheduler never dials while
a call is on the line. Scheduled calls live in a Mongo collection (`scheduledCalls`), not in-memory
timers, and run from `POST /api/jobs/run-due` (header `X-Jobs-Secret`), on server start and every 2
minutes while the server is awake. Production would hit that route from an external cron. On
Render's free tier a sleeping server runs overdue jobs when it wakes.

**How the loop works.** The server places an outbound call with Twilio Programmable Voice
(`Calls.create`) and runs its own turn loop. Each turn is TwiML `<Say>` followed by
`<Gather input="speech">` (Twilio's phone-call speech model). Twilio posts what the vendor said
(`SpeechResult`) to a webhook, and the server asks the Groq small model for one strict-schema
decision. The big model runs only if the small model's output fails validation. Call turns use their
own client with no retries, a 5 s timeout and a token cap. If the model is slow the agent says
"Sorry, one moment" and tries once more, then ends with "we'll follow up by email". Code, not the
model, handles these parts:

- **Stop phrases.** "Stop", "not interested", "wrong number", "remove me", "don't call" and "no
  thanks" end the call before the model sees the turn.
- **Arrival times.** "Tuesday at 11", "tomorrow at 9", "in two hours", "10 a.m. in 2 days",
  "day after tomorrow", "this/next Tuesday" and "Monday morning" are resolved in the site's time
  zone (America/New_York) from the call's date. A clear day and time gets a short read-back
  ("Tuesday the 3rd at 11 AM, got it."); a relative or vague one is read back with "Is that
  right?" and needs a yes. A confirmed read-back is always saved.
- **The order of questions** on a quote call, and the one-time budget question.
- **Listening.** The agent listens right after each question (`speechTimeout="auto"`); the first
  question gets 8 seconds of silence before it counts as no answer, later ones 6.
- **Limits.** Six vendor turns on a booking call, nine on a quote call. With no speech after a
  question the agent asks again once, then ends. After a statement or closing line it never
  re-asks: the call ends.

**Disclosure.** Every call says up front that it's an automated assistant calling for Harbor and
Hearth Kitchen. The callback line comes at the close ("If you need us, this number calls us
back."). Saying "stop" (or "don't call", "not interested", …) still ends any call at any point.

**Voice.** `CALL_VOICE` picks the Twilio voice (default `Google.en-US-Chirp3-HD-Aoede`, a generative
voice; any Twilio `<Say>` voice name works, e.g. `Google.en-US-Chirp3-HD-Charon` for a male voice).

**Demo safety.** The app only ever dials `DEMO_VENDOR_PHONE`, the author's own number. The seeded
vendor phone numbers are fake and are never dialed; one function picks the number and a test checks
it. Starting calls needs `CALLS_ENABLED=true` on the server _and_ the admin key (entered under
Settings, kept in the browser's local storage until "Forget key"); automated follow-ups in a chain
an admin started don't ask for the key again. Visitors without the key see the most recent stored
call, labeled "Recorded demo call". The server allows at most 6 calls per work order and 12 an hour in total (placements Twilio
refuses don't count). Each call is cut at 180 seconds (Twilio's `timeLimit`, plus a server-side
hangup), and every Twilio webhook must carry a valid `X-Twilio-Signature` (403 otherwise). Only the
agent's own turn-by-turn transcript is stored. Calls are not recorded.

**Twilio account.** Twilio trial accounts can't run a custom script on outbound calls (only
Twilio's sample scripts), so the live demo uses an upgraded account. A newly upgraded account also
needs an approved Primary Customer Profile in Trust Hub before it can place calls.

**Real use** needs vendor consent to automated calls, for example in the vendor contract. The FCC
treats AI-generated voices as "artificial" voices under the TCPA.

**Trade-off.** Turns are taken one at a time, so expect a pause of about 1 to 2 seconds while the
model answers, and the vendor can't interrupt the agent mid-sentence. A streaming voice stack would
fix both but costs more and has more moving parts.
