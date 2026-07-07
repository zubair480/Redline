# Redline Specs Index

Redline is a security scanner for AI agents. It finds prompt-injection
vulnerabilities: a path from a **source** (a tool that ingests untrusted data)
to a privileged **sink** (a tool that takes a dangerous action) that passes
through no **guard** (a safety check). Model the agent as a graph, and a
vulnerability is just a source-to-sink path that dodges every guard. Redline
finds those paths, explains how they would be exploited, and points at the one
guard placement that closes the most holes.

This folder is the shared source of truth. Nobody writes real code until the
contract (frozen shapes plus the engine rulings in the
[Person A spec](personA-neo4j-graph-engine.md)) is frozen; after that, all four
roles build in parallel against mocks.

## The one hard dependency

Everything else can slip without stalling the team, because every consumer
mocks its producer until the real thing is live. The one rule that must hold:

- **Person A exposes `scan(graph) -> Results`** (an HTTP `POST /scan`) before
  hour 3.
- **Person B publishes stable `/classify` and `/explain` endpoint shapes**
  before hour 3.

Person C mocks both until then; Person D mocks Person C until then. A slip in
one place does not stall the other three, as long as the interfaces above are
frozen early.

## The four roles and their specs

| Role | Owner | Stack | Specs |
| --- | --- | --- | --- |
| **A. Graph engine** | Neo4j graph, Cypher, `scan(graph)` | Neo4j Aura | [personA](personA-neo4j-graph-engine.md) |
| **B. AI analysis** | `/classify` (roles + flow), `/explain` (narrative + fix + remediation) | RocketRide Cloud | [personB](personB-rocketride-classify-and-explain.md) |
| **C. Backend + spine** | auth, DB, paywall, orchestration, apply-fix | Butterbase | [personC](personC-butterbase-orchestration-and-data.md) |
| **D. Frontend + demo** | paste-config UI, columnar SVG graph, cinematic red trace, pitch | web | [personD](personD-frontend-and-demo.md) |

Each spec stands alone and is owned by that teammate; if you are implementing
one role, the other three are reference context, not your work. All follow the
same template: Purpose, Owns / Does Not Own, Interface, Behavior, Acceptance
Criteria, Open Questions.

## The frozen contract (three shapes)

Full definitions and the engine's normative rulings live in the
[Person A spec](personA-neo4j-graph-engine.md). In one breath:

- **Config** (user pastes): `{ agent, tools: [{name, description}], guards: [] }`
- **Graph** (internal, Person B produces, Person A consumes):
  `{ nodes: [{id, role, privileged, rationale}], edges: [{from, via, to}], guards }`
  where `role` is `source | sink | guard | passthrough`, and every source
  reaches every sink through a shared `context` node (the shared-context
  assumption).
- **Results** (Person A produces, Person D renders):
  `{ summary, vulnerablePaths: [{id, path, severity, explanation}], recommendedFix }`

The pipeline is: Config -> `/classify` -> Graph -> `scan(graph)` -> Results ->
`/explain` fills the prose fields -> store -> render.

## How the tools carry their weight (for judging)

- **Neo4j** is the engine, not decoration. The vulnerability scan is one Cypher
  query finding source-to-privileged-sink paths through no guard; the best-fix
  query counts paths per sink to pick the single chokepoint. "Does a dangerous
  path exist" is exactly the question graphs were built to answer. See the
  [Person A spec](personA-neo4j-graph-engine.md).
- **RocketRide Cloud** runs the AI as two deployed pipeline endpoints: one
  classifies each tool and infers flow, one writes the exploit narrative, fix,
  and auto-remediation snippet. See [the Person B spec](personB-rocketride-classify-and-explain.md).
- **Butterbase** is the backend: auth so developers connect their own agents, a
  scan-history DB, and a real test-mode paywall (free tier gets one scan). See
  [the Person C spec](personC-butterbase-orchestration-and-data.md).

Bonuses, in priority order, only after the MVP is solid: **Cognee** (threat
memory so repeat tools come pre-classified, [Person B spec](personB-rocketride-classify-and-explain.md)),
then **Daytona** (execute the injection in a sandbox to prove a path before
flagging it). Hard rule: if Daytona is not clearly landing by 7:15, cut it.

## Current status

- **Person A**: engine complete and verified. `npm test` passes against Aura
  (all three fixtures plus guard-rewiring cases); `POST /scan` and `GET /health`
  are live locally. Remaining: expose a public URL and set `SCAN_URL` on the
  deployed `scan` function (see the [Person A spec](personA-neo4j-graph-engine.md)).
- **Person C**: `functions/scan.ts`, `functions/apply-fix.ts`,
  `functions/billing.ts` deployed and live with mocked A/B calls. Swapping a
  mock for the real service is one env var each (see the root `README.md`).
- **Person B / D**: specced here; implementation tracked in their own repos or
  directories.

## Mock-vs-real divergence to know about

Until `SCAN_URL` points at Person A's engine, Person C's orchestrator uses an
in-process mock of the scan. The mock and the real engine agree on the vulnerable
paths for all three fixtures, but two fields are computed differently and may
shift slightly when the real engine comes online. This is expected, not a bug:

- **Severity.** The engine derives severity from path length (3-node path is
  `critical`, longer is `high`; Person A spec, ruling 4). The mock derives it
  from sink keywords (`critical | high | medium`). The real engine never emits
  `medium`.
- **`recommendedFix` tie-break.** When two sinks have equal path counts, the
  engine breaks the tie alphabetically by sink id; the mock breaks it by sink
  severity. For the demo fixtures both land on `issue_refund`, so the demo is
  stable either way.

When `SCAN_URL` is set, the real engine's Results win end to end and the mock is
bypassed. Person D should render whatever severity strings arrive and never
hard-code the set.
