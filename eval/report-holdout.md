# Eval report: holdout

Test cases and expected answers were written by the author.

**Safety recall: PASS (100%).**

The holdout has two halves: cases written by the AI author (`ai`) and cases whose messages were sourced from a human, with expected answers labeled by a separate AI reviewer, not the prompt author (`human`). Neither was used for prompt tuning.

Run 2026-10-31T15:12:41.807Z · 20 cases · small model `openai/gpt-oss-20b`, big model `openai/gpt-oss-120b` · wall time 244.41 s
Paced for the Groq free tier: ≤25 requests and ≤7000 tokens per minute per model (waited 229.55 s in total; not counted in latency). Each case runs on a freshly reseeded in-memory database.

## AI-written cases

| Metric | Result |
| --- | --- |
| Cases (all fields correct) | 10 (60.0% (6/10)) |
| Trade accuracy | 90.0% (9/10) |
| Asset accuracy | 100.0% (10/10) |
| Urgency accuracy (exact) | 70.0% (7/10) |
| Urgency within one level | 100.0% (10/10) |
| Urgency under-calls (less urgent than labeled) | 0.0% (0/10) |
| Safety recall (must be 100%) | 100.0% (1/1) PASS |
| Safety rule false alarms | 0.0% (0/9) |
| Duplicate detection | precision 100.0% (2/2) · recall 100.0% (2/2) |
| Needs-human flag | precision n/a · recall n/a |
| Escalated to big model | 0.0% (0/10) |
| Latency avg / p95 | 722 ms / 1.24 s |
| Tokens total / avg per case | 16235 / 1624 |
| Pipeline errors | 0 |

| Category | Cases | All fields correct |
| --- | --- | --- |
| easy | 3 | 33.3% (1/3) |
| messy | 2 | 50.0% (1/2) |
| emergency | 1 | 100.0% (1/1) |
| duplicate | 2 | 50.0% (1/2) |
| sensor | 2 | 100.0% (2/2) |

## Human-written cases

| Metric | Result |
| --- | --- |
| Cases (all fields correct) | 10 (70.0% (7/10)) |
| Trade accuracy | 100.0% (10/10) |
| Asset accuracy | 100.0% (10/10) |
| Urgency accuracy (exact) | 80.0% (8/10) |
| Urgency within one level | 100.0% (10/10) |
| Urgency under-calls (less urgent than labeled) | 0.0% (0/10) |
| Safety recall (must be 100%) | 100.0% (2/2) PASS |
| Safety rule false alarms | 0.0% (0/8) |
| Duplicate detection | precision 100.0% (1/1) · recall 100.0% (1/1) |
| Needs-human flag | precision n/a · recall 0.0% (0/1) |
| Escalated to big model | 0.0% (0/10) |
| Latency avg / p95 | 677 ms / 929 ms |
| Tokens total / avg per case | 15763 / 1576 |
| Pipeline errors | 0 |

| Category | Cases | All fields correct |
| --- | --- | --- |
| easy | 2 | 50.0% (1/2) |
| messy | 3 | 66.7% (2/3) |
| emergency | 2 | 100.0% (2/2) |
| duplicate | 1 | 100.0% (1/1) |
| needs_human | 1 | 0.0% (0/1) |
| spanish | 1 | 100.0% (1/1) |

## Combined

| Metric | Result |
| --- | --- |
| Cases (all fields correct) | 20 (65.0% (13/20)) |
| Trade accuracy | 95.0% (19/20) |
| Asset accuracy | 100.0% (20/20) |
| Urgency accuracy (exact) | 75.0% (15/20) |
| Urgency within one level | 100.0% (20/20) |
| Urgency under-calls (less urgent than labeled) | 0.0% (0/20) |
| Safety recall (must be 100%) | 100.0% (3/3) PASS |
| Safety rule false alarms | 0.0% (0/17) |
| Duplicate detection | precision 100.0% (3/3) · recall 100.0% (3/3) |
| Needs-human flag | precision n/a · recall 0.0% (0/1) |
| Escalated to big model | 0.0% (0/20) |
| Latency avg / p95 | 699 ms / 1.02 s |
| Tokens total / avg per case | 31998 / 1600 |
| Pipeline errors | 0 |

| Category | Cases | All fields correct |
| --- | --- | --- |
| easy | 5 | 40.0% (2/5) |
| messy | 5 | 60.0% (3/5) |
| emergency | 3 | 100.0% (3/3) |
| duplicate | 3 | 66.7% (2/3) |
| sensor | 2 | 100.0% (2/2) |
| needs_human | 1 | 0.0% (0/1) |
| spanish | 1 | 100.0% (1/1) |

## Tokens and cost

| Model | Calls | Prompt tokens | Completion tokens | Price | Cost |
| --- | --- | --- | --- | --- | --- |
| openai/gpt-oss-20b | 23 | 27755 | 4243 | $0.075 in / $0.3 out per 1M | $0.00335 |
| **Total** | | | | | **$0.00335** ($0.00017 per case) |

Prices: console.groq.com/docs/model pages, retrieved 2026-10-30. Cached-input discounts are ignored, so this is an upper bound.

## Failed cases

| Case | Source | Category | Input | Wrong fields (expected → got) |
| --- | --- | --- | --- | --- |
| holdout-ai-01 | ai | easy | Toilet in the upstairs women's restroom is clogged | urgency: routine → urgent |
| holdout-ai-03 | ai | easy | Fryer thermostat seems off, the oil runs about 25 degrees hotter than the setting | urgency: routine → urgent |
| holdout-ai-05 | ai | messy | womens bathroom sink wont stop dripping and the toilet seat is cracked | urgency: low → routine |
| holdout-ai-08 | ai | duplicate | seal on the walk-in cooler door is ripped | trade: refrigeration → handyman |
| holdout-human-02 | human | easy | The sink in the men's restroom is not draining properly. | urgency: routine → urgent |
| holdout-human-04 | human | messy | wash basin in ladies room leakin water from the bottom n the tap barely gives any water | urgency: routine → urgent |
| holdout-human-09 | human | needs_human | the AC vent up on the ceiling is loose n shaking, its near the wall | needsHuman: true → false |

## How to read this

- A case passes only if trade, asset, urgency, duplicate, needs-human and safety all match the label.
- Safety recall counts labeled safety emergencies where a code safety rule fired and the result was Emergency.
- Duplicate precision/recall treat "merge into work order X" as the positive; merging into the wrong order is a miss.
- Latency is end-to-end pipeline time per case (all model calls and database work), excluding time spent waiting for the rate-limit window.
