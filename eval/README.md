# Eval set

Test cases and expected answers were written by the author, except the human half of the holdout:
messages sourced from a human; expected answers labeled by a separate AI reviewer, not the prompt
author. The tune set and the AI half of the holdout were written **before any prompt existed**.

| File                       | Cases | Used for                                                                        |
| -------------------------- | ----- | ------------------------------------------------------------------------------- |
| `cases.tune.json`          | 40    | Prompt tuning. Free to read and iterate on.                                     |
| `cases.holdout.ai.json`    | 10    | Final score only. Written by the AI author in Phase 3, then never opened again. |
| `cases.holdout.human.json` | 10    | Final score only. Human-sourced messages, AI-reviewer labels.                   |

The holdout run loads both holdout files and reports AI-written, human-written and combined scores.

## Case format

```jsonc
{
  "id": "tune-01", // unique
  "category": "easy", // easy | messy | emergency | duplicate | sensor | needs_human | spanish
  "input": {
    // exactly the body of POST /api/signals (timestamps optional)
    "type": "request",
    "siteId": "elmwood",
    "text": "The women's restroom sink faucet is dripping",
  },
  "expected": {
    "trade": "plumbing", // plumbing | hvac | refrigeration | electrical | handyman | pest_control | unknown
    "assetId": "elmwood-restroom-womens", // or null when no specific asset is involved / can't be told
    "urgency": "low", // emergency | urgent | routine | low
    "duplicateOf": null, // open work order id (e.g. "wo-seed-001") or null
    "needsHuman": false,
    "safetyEmergency": false, // true if a code safety rule must force emergency
  },
  "note": "why the label is what it is",
}
```

Sensor input: `{ "type": "sensor", "assetId": "...", "metric": "temperature" | "vibration", "value": 42.5, "unit": "F" | "mm/s" }`.

## Reference data (from the seed)

Sites: `elmwood`, `canalside`, `hertel`, `amherst`, `cheektowaga`.

Assets per site (`<site>-<key>`): `walkin-cooler`, `walkin-freezer`, `rtu-1` (roof, serves dining
room), `rtu-2` (roof, serves kitchen), `fryer` (electrical), `dishwasher` (plumbing), `ice-machine`
(refrigeration), `water-heater` (plumbing), `restroom-mens`, `restroom-womens` (plumbing),
`front-door` (handyman). Elmwood's restrooms are on the 2nd floor.

Open work orders (duplicate candidates are same site + same asset, or same area + trade, created
in the last 72 hours):

| id          | site        | asset                   | trade         | problem                   | age                   |
| ----------- | ----------- | ----------------------- | ------------- | ------------------------- | --------------------- |
| wo-seed-001 | elmwood     | restroom-mens           | plumbing      | toilet running constantly | 20h                   |
| wo-seed-002 | canalside   | rtu-1                   | hvac          | loud rattling noise       | 30h                   |
| wo-seed-003 | hertel      | dishwasher              | plumbing      | not draining              | 10h                   |
| wo-seed-004 | amherst     | front-door              | handyman      | door slams, closer broken | 48h                   |
| wo-seed-005 | elmwood     | (none: bar floor drain) | pest_control  | fruit flies               | 40h                   |
| wo-seed-006 | cheektowaga | walkin-cooler           | refrigeration | door gasket torn          | 120h (outside window) |

## Labeling rules

**Urgency (requests):**

- `emergency`: danger to people or property right now: gas, smoke, fire, sparks, flooding, water
  pouring, ceiling leaking, someone hurt, blocked exit, fire/smoke alarm.
- `urgent`: hurts service or food safety today: cooler/freezer not holding temp, no hot water,
  fryer or dishwasher down, AC out in an occupied space, pests seen in food areas.
- `routine`: needs a visit within days, operations continue: running toilet, door closer, slow ice.
- `low`: minor or cosmetic: dripping faucet, flickering light, sticky lock.

**Urgency (sensors)** is computed in code, not by the model. With `margin` = distance from the
alert threshold to the nearest normal bound (cooler 3°F, freezer 5°F, AC vibration 2 mm/s, water
heater 10°F) and `r` = how far past the threshold the reading is, divided by `margin`:

- `r >= 1` → `emergency`; `0 < r < 1` → `urgent`
- not past the threshold: linear trend over recent readings crosses it in ≤ 2 days → `urgent`,
  ≤ 7 days → `routine`, otherwise `low`.
- The trend is a least-squares fit over the last 24h, new reading included. If the new reading
  moved at least one `margin` toward the threshold since the previous one, the reason says
  "jumped from X to Y" instead of a per-day rate.

**needsHuman:** true when a reasonable dispatcher could not tell what is broken or which asset
(e.g. two rooftop units and the message doesn't say which). A request with no equipment involved
(pests, a light fixture, an outlet) is **not** needsHuman: `assetId` is simply `null`.

**Two problems in one message:** label the primary (first or most severe) problem.

## Human-written holdout: what your 10 should cover

So the totals still match the spec (15 easy, 15 messy, 8 emergency, 8 duplicate, 6 sensor,
5 needsHuman, 3 Spanish), the 10 human cases should be:

| Category                                                            | Count |
| ------------------------------------------------------------------- | ----- |
| easy                                                                | 2     |
| messy (typos, slang, two problems in one message)                   | 3     |
| emergency                                                           | 2     |
| duplicate (of one of the open work orders above, created < 72h ago) | 1     |
| needs_human                                                         | 1     |
| spanish                                                             | 1     |

Fill the slots in `cases.holdout.human.json` (each slot already has its category). The
`"example": true` entry is skipped by the runner. Please don't share your cases with the AI
author before the holdout run.
