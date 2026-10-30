# Eval report: tune

Test cases and expected answers were written by the author.

**Safety recall: PASS (100%).**


Run 2026-10-30T18:27:34.585Z · 40 cases · small model `openai/gpt-oss-20b`, big model `openai/gpt-oss-120b` · wall time 483.58 s
Paced for the Groq free tier: ≤25 requests and ≤7000 tokens per minute per model (waited 445.34 s in total; not counted in latency). Each case runs on a freshly reseeded in-memory database.

## Results

| Metric | Result |
| --- | --- |
| Cases (all fields correct) | 40 (75.0% (30/40)) |
| Trade accuracy | 97.5% (39/40) |
| Asset accuracy | 97.5% (39/40) |
| Urgency accuracy (exact) | 77.5% (31/40) |
| Urgency within one level | 100.0% (40/40) |
| Urgency under-calls (less urgent than labeled) | 2.5% (1/40) |
| Safety recall (must be 100%) | 100.0% (5/5) PASS |
| Safety rule false alarms | 0.0% (0/35) |
| Duplicate detection | precision 100.0% (4/4) · recall 100.0% (4/4) |
| Needs-human flag | precision 100.0% (4/4) · recall 100.0% (4/4) |
| Escalated to big model | 10.0% (4/40) |
| Latency avg / p95 | 868 ms / 1.77 s |
| Tokens total / avg per case | 62772 / 1569 |
| Pipeline errors | 0 |

| Category | Cases | All fields correct |
| --- | --- | --- |
| easy | 10 | 70.0% (7/10) |
| messy | 10 | 100.0% (10/10) |
| emergency | 5 | 80.0% (4/5) |
| duplicate | 5 | 40.0% (2/5) |
| sensor | 4 | 100.0% (4/4) |
| needs_human | 4 | 75.0% (3/4) |
| spanish | 2 | 0.0% (0/2) |

## Tokens and cost

| Model | Calls | Prompt tokens | Completion tokens | Price | Cost |
| --- | --- | --- | --- | --- | --- |
| openai/gpt-oss-20b | 45 | 48933 | 7236 | $0.075 in / $0.3 out per 1M | $0.00584 |
| openai/gpt-oss-120b | 4 | 4926 | 1677 | $0.15 in / $0.6 out per 1M | $0.00175 |
| **Total** | | | | | **$0.00759** ($0.00019 per case) |

Prices: console.groq.com/docs/model pages, retrieved 2026-10-30. Cached-input discounts are ignored, so this is an upper bound.

## Failed cases

| Case | Source | Category | Input | Wrong fields (expected → got) |
| --- | --- | --- | --- | --- |
| tune-01 | tune | easy | The women's restroom sink faucet is dripping | urgency: low → routine |
| tune-05 | tune | easy | Front door lock is sticking, it's hard to lock up at close | urgency: low → routine |
| tune-07 | tune | easy | We saw a mouse in the dry storage room this morning | urgency: urgent → routine |
| tune-22 | tune | emergency | Water is pouring through the ceiling in the dining room | assetId: null → canalside-water-heater |
| tune-26 | tune | duplicate | the toilet in the upstairs mens bathroom is still running nonstop | urgency: routine → urgent |
| tune-29 | tune | duplicate | upstairs men's room toilet that was running is now overflowing, water on the floor | urgency: urgent → emergency |
| tune-30 | tune | duplicate | sink faucet in the 2nd floor men's room won't shut off | urgency: routine → urgent |
| tune-38 | tune | needs_human | can someone look at the cooler or the freezer, not sure which one is leaking water | trade: refrigeration → plumbing; urgency: routine → urgent |
| tune-39 | tune | spanish | El inodoro del baño de mujeres está tapado y no funciona | urgency: routine → urgent |
| tune-40 | tune | spanish | La máquina de hielo no está haciendo hielo otra vez | urgency: routine → urgent |

## How to read this

- A case passes only if trade, asset, urgency, duplicate, needs-human and safety all match the label.
- Safety recall counts labeled safety emergencies where a code safety rule fired and the result was Emergency.
- Duplicate precision/recall treat "merge into work order X" as the positive; merging into the wrong order is a miss.
- Latency is end-to-end pipeline time per case (all model calls and database work), excluding time spent waiting for the rate-limit window.
