# Eval

[Overview](../README.md) · [Design](design.md) · [Vendor calls](vendor-calls.md) · **Eval** · [Setup](setup.md)

How well the intake step classifies real-world reports, measured on 60 labeled cases.

There are 60 labeled cases: 40 for tuning, and a 20-case holdout that was never used for tuning.
The tune set and the AI half of the holdout were written by the author before any prompt existed.
The human half of the holdout uses messages written by a person, with expected answers labeled by a
separate AI reviewer, not the prompt author.

**Holdout** (`eval/report-holdout.md`, run once, no prompt changes after):

| Metric                           | AI (10)           | Human (10)        | Combined (20)                  |
| -------------------------------- | ----------------- | ----------------- | ------------------------------ |
| All fields correct               | 60% (6/10)        | 70% (7/10)        | **65% (13/20)**                |
| Safety recall (must be 100%)     | **100% (1/1)**    | **100% (2/2)**    | **100% (3/3)**, 0 false alarms |
| Trade                            | 90% (9/10)        | 100% (10/10)      | 95% (19/20)                    |
| Asset                            | 100% (10/10)      | 100% (10/10)      | 100% (20/20)                   |
| Urgency exact / within one level | 70% / 100%        | 80% / 100%        | 75% / 100%                     |
| Urgency under-calls              | 0% (0/10)         | 0% (0/10)         | 0% (0/20)                      |
| Duplicates (precision / recall)  | 100% / 100% (2/2) | 100% / 100% (1/1) | 100% / 100% (3/3)              |
| Needs-human recall               | n/a               | 0% (0/1)          | 0% (0/1)                       |

Of the 7 misses, 5 are urgency over-calls (rated one level more urgent than labeled), 1 is a trade
miss (torn walk-in cooler door seal sent to handyman, not refrigeration) and 1 is a missed
needs-human flag (a loose, shaking ceiling AC vent).

Known weakness: on an ambiguous HVAC report (two rooftop units, no room named) it left the unit
blank but didn't flag the case for a human to ask. Over-calls lean toward caution; no under-calls.

**Tune set** (`eval/report-tune.md`, the prompt as committed):

| Metric                           | Result                         |
| -------------------------------- | ------------------------------ |
| Safety recall (must be 100%)     | **100% (5/5)**, 0 false alarms |
| Trade                            | 100% (40/40)                   |
| Asset                            | 95% (38/40)                    |
| Urgency exact / within one level | 87.5% / 100%                   |
| Urgency under-calls              | 0% (0/40)                      |
| Duplicates (precision / recall)  | 100% / 100% (4/4)              |
| Needs-human (precision / recall) | 100% / 100% (4/4)              |
| Escalated to the big model       | 10%                            |
| Latency avg / p95                | 0.81 s / 1.9 s                 |
| Tokens / cost per request        | ~1,735 tokens / ~$0.0002       |

What tuning showed (four full runs, tune set only):

- Safety, trade, duplicates and needs-human were right in every run. The misses are almost all
  urgency borderlines, such as whether a slow ice machine is routine or urgent.
- Results move by about ±2 cases between identical runs even at temperature 0, so small prompt
  changes can't be told apart from noise with 40 cases.
- Run 1 (base prompt): 30/40 with 2 under-calls. Run 2 (added "start from routine" rules): 30/40
  with 1 under-call. Run 3 (rules as an ordered checklist): 29/40 with **6 under-calls**. The
  committed prompt after run 3 was run 2's, because under-calling an urgent problem costs more than
  over-calling it.
- Run 4 (after QA): added rules for active leaks the reporter stresses (urgent), fixtures that run
  nonstop but drain (routine), and any rodent or roach in a food area incl. dry storage (urgent).
  **33/40 with 0 under-calls**; this is the committed prompt. Remaining misses are over-calls by one
  level and two asset picks.
