# Design

[Overview](../README.md) · **Design** · [Vendor calls](vendor-calls.md) · [Eval](eval.md) · [Setup](setup.md)

How Intake Agent plugs into Vera, how much it may do on its own, what data it sees, and what it does not do yet.

## How this plugs into Vera

**One way in.** Every input goes to `POST /api/signals`:

```jsonc
{ "type": "request", "siteId": "elmwood", "text": "toilet in the mens room is running again" }
{ "type": "sensor", "assetId": "amherst-walkin-cooler", "metric": "temperature", "value": 41.8, "unit": "F" }
```

Vera's chat, a QR page, a sensor gateway or an email parser would all post here. The response is
`202 { signalId }`, and the result shows up as a proposal.

**Action tools Vera would call.** Each one is an approval-gated endpoint, safe to retry:

| Tool                             | Endpoint                          | What it does                                                                                                        |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Read proposal                    | `GET /api/proposals/:id`          | Draft, reasons, vendors, budget check, checks run                                                                   |
| Edit draft                       | `PATCH /api/proposals/:id`        | Change trade, asset, urgency, NTE, vendor… (logged)                                                                 |
| **Create work order + dispatch** | `POST /api/proposals/:id/approve` | For a `create` proposal: creates the work order, **commits the budget**, drafts the vendor email, sets `dispatched` |
| **Merge**                        | `POST /api/proposals/:id/approve` | For a `merge` proposal: adds the report to the open work order; commits only the extra NTE if urgency went up       |
| Reject                           | `POST /api/proposals/:id/reject`  | Requires a reason                                                                                                   |
| Audit                            | `GET /api/activity?proposalId=…`  | Every step and human action                                                                                         |

Approve is idempotent. Calling it twice, or from two tabs at once, gives one work order and one
budget commit.

**Where the autonomy setting lives.** One server-side setting, `GET/PUT /api/settings/autonomy`
(stored in MongoDB, default from `AUTONOMY_MODE`). The server enforces it. The UI only shows it,
so a client can't bypass it.

## Autonomy dial

| Dial        | Vera phase | Behavior here                                                                                                                                                      |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Advise**  | Phase 1    | The agent still analyzes everything, but proposals are marked advisory and approve returns `409`. Nothing can be dispatched until the dial moves to Propose.       |
| **Propose** | Phase 2    | **This prototype.** The agent drafts each action; a manager approves, edits or rejects every one.                                                                  |
| **Auto**    | Phase 3    | Shown but disabled (`409` from the API). Auto-approval would need a track record from the eval and the Activity Log first, plus limits such as NTE caps per trade. |

## Privacy

- **Runs entirely on your infrastructure, with your database and your API key.** The server only
  talks to its own MongoDB and the configured LLM endpoint. There is no analytics, tracking or
  telemetry of any kind, on the server or in the web app.
- **The model sees as little as possible:** the request text (or the sensor reading in words), the
  site name and that site's asset list (id, name, location). For the duplicate check it sees the
  new report and the open work order's title, description and location, and answers yes or no. Budgets,
  vendor prices, vendor details and repair history never go to the model. On a vendor call it
  sees the original request text, the work order's details, the site, the NTE (quote calls, at
  the budget question only), the vendor's name and the call transcript.
- **Keys come only from env.** `.env` is git-ignored. The Groq key lives on the server only and is
  never sent to the browser.
- **Recommended:** turn on Groq **Zero Data Retention** in the Groq console under Data Controls.
- **Private mode:** gpt-oss is open-weight, so you can run it on your own server behind any
  OpenAI-compatible endpoint (vLLM, Ollama, etc.) and set `LLM_BASE_URL`, `LLM_MODEL_SMALL` and
  `LLM_MODEL_BIG`. Then no request data leaves your network. **Private mode is supported by
  configuration but was not tested in this prototype.**

## Known limits

- **Fake data.** Sites, assets, vendors, budgets, history and sensor readings are generated.
- **Author-written test cases.** The tune set and half the holdout were written by the same author
  who wrote the prompts. The other 10 holdout cases use messages written by a person, with expected
  answers labeled by a separate AI reviewer, not the prompt author.
- **Private mode is untested.** It is supported by configuration only.
- **Dispatch emails are not sent.** They are drafted, stored on the work order and shown as
  "Draft — not sent".
- **Free hosting sleeps.** Render's free tier spins down after 15 minutes idle, so the first
  request can take about a minute. Atlas free clusters pause after long inactivity.
- **Demo data ages.** The seeded open work orders are placed 10–120 hours before the seed time, and
  duplicate detection only looks back 72 hours. On the live demo, press **Reset demo** before
  trying the duplicate examples.
- No auth or roles, a single tenant, no PII scrubbing, and no real IoT integration (out of scope).
  Vendor acceptance comes from the optional dispatch call. Live work orders stop at `accepted`;
  `in_progress` and `completed` appear only in seeded history.
- **Vendor calls are a demo.** They only ring the author's own phone, so a quote "comparison"
  is the author playing both vendors. Quotes are rough phone estimates, not bids. The scheduler
  runs in the API process; on the free tier, retries due while the server sleeps run when it wakes.
