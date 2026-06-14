# ShopSim — Predictive A/B Testing for Shopify, powered by MiroFish

ShopSim runs **predictive A/B tests** for any Shopify store. It ingests the
**whole store decomposed into components** (products, collections, navigation,
pages, policies, brand, homepage sections) and uses
**[MiroFish](https://github.com/amadad/mirofish-cli)** — a multi-agent
simulation engine that spins up a swarm of synthetic shopper personas — to
predict which variant of a component wins, with a confidence score. Winning
variants can be written back to the store in one click.

The LLM behind everything is the **Gemini API** (key via env var).

## Project layout

```
shopify_tester/
├─ shopy-tester/      FRONTEND: the Shopify app (React Router 7 + Polaris web
│                     components + App Bridge + Prisma/Postgres). OAuth, Admin
│                     GraphQL ingestion, UI, write-back. Deploy on Railway.
├─ mirofish_worker/   BACKEND: FastAPI service (Dockerized) that runs MiroFish
│                     simulations + Gemini variant generation. Deploy on Railway.
│   └─ mirofish_patches/   Overlay that adds a `gemini-api` provider to MiroFish.
└─ web/               Earlier Remix prototype — SUPERSEDED by shopy-tester.
```

Both services deploy to **Railway**. They talk over HTTP; the frontend reaches
the backend via `BACKEND_URL`:

```
Merchant admin (browser)
      │ embedded
      ▼
 shopy-tester  ──HTTP──▶  mirofish_worker  (MiroFish on Gemini + /suggest)
 (Shopify app)  ◀─poll──   on Railway
   + Postgres
```

## How it works

1. **Ingest** — the store is pulled via Admin GraphQL into a component snapshot
   and serialized into a shared shop-context document.
2. **Pick a component** and define **Variant A** (current) vs **Variant B**
   (Gemini-suggested by the backend `/suggest`, editable).
3. **Simulate** — the backend runs MiroFish **twice** (context + Variant A, then
   context + Variant B) so each variant is judged by the same synthetic-shopper
   swarm, parses each `verdict.json`, scores purchase intent, and picks the
   winner + confidence.
4. **Apply** — the frontend writes the winning variant back via Admin GraphQL.

## The MiroFish Gemini fork

Upstream MiroFish only supports `claude-cli` / `codex-cli` (subprocess CLIs,
unusable in a headless container). `mirofish_worker/mirofish_patches/` adds a
**`gemini-api`** provider (config.py + llm_client.py) that calls the Gemini API
directly via `google-genai`. Because *all* of MiroFish's LLM access — ontology,
report, and the OASIS simulation agents (via `CLIModel`) — funnels through one
`LLMClient`, this single patch routes the whole engine to Gemini. The backend
Dockerfile clones MiroFish at a pinned commit and overlays these files.

---

## Deploy to Railway (two services)

### 1. Backend — `mirofish_worker`

- New Railway service → set **root directory** to `mirofish_worker`. It builds
  from the included `Dockerfile` (installs uv, clones + patches MiroFish, builds
  it with the Gemini provider). First build is several minutes (pulls torch).
- Env vars:
  - `GEMINI_API_KEY` — **required**
  - `GEMINI_MODEL` — optional (default `gemini-2.5-flash`)
  - `MIROFISH_MAX_ROUNDS` — optional (default 4)
  - `MIROFISH_MOCK=1` — optional, to ship in fixture mode first
- Note its public URL (e.g. `https://shopsim-backend.up.railway.app`).

### 2. Postgres

- Add Railway's **Postgres** plugin. It exposes `DATABASE_URL`.

### 3. Frontend — `shopy-tester`

- New Railway service → root directory `shopy-tester`. Builds from its
  `Dockerfile`; `docker-start` runs `prisma db push` (creates tables) then serves.
- Env vars:
  - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
  - `BACKEND_URL` = the backend service URL from step 1
  - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` — from your Partner app
  - `SHOPIFY_APP_URL` = this service's Railway URL
  - `SCOPES` = `read_products,write_products,read_content,write_content,read_themes,write_themes,read_online_store_pages,read_online_store_navigation`
- Set the same URL as `application_url` in `shopy-tester/shopify.app.toml`, then
  run `shopify app deploy` (pushes scopes/URLs/webhooks to Shopify so merchants
  can install).

---

## Local dev

Run the backend (mock) + the Shopify app together:

```powershell
.\dev.ps1          # backend in mock mode (no MiroFish/Gemini needed for the flow)
```

`dev.ps1` starts the worker in its own window and `shopify app dev` in the
current one.

**Backend** (`mirofish_worker`): `python -m venv .venv` then
`.venv/Scripts/python -m pip install -r requirements.txt`, copy `.env.example`
→ `.env`. Local Windows keeps `MIROFISH_MOCK=1` (real MiroFish/OASIS is Linux-
first; it runs in the Railway container). Add `GEMINI_API_KEY` to use `/suggest`
locally.

**Frontend** (`shopy-tester`): `npm install`, set `DATABASE_URL` (point at a
local Postgres or the Railway one), `npx prisma db push`, then `shopify app dev`.
Scopes (`shopify.app.toml`):
`read_products,write_products,read_content,write_content,read_themes,write_themes,read_online_store_pages,read_online_store_navigation`.

---

## Using it

1. App in your dev store → **Store snapshot** → **Ingest store**.
2. **New A/B test** → choose a component → **Suggest Variant B with AI** (Gemini)
   or write it → **Run simulation**.
3. The experiment page auto-refreshes. When complete, review winner, confidence,
   per-variant purchase intent, report, and visuals.
4. For products / collections / pages, click **Apply Variant … to store**.

## Configuration reference

| Where | Key | Purpose |
|-------|-----|---------|
| `shopy-tester` | `DATABASE_URL` | Postgres connection |
| `shopy-tester` | `BACKEND_URL` | Backend base URL (Railway) |
| `shopy-tester` | `SHOPIFY_API_KEY/SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | Shopify app |
| `mirofish_worker` | `GEMINI_API_KEY` | Gemini key (MiroFish + `/suggest`) |
| `mirofish_worker` | `GEMINI_MODEL` | Default `gemini-2.5-flash` |
| `mirofish_worker` | `LLM_PROVIDER` | `gemini-api` (this fork) |
| `mirofish_worker` | `MIROFISH_MOCK` | `1` = fixture verdict, `0` = real run |
| `mirofish_worker` | `MIROFISH_MAX_ROUNDS` | Simulation rounds (default 4) |

## Notes & limitations

- **Predictive only** — no live traffic; MiroFish simulates synthetic shoppers.
- **Per-component** tests hold the rest of the store constant for clean attribution.
- Real MiroFish (camel-ai/OASIS) is **Linux-first** — run it in the Railway
  container; use `MIROFISH_MOCK=1` for local Windows dev.
- Homepage/theme ingestion is best-effort (theme JSON shapes vary) and degrades
  gracefully; failures surface as warnings.
- The `verdict.json` schema isn't formally documented, so the backend parses it
  defensively (any score-like numeric field is normalized to 0–1).
- The backend image is large (MiroFish pulls torch/transformers) and the first
  Railway build takes several minutes.
- For higher scale: add a job queue + scaled workers and Shopify Billing.
