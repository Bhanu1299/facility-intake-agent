# facility-intake-agent

Prototype: messy maintenance requests and sensor alerts become draft work orders that a manager
approves before anything happens. Product name in the UI: **Intake Agent**.

> Work in progress. The full README (architecture, eval results, privacy, how this plugs into an
> existing assistant) lands in Phase 8.

## Run locally

Requires Node 22 (`nvm use`).

```bash
npm install
cp .env.example .env   # add GROQ_API_KEY; leave MONGODB_URI empty for an in-memory DB
npm run dev            # API on :4000, web on :5173 (proxies /api)
```

## Checks

```bash
npm test          # Jest (shared + server, uses mongodb-memory-server)
npm run typecheck
npm run lint
npm run build
```

## Deploy

- **API:** Render free web service, defined in `render.yaml` (Blueprint).
- **Web:** Vercel, configured by `vercel.json` (set `VITE_API_URL` to the Render URL).
- **DB:** MongoDB Atlas free cluster.

Free hosts sleep when idle; the first request after a while can take about a minute.
