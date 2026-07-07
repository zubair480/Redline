# Spec 08: Orchestration and Data (Person C, Butterbase)

## Purpose

Define the Butterbase backend and the orchestration spine: auth, the scan-history
and entitlements data model, the three serverless functions (`scan`,
`apply-fix`, `billing`), the active paywall, and the mock-to-real swap. This is
the spine where Person A (Neo4j) and Person B (RocketRide) meet, and it is live
now with both mocked so Person D is never blocked.

## Owns / Does Not Own

Owns: Butterbase app, auth, DB schema and RLS, all three functions, the
orchestration sequencing, the paywall, the apply-fix loop, and stage logging.

Does not own: classification/explanation logic (Person B spec, mocked here until
live), the graph queries (Person A, specs 02 to 04, mocked here until `SCAN_URL`
is set), the frozen shapes (spec 01), or the UI (Person D spec).

## Interface

App: `app_id = app_wiexpf4uwdww`.
API base `https://api.butterbase.ai/v1/app_wiexpf4uwdww`,
auth base `https://api.butterbase.ai/auth/app_wiexpf4uwdww`.

Auth (dev logs in). Send `Authorization: Bearer <access_token>` on every
function call; RLS scopes each user to their own rows.

```
POST /auth/app_wiexpf4uwdww/signup  { email, password, display_name } -> { access_token }
POST /auth/app_wiexpf4uwdww/login   { email, password }               -> { access_token }
```

Functions (all `POST .../fn/<name>`, JSON in/out, CORS-open, stage-logged):

```
POST /fn/scan       body: Config                              -> { scanId, ...Results }   (paywalled)
POST /fn/apply-fix  body: { config | scanId, guard | recommendedFix } -> { guardAdded, before, after, pathsEliminated, config }
POST /fn/billing    body: { action: "status" | "checkout" | "confirm", ... } -> entitlement state / checkout url
```

Scan history is the auto-exposed, RLS-scoped data API, no extra code:
`GET /v1/app_wiexpf4uwdww/scans?order=created_at.desc`.

## Data model

Two tables, both RLS-scoped to `user_id = auth.uid()`.

### `scans`

| column | type | note |
| --- | --- | --- |
| `id` | uuid pk | |
| `user_id` | uuid | owner, RLS key |
| `agent_name` | text | from `config.agent` |
| `config` | jsonb | the pasted Config |
| `graph` | jsonb | the classified Graph |
| `results` | jsonb | the Results shape |
| `kind` | text | `'scan'` or `'applyfix'` |
| `parent_scan_id` | uuid null | set on apply-fix reruns, points at the original scan |
| `created_at` | timestamptz | default `now()` |

`kind` matters for the paywall: only `kind = 'scan'` rows count against the free
limit, so apply-fix reruns ("red goes green") never burn the free scan.

### `entitlements`

| column | type | note |
| --- | --- | --- |
| `user_id` | uuid | one row per user (upserted without a PK; see the grant note in `billing.ts`) |
| `plan` | text | `'free'` or `'pro'` |
| `active` | boolean | `true` unlocks unlimited scans |
| `source` | text | `'mock'` or `'stripe-test'` |
| `updated_at` | timestamptz | |

## Behavior

### `scan` (the orchestration spine)

1. Require an authenticated user (`401` if none).
2. Parse and validate the Config: non-empty `tools` array (`400` otherwise);
   default `guards` to `[]`.
3. **Paywall check.** Count this user's `kind='scan'` rows. Allow if the user is
   entitled (`entitlements.active`) or `used < FREE_SCAN_LIMIT` (1). Otherwise
   `402` with `{ used, freeLimit, plan, upgradeRequired: true }`.
4. **Stage 1, classify.** Call RocketRide `/classify` if `ROCKETRIDE_CLASSIFY_URL`
   is set; else run the in-process mock. Output: Graph.
5. **Stage 2, scan.** Call Person A's `POST /scan` if `SCAN_URL` is set (body
   `{ graph }`, expects a bare Results back); else run the in-process mock.
   Output: Results.
6. **Stage 3, explain.** For each vulnerable path (and the recommended fix), call
   RocketRide `/explain` if `ROCKETRIDE_EXPLAIN_URL` is set to fill
   `explanation` and `rationale`; else fill them from templates.
7. Store one `kind='scan'` row and return `{ scanId, ...Results }`.
8. Every stage logs a single JSON line with a per-request `runId`; any failure
   returns `{ error: { stage, message }, runId }` with an accurate status and
   the process stays up.

### `apply-fix` (red goes green, not paywalled)

Takes a `config` (inline or loaded from `scanId`) and a guard to add (`guard`,
`recommendedFix`, or `fix`; falls back to the config's own recommended fix).
Runs the pipeline once on the original config (`before`) and once with the guard
appended to `config.guards` (`after`), stores a `kind='applyfix'` row with
`parent_scan_id`, and returns before/after plus `pathsEliminated`. Not
paywalled: you can only fix a config you were already allowed to scan.

### `billing` (paywall unlock, payment-mode swappable)

- `status`: returns `{ plan, active, used, freeLimit, unlimited, paymentMode }`.
- `checkout`: if `STRIPE_SECRET_KEY` is set, creates a real Stripe test-mode
  Checkout Session and returns its `url`; else returns a mock URL.
- `confirm`: in Stripe mode, grants Pro only after Stripe reports
  `payment_status = "paid"` and the session's `client_reference_id` matches the
  user; in mock mode, grants immediately so the unlock is provable today.

The full proven loop for the demo: `scan` (200) -> second `scan` (402 paywall)
-> `billing checkout` -> `billing confirm` -> `scan` (200, unlimited).

## Mock-to-real swap (one env var each, then redeploy the `scan` function)

| Env var | Owner | Effect when set |
| --- | --- | --- |
| `ROCKETRIDE_CLASSIFY_URL` | B | real Config -> Graph |
| `SCAN_URL` | A | real Graph -> Results (Neo4j scan) |
| `ROCKETRIDE_EXPLAIN_URL` | B | real per-path explanation, fix, remediation |
| `ROCKETRIDE_API_KEY` | B | bearer for the two RocketRide calls |
| `STRIPE_SECRET_KEY` | — | `sk_test_...` turns billing into real Stripe test charges |

The mocks satisfy exactly these contracts, so the real services must match them
(see the Person B spec for B, spec 05 for A):

- classify: `POST {config}` -> `{ nodes, edges, guards }`
- scan: `POST { graph }` -> `{ summary, vulnerablePaths, recommendedFix }`
- explain: `POST { path, severity, graph }` -> `{ explanation }` (plus `fix`,
  `remediation` when available)

Note the mock-vs-real severity and tie-break divergence documented in the specs
[README](README.md); it does not change the demo outcome.

## Acceptance Criteria

- [ ] A fresh signup can `POST /fn/scan` the frozen Config and get back
      `{ scanId, ...Results }` with the contract summary and 4 vulnerable paths
- [ ] A second `scan` by the same free user returns `402` with `upgradeRequired`
- [ ] `billing checkout` then `billing confirm` flips `entitlements.active` and
      the next `scan` returns `200` (unlimited)
- [ ] `apply-fix` on the frozen Config with the recommended guard returns a lower
      `after.summary.vulnerablePaths` than `before`, and is not paywalled
- [ ] RLS: user X cannot read user Y's `scans` rows via the data API
- [ ] Setting `SCAN_URL` / `ROCKETRIDE_*_URL` swaps a mock for the real service
      with no code change, and the returned Results shape is unchanged
- [ ] Every function logs one JSON line per stage with a shared `runId`, and bad
      input returns `{ error: { stage, message } }` without crashing

## Open Questions

- Should the free-scan count be per-user (`WHERE user_id = auth.uid()`) rather
  than global? The current count is global via RLS; confirm RLS scopes the
  `count(*)` before the demo, or add the explicit `user_id` filter.
