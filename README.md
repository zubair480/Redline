# Redline — Backend & Orchestration Spine

Security scanner for AI agents. Finds prompt-injection paths from a **source**
(ingests untrusted data) to a privileged **sink** (takes action) that pass
through no **guard**. Modeled as a graph; we enumerate the unguarded paths.

Owner: Butterbase backend + orchestration (where Person A / Neo4j and Person B /
RocketRide meet). Everything below is **live now** with mocked A/B calls, so
Person D (frontend) is unblocked immediately.

## App

- **app_id:** `app_wiexpf4uwdww`
- **API base:** `https://api.butterbase.ai/v1/app_wiexpf4uwdww`
- **Auth base:** `https://api.butterbase.ai/auth/app_wiexpf4uwdww`
- **Dev login:** `dev@redline.test` / `RedlineDev1!` (each new signup is its own
  free-tier user — sign up a fresh user to re-demo the paywall)

## Auth (dev logs in)

```
POST /auth/app_wiexpf4uwdww/login   { "email", "password" }  -> { access_token, ... }
POST /auth/app_wiexpf4uwdww/signup  { "email", "password", "display_name" }
```

Send `Authorization: Bearer <access_token>` on every function call below. RLS
scopes every user to their own scans and entitlements.

## Endpoints (Butterbase functions)

All are `POST .../fn/<name>`, JSON in/out, CORS-open, and log every stage
(see `manage_function get_logs` / dashboard).

### 1. `POST /fn/scan` — run a scan (paywalled)

Body = the **frozen Config**:
```json
{ "agent": "customer-support-agent",
  "tools": [ { "name": "read_email", "description": "Read incoming customer emails" }, ... ],
  "guards": [] }
```
Returns the **frozen Results** shape (+ `scanId`):
```json
{ "scanId": "uuid",
  "summary": { "sources": 2, "sinks": 2, "guards": 0, "vulnerablePaths": 4 },
  "vulnerablePaths": [ { "id": "p1", "path": ["read_email","context","issue_refund"], "severity": "critical", "explanation": "..." } ],
  "recommendedFix": { "guard": "human_approval", "placement": "issue_refund", "pathsEliminated": 2, "pathsTotal": 4, "rationale": "..." } }
```
Pipeline: validate -> paywall -> **classify** (RocketRide) -> **scan(graph)**
(Person A) -> **explain** per path (RocketRide) -> store -> return.
Errors: `401` no auth, `400` bad config, `402` paywall, `500` with `{stage,message}`.

### 2. `POST /fn/apply-fix` — red goes green (not paywalled)

Body: `{ config | scanId, recommendedFix | guard }`. Adds the guard, reruns,
returns before/after:
```json
{ "guardAdded": {...}, "before": { "vulnerablePaths": 4 }, "after": { ...Results }, "pathsEliminated": 2, "config": {…withGuard} }
```

### 3. `POST /fn/billing` — paywall unlock

- `{ "action": "status" }`  -> `{ plan, active, used, freeLimit, unlimited, paymentMode }`
- `{ "action": "checkout" }` -> `{ url, ... }` (Stripe test-mode Checkout URL, or mock URL)
- `{ "action": "confirm", "sessionId"? }` -> grants Pro (unlimited) after payment

**Free = 1 scan, Paid = unlimited.** Enforced in `scan`. Proven loop:
scan (200) -> scan (402) -> billing checkout -> billing confirm -> scan (200, unlimited).

### Scan history

Auto-exposed data API (RLS-scoped), no extra code:
```
GET /v1/app_wiexpf4uwdww/scans?order=created_at.desc   (Authorization: Bearer <token>)
```

## Swapping mocks for real services (one env var each, then redeploy)

The three A/B calls are mocked locally until these env vars are set on the
`scan` function (`deploy_function` with `envVars`):

| Env var | Owner | Effect |
| --- | --- | --- |
| `ROCKETRIDE_CLASSIFY_URL` | Person B | real Config -> Graph |
| `SCAN_URL`                | Person A | real Graph -> Results (Neo4j scan) |
| `ROCKETRIDE_EXPLAIN_URL`  | Person B | real per-path explanation + fix text |
| `ROCKETRIDE_API_KEY`      | Person B | bearer for the two RocketRide calls |
| `STRIPE_SECRET_KEY`       | —        | `sk_test_...` turns billing into real Stripe test charges |

Contracts the mocks satisfy (so real services must match):
- classify: `POST <config>` -> `{ nodes, edges, guards }` (bare Graph; `{graph:{…}}` also accepted)
- scan (Person A): `POST { graph }` -> `{ summary, vulnerablePaths, recommendedFix }`
  **Body is the WRAPPED form `{ graph }`** — the agreed Person A + Person C contract
  (Person A's /scan also accepts a bare Graph, but wrapped is documented). Response
  is bare Results; `{results:{…}}` is also tolerated defensively.
- explain (Person B): `POST { path, severity, graph }` -> `{ explanation }`.
  A second, optional call `POST { recommendedFix, graph }` -> `{ rationale }` enriches
  the fix text; it is wrapped in try/catch, so if Person B ignores it the templated
  rationale simply stands (non-fatal).

`apply-fix` uses the identical env-aware pipeline, so it also swaps to the real
services when the env vars are set. When called with a `scanId`, its "before"
count is read from the stored scan result (what the user actually saw), so
before/after can never diverge from the original scan.

### Coordination notes

- **Person D (frontend):** the 402 paywall response exposes `upgradeRequired`,
  `used`, `freeLimit`, `plan` **both** at top level and nested under `error`.
  Read either. Every response (success and error) carries a `runId`.
- **Free-scan count is per-user** (`count(*) ... WHERE kind='scan' AND user_id=$1`).
  A fresh signup always gets its 1 free scan.

## Source

`functions/scan.ts`, `functions/apply-fix.ts`, `functions/billing.ts` — the
deployed JS is inlined at deploy time; these files are the source of truth.
