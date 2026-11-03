# Setup

[Overview](../README.md) · [Design](design.md) · [Vendor calls](vendor-calls.md) · [Eval](eval.md) · **Setup**

Run it locally, seed data, run tests and the eval, configure it, and deploy it.

Requires Node 22 (`nvm use`).

```bash
npm install
cp .env.example .env     # add GROQ_API_KEY; leave MONGODB_URI empty for an in-memory DB
npm run dev              # API on :4000 (auto-seeds), web on :5173 (proxies /api)
```

Open http://localhost:5173. Try `/r/elmwood` (the QR page) and the Sensor simulator.

| Command                                | What it does                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run seed`                         | Wipes and reseeds the database in `MONGODB_URI` (5 sites, 55 assets, 13 vendors, 100 completed + 6 open work orders, 14 days of sensor data) |
| _Reset demo_ button                    | Same reset from the UI (`POST /api/demo/reset`)                                                                                              |
| `npm test`                             | Jest unit and API tests. No LLM calls (the model client is faked); MongoDB runs in memory                                                    |
| `npm run eval -- --set tune`           | Runs the 40 tune cases through the real pipeline on Groq and writes `eval/report-tune.md`                                                    |
| `npm run eval -- --set holdout`        | The 20 holdout cases (10 AI-written, 10 human-written). Reports AI, human and combined scores. Run once                                      |
| `npm run lint` / `typecheck` / `build` | The usual                                                                                                                                    |

The eval always uses its own in-memory database (it ignores `MONGODB_URI`) and reseeds before
every case. It is paced for the Groq free tier (about 7K tokens and 25 requests per minute per
model; override with `EVAL_TPM` / `EVAL_RPM`), and 429s are retried with backoff. It exits non-zero
if safety recall is below 100%.

**Environment variables** (all in `.env.example` except the two eval-only ones):

| Variable                                   | Required / optional                            | Default                          | What it does                                             |
| ------------------------------------------ | ---------------------------------------------- | -------------------------------- | -------------------------------------------------------- |
| `GROQ_API_KEY`                             | **Required**                                   | none                             | LLM key for intake, the eval and call turns. Server only |
| `MONGODB_URI`                              | **Required** in production; optional locally   | in-memory DB                     | MongoDB connection string                                |
| `CORS_ORIGIN`                              | **Required** in production; optional locally   | `http://localhost:5173`          | Allowed web origin(s), comma-separated                   |
| `VITE_API_URL`                             | **Required** for the deployed web app (Vercel) | none (dev proxies `/api`)        | API base URL the web app calls                           |
| `PORT`                                     | Optional                                       | `4000`                           | API port                                                 |
| `NODE_ENV`                                 | Optional                                       | `development`                    | `development`, `test` or `production`                    |
| `LLM_BASE_URL`                             | Optional                                       | `https://api.groq.com/openai/v1` | Any OpenAI-compatible endpoint (private mode)            |
| `LLM_MODEL_SMALL` / `LLM_MODEL_BIG`        | Optional                                       | `openai/gpt-oss-20b` / `-120b`   | Small model first, big model on escalation               |
| `AUTONOMY_MODE`                            | Optional                                       | `propose`                        | Starting autonomy mode: `advise`, `propose` or `auto`    |
| `DEMO_RATE_LIMIT_PER_HOUR`                 | Optional                                       | `20`                             | Signal submissions and resets per IP per hour            |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Optional (required for vendor calls)           | none                             | Twilio credentials                                       |
| `TWILIO_FROM_NUMBER`                       | Optional (required for vendor calls)           | none                             | Caller ID for vendor calls                               |
| `DEMO_VENDOR_PHONE`                        | Optional (required for vendor calls)           | none                             | The only number the app ever dials                       |
| `CALL_ADMIN_KEY`                           | Optional (required for vendor calls)           | none                             | Admin key needed to start calls                          |
| `PUBLIC_API_URL`                           | Optional (required for vendor calls)           | none                             | Public API URL Twilio webhooks are built and signed on   |
| `CALLS_ENABLED`                            | Optional                                       | `false`                          | Master switch for vendor calls                           |
| `DEMO_RETRY_MINUTES`                       | Optional                                       | `90`                             | Wait before retrying a missed routine / low call         |
| `CALL_VOICE`                               | Optional                                       | `Google.en-US-Chirp3-HD-Aoede`   | Twilio `<Say>` voice                                     |
| `JOBS_SECRET`                              | Optional                                       | none (route disabled)            | Secret for `POST /api/jobs/run-due`                      |
| `EVAL_TPM` / `EVAL_RPM`                    | Optional (eval only, not in `.env.example`)    | `7000` / `25`                    | Eval pacing for the Groq free tier                       |

**Deploy (free tiers):** API on Render (`render.yaml`), web on Vercel (`vercel.json`, Root
Directory = repo root, `VITE_API_URL` = the Render URL), MongoDB Atlas free cluster. Pushing to
`main` redeploys both.
