# ShopSim — Predictive A/B Testing for Shopify, powered by MiroFish

ShopSim runs **predictive A/B tests** for any Shopify store. It ingests the
**whole store decomposed into components** (products, collections, navigation,
pages, policies, brand, homepage sections) and uses
**[MiroFish](https://github.com/amadad/mirofish-cli)** — a multi-agent
simulation engine that spins up a swarm of synthetic shopper personas — to
predict which variant of a component wins, with a confidence score. Winning
variants can be written back to the store in one click.

## Project layout

```
shopify_tester/
├─ shopy-tester/      FRONTEND: the Shopify app (React Router 7 + Polaris web
│                     components + App Bridge + Prisma). Handles OAuth, Admin
│                     GraphQL ingestion, the UI, and write-back. Deploy as a
│                     normal embedded app.
├─ mirofish_worker/   BACKEND: FastAPI service (Dockerized) that runs MiroFish
│                     simulations + AI variant generation. Deploy to Railway.
└─ web/               Earlier Remix prototype of the same app — SUPERSEDED by
                      shopy-tester. Kept for reference; not used.
```

The two services talk over HTTP. The frontend never installs MiroFish; it only
calls the backend via `BACKEND_URL`:

```
Merchant admin (browser)
      │ embedded
      ▼
 shopy-tester  ──HTTP──▶  mirofish_worker  (MiroFish + claude-cli + /suggest)
 (Shopify app)  ◀─poll──   on Railway
```

## How it works

1. **Ingest** — the store is pulled via Admin GraphQL into a component snapshot
   and serialized into a shared `shop_context.md`.
2. **Pick a component** and define **Variant A** (current) vs **Variant B**
   (AI-suggested by the backend `/suggest`, editable).
3. **Simulate** — the backend runs MiroFish **twice** (context + Variant A, then
   context + Variant B) so each variant is judged by the same synthetic-shopper
   swarm, parses each `verdict.json`, scores purchase intent, and picks the
   winner + confidence.
4. **Apply** — the frontend writes the winning variant back via Admin GraphQL.

---

## Run it all locally with one command (Windows)

After the one-time setup below (npm install, prisma migrate, worker venv), start
**both** the backend worker and the Shopify app together:

```powershell
.\dev.ps1          # backend in mock mode (no MiroFish needed)
.\dev.ps1 -Real    # backend runs the real mirofish CLI
```

`dev.ps1` launches the worker in its own window and runs `shopify app dev` in the
current one. The worker reads `mirofish_worker/.env` for its config. Press
`Ctrl+C` to stop the app; close the worker window when done. If PowerShell blocks
the script: `powershell -ExecutionPolicy Bypass -File .\dev.ps1`.

---

## Frontend: shopy-tester (the Shopify app)

Built from Shopify's React Router 7 template. UI is Polaris **web components**
(`<s-page>`, `<s-section>`, …) via App Bridge.

**Local dev**

```bash
cd shopy-tester
npm install
npx prisma migrate dev            # SQLite dev database
cp .env.example .env              # set BACKEND_URL (defaults to localhost:8800)
shopify app config link           # bind to your Partner app
shopify app dev                   # tunnel + install on your dev store
```

Scopes (in `shopify.app.toml`):
`read_products, write_products, read_content, write_content, read_themes,
write_themes, read_online_store_pages, read_online_store_navigation`.

**Deploy** (two parts — `shopify app deploy` does NOT host the web server):

1. Host the app's Node server (it's a standard React Router SSR app — a
   `Dockerfile` is included). Railway / Fly / Render all work. Set env:
   `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`,
   `DATABASE` (swap SQLite → Postgres for production), and `BACKEND_URL`
   pointing at the Railway backend.
2. Run `shopify app deploy` to push the app config (scopes, URLs, webhooks) to
   Shopify so merchants can install it.

---

## Backend: mirofish_worker (Railway container)

FastAPI service. Endpoints: `POST /run`, `GET /status/:id`, `GET /result/:id`,
`POST /suggest`, `GET /health`.

**Local dev**

```bash
cd mirofish_worker
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
MIROFISH_MOCK=1 .venv/bin/python app.py                   # mock mode, no MiroFish needed
```

**Deploy to Railway**

A `Dockerfile` is included. Point Railway at `mirofish_worker/` and set env vars
(see `.env.example`). It boots in **mock mode** by default so you can wire the
whole app end-to-end immediately. For real simulations:

- Set `ANTHROPIC_API_KEY` (used by `/suggest`).
- Install MiroFish into the image and authenticate `claude-cli` (see below),
  then set `MIROFISH_MOCK=0` and `MIROFISH_BIN`.

### Installing MiroFish (only for real runs)

MiroFish is **not on PyPI** — clone and build it:

```bash
pip install uv
git clone https://github.com/amadad/mirofish-cli.git
cd mirofish-cli && cp .env.example .env && uv sync   # uv fetches Python 3.12
```

`mirofish` then lives in that repo's venv (not on PATH). Point the worker at it:

```env
MIROFISH_BIN=/path/to/mirofish-cli/.venv/bin/mirofish
# or:  MIROFISH_BIN=uv --directory /path/to/mirofish-cli run mirofish
```

**`claude-cli` = Claude Code** is MiroFish's LLM backend (`LLM_PROVIDER=claude-cli`),
so MiroFish drives simulations using a Claude Code subscription. Real runs make
many `claude` calls and count against usage — keep `MIROFISH_MAX_ROUNDS` low and
prefer mock mode while building. A personal subscription is fine for a pilot; for
a multi-tenant product, move the simulation LLM to the Claude API.

---

## Using it

1. App in your dev store → **Store snapshot** → **Ingest store**.
2. **New A/B test** → choose a component → **Suggest Variant B with AI** (or
   write it) → **Run simulation**.
3. The experiment page auto-refreshes. When complete, review winner, confidence,
   per-variant purchase intent, report, and visuals.
4. For products / collections / pages, click **Apply Variant … to store**.

## Configuration reference

| Where | Key | Purpose |
|-------|-----|---------|
| `shopy-tester/.env` | `BACKEND_URL` | Backend base URL (Railway) |
| `shopy-tester/.env` | `SCOPES` | OAuth scopes (kept in sync with toml) |
| `mirofish_worker/.env` | `ANTHROPIC_API_KEY` | Variant generation (`/suggest`) |
| `mirofish_worker/.env` | `VARIANT_MODEL` | Default `claude-sonnet-4-6` |
| `mirofish_worker/.env` | `MIROFISH_MOCK` | `1` = fixture verdict, `0` = real CLI |
| `mirofish_worker/.env` | `MIROFISH_MAX_ROUNDS` | Simulation rounds (default 6) |
| `mirofish_worker/.env` | `MIROFISH_BIN` | Path/command to the mirofish CLI |
| `mirofish_worker/.env` | `LLM_PROVIDER` | `claude-cli` or `codex-cli` |

## Notes & limitations

- **Predictive only** — no live traffic; MiroFish simulates synthetic shoppers.
- **Per-component** tests hold the rest of the store constant for clean attribution.
- Homepage/theme ingestion is best-effort (theme JSON shapes vary) and degrades
  gracefully; failures surface as warnings.
- The `verdict.json` schema isn't formally documented, so the backend parses it
  defensively (any score-like numeric field is normalized to 0–1).
- For production: swap SQLite → Postgres, add a job queue + scaled workers, add
  Shopify Billing, and move the simulation LLM from `claude-cli` to the Claude API.
