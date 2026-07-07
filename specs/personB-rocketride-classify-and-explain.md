# Spec 07: Classify and Explain (Person B, RocketRide Cloud)

## Purpose

Define the two RocketRide Cloud pipeline endpoints that supply Redline's AI
analysis: `/classify` turns a Config into a Graph (tool roles plus inferred
flow), and `/explain` turns a vulnerable path into human-readable prose and an
auto-remediation snippet. Person C's orchestrator (Person C spec) calls both; until
they are live it mocks both against the shapes below, so these request/response
shapes are a contract and must not drift once published.

## Owns / Does Not Own

Owns: both RocketRide pipelines, the LLM prompts inside them, the role/flow
inference, all human-readable prose (`rationale`, `explanation`), and the
auto-remediation snippet. Later owns the Cognee threat-memory extension to
`/classify`.

Does not own: the graph queries or path enumeration (Person A, specs 02 to 04),
orchestration or storage (Person C spec), or the frozen shapes themselves
(spec 01, team-wide).

## Priority order (this is the risk this role carries)

RocketRide is the least familiar tool on the stack, so the first job is proving
the deploy path, not perfecting the logic.

1. **Deploy a stub first.** Build the simplest possible `/classify` pipeline in
   the RocketRide VS Code extension (hardcoded output is fine) and deploy it to
   RocketRide Cloud. Confirm you can hit the live endpoint over HTTP and get
   JSON back. Do this before writing any real logic. A live stub by hour 3 is
   the single most important de-risking move of the day.
2. Real `/classify`.
3. Real `/explain`.
4. Give Person C both live URLs and their exact shapes the moment each is up.
5. Bonus only after the MVP is solid: Cognee memory in `/classify`. Do not start
   before hour 6.

## Interface

Both are `POST`, JSON in and out, hosted on RocketRide Cloud (base
`cloud.rocketride.ai`). Person C sends `Authorization: Bearer <ROCKETRIDE_API_KEY>`.

### `/classify`

Input is the frozen Config shape:

```json
{ "agent": "customer-support-agent",
  "tools": [ { "name": "read_email", "description": "Read incoming customer emails" } ],
  "guards": [] }
```

Output is the frozen Graph shape:

```json
{ "nodes": [ { "id": "read_email", "role": "source", "privileged": false, "rationale": "Ingests untrusted external input from customer emails" } ],
  "edges": [ { "from": "read_email", "via": "context", "to": "issue_refund" } ],
  "guards": [] }
```

### `/explain`

Input is one vulnerable path plus enough context to describe it:

```json
{ "path": ["read_email", "context", "issue_refund"],
  "severity": "critical",
  "graph": { "nodes": [...], "edges": [...], "guards": [] } }
```

Output:

```json
{ "explanation": "A crafted email instructs the agent to issue a refund; the agent reads the email into its context and, with no approval step between reading and paying, calls issue_refund on the attacker's behalf.",
  "fix": "Require human approval before issue_refund.",
  "remediation": "def guard_issue_refund(request):\n    if not request.human_approved:\n        raise PermissionError('issue_refund requires human approval')\n    return request" }
```

For the recommended fix (a second call the orchestrator may make), input is
`{ recommendedFix, graph }` and output is `{ rationale, remediation }`.

## Behavior

### `/classify`

1. For each tool, an LLM node returns `{ role, privileged, rationale }` per the
   frozen roles (`source | sink | guard | passthrough`). A source ingests
   untrusted data; a sink takes a privileged action (`privileged: true`); a
   guard is a safety check; everything else is passthrough. The `rationale` is
   one concrete sentence tied to the tool's description.
2. Infer `CAN_FLOW_INTO` edges. For the demo, generate `source -> sink` through
   `via: "context"` for every source-sink pair (the shared-context assumption).
   If time allows, have the LLM infer specific tool-to-tool flows and guard
   wiring (for example `human_approval -> issue_refund` as a direct edge with no
   `via`, per spec 01 ruling 7).
3. Normalize `config.guards` (strings or `{name, placement}` objects) onto the
   output `guards` array.
4. Redeploy to cloud after each change; keep the response shape stable.

### `/explain`

1. Input is one path (list of tool ids) and the tool descriptions reachable
   through `graph`.
2. Return a 2 to 3 sentence exploit narrative that is concrete about the attack
   ("a crafted email instructs the agent to..."), naming the actual source and
   sink tools.
3. Return a one-line `fix` recommendation and a paste-ready `remediation`
   snippet: a validator function stub or a prompt-constraint the user can drop
   into their agent to gate the sink named in the fix.
4. Prose only. Never emit graph structure, severities, or path ids; those are
   Person A's (spec 01 rulings 4 and 5, the engine returns these fields empty
   for Person B to fill).

## The mock Person C runs until you are live (match it)

Person C's orchestrator already contains a deterministic mock of both endpoints
so Person D is unblocked. Your real endpoints must satisfy the same shapes so
the swap is a one-line env-var change (`ROCKETRIDE_CLASSIFY_URL`,
`ROCKETRIDE_EXPLAIN_URL`). The mock:

- classifies by keyword (guard, then sink, then source, else passthrough), marks
  every sink `privileged: true`, and wires every source to every sink via
  context;
- writes template explanations of the form "Untrusted data from X flows through
  the shared context into Y with no guard in between."

Your `/classify` output must be a strict superset in quality, never a different
shape. If you add fields, add them; do not rename or drop `id`, `role`,
`privileged`, `rationale`, `from`, `via`, `to`.

## Cognee bonus (do not start before hour 6)

Extend `/classify` to consult a Cognee memory bank before the LLM runs. On each
tool, look up prior classifications and known exploit patterns for
similar-named/similar-described tools (for example any `issue_refund`-like
financial sink). Pre-tag matches so repeat tools come back classified from
memory and known exploit patterns surface in the rationale. Write each new
classification back to memory. This must be additive: if Cognee is unreachable,
`/classify` falls back to the LLM path and still returns a valid Graph.

## Acceptance Criteria

- [ ] A stub `/classify` is deployed to RocketRide Cloud and returns JSON over
      HTTP before hour 3
- [ ] Real `/classify` on the frozen Config returns a Graph with `read_email`
      and `fetch_url` as sources, `issue_refund` and `send_email` as
      `sink`/`privileged:true`, `search_orders` as passthrough, and 4
      source-to-sink edges via context
- [ ] `/explain` on `["read_email","context","issue_refund"]` returns a concrete
      2 to 3 sentence narrative naming both tools, plus a `fix` line and a
      paste-ready `remediation` snippet
- [ ] Both response shapes match the mock in the Person C spec field-for-field (swap is one
      env var, no orchestrator code change)
- [ ] Person C has the two live URLs and their exact request/response shapes
- [ ] (Bonus) Cognee lookup pre-tags a repeat tool, and `/classify` still returns
      a valid Graph when Cognee is unreachable

## Open Questions

- Does `/explain` return `remediation` on both the per-path and the
  recommended-fix call, or only the recommended-fix call? Default: both, so the
  UI can show a snippet next to each path and next to the headline fix.
