# CLAUDE.md — Redline

## What is this?

Redline is a security scanner for AI agents. It detects prompt-injection vulnerability paths — routes from untrusted data sources (ingests) to privileged sinks (actions) that lack security guards. The agent is modeled as a graph and unguarded paths are enumerated.

## Project structure

```
functions/
  scan.ts        — Main scan orchestration: validate → paywall → classify → scan → explain → store
  apply-fix.ts   — Guard application with before/after comparison
  billing.ts     — Stripe integration with mock fallback; free→pro unlocks
```

All code lives in `functions/`. There is no shared module system — each file is a standalone Butterbase serverless function. Helpers are intentionally duplicated across files (Butterbase does not support cross-function imports).

## Tech stack

- **Language:** TypeScript
- **Platform:** Butterbase serverless functions
- **Database:** PostgreSQL via `ctx.db.query()` (RLS enforced)
- **Payments:** Stripe (test mode default, real via `STRIPE_SECRET_KEY`)
- **External services:** RocketRide (classify/explain), Graph scan service — all swappable via env vars with local mock fallback

## Build / deploy / test

There is no local build, test, or lint step. Code is deployed directly to Butterbase:

```
manage_function deploy_function scan
manage_function deploy_function apply-fix
manage_function deploy_function billing
```

No package.json, tsconfig, or eslint config exists — Butterbase handles all of that.

## Key conventions

- **No imports between functions.** Duplicate shared helpers instead.
- **Mock-first:** If an env var (e.g. `ROCKETRIDE_CLASSIFY_URL`) is unset, the function uses a local mock. No code changes needed to swap.
- **Error shape:** All errors return `{ stage, message }` plus a `runId` for tracing.
- **CORS:** Every function handles OPTIONS (204) and sets `Access-Control-Allow-Origin: *`.
- **Classification is keyword-driven** — deterministic, no ML.
- **Guard placement:** Guards can target a specific sink or apply globally (`null`, `"*"`, or `"all"`).
- **Paywall:** Free tier = 1 scan. Checked before classify stage; returns 402 after limit.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ROCKETRIDE_CLASSIFY_URL` | Real classify endpoint (mock if unset) |
| `ROCKETRIDE_EXPLAIN_URL` | Real explain endpoint (mock if unset) |
| `ROCKETRIDE_API_KEY` | Bearer token for RocketRide |
| `SCAN_URL` | Real graph-scan endpoint (mock if unset) |
| `STRIPE_SECRET_KEY` | Real Stripe key (mock checkout if unset) |

## API endpoints

- `POST /fn/scan` — Run vulnerability scan (paywalled)
- `POST /fn/apply-fix` — Add a guard, get before/after diff
- `POST /fn/billing` — Check status, create checkout, confirm payment
- `GET /v1/app_wiexpf4uwdww/scans?order=created_at.desc` — Scan history (auto-exposed, RLS-scoped)

All endpoints require `Authorization: Bearer <token>`.
