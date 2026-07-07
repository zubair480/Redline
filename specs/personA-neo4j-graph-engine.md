# Spec: Neo4j Graph Engine (Person A)

Consolidates the former numbered specs 00 through 06 into one document. Status:
fully implemented and verified; `npm test` is the definition of done and passes.

## Purpose

The graph engine: classified Graph shape in, ranked vulnerable paths plus a
best-fix chokepoint out. Nobody else touches Cypher, and this engine never sees
the raw Config shape.

```
Config -> /classify (Person B) -> Graph -> THIS ENGINE -> Results -> /explain -> UI
```

## Owns / Does Not Own

Owns: everything Neo4j (connection, ingestion, Cypher, cleanup), the
`scan(graph) -> Results` function, the `POST /scan` HTTP endpoint, the
engine-side contract rulings below, fixtures and the engine test harness.

Does not own: Config -> Graph classification (Person B), all human-readable
prose (`explanation` / `rationale` are returned as empty strings), UI, auth,
paywall, orchestration (Person C), Cognee / Daytona.

## File layout

```
src/engine/
  db.js         driver singleton (getDriver/close), env: NEO4J_URI/USER/PASSWORD
  ingest.js     ingestGraph(graph, scanId), expandEdges, deleteScan
  guards.js     normalizeGuards, rewireGuards (guard-as-data policies)
  queries.js    findVulnerablePaths, findBestFix
  scan.js       scan(graph) -> Results, ValidationError
  server.js     Express: POST /scan, GET /health, CORS
fixtures/       support-agent.json, guarded-agent.json, clean-agent.json
scripts/        check-connection.js, verify-ingest.js, verify-queries.js
test/           run-samples.js (npm test)
```

## Interface

```js
import { scan } from './src/engine/scan.js'
const results = await scan(graph)   // Graph shape in, Results shape out
```

HTTP (`npm start`, port from `.env`, default 3000):
- `POST /scan` accepts the bare Graph shape OR `{ graph: <Graph> }` (the
  Butterbase orchestrator sends the wrapped form to `SCAN_URL` and expects bare
  Results back). 400 `{ error }` on invalid input, 500 `{ error }` otherwise;
  the process never crashes on a bad request.
- `GET /health` runs `driver.getServerInfo()` (neo4j-driver v6: use this, not
  `verifyConnectivity()`, which no longer returns the address).
- CORS is wide open (static UIs and the orchestrator live on other origins).

## Contract rulings (normative, aligned with Person C's deployed code)

The frozen shapes live in the root README and Person C spec. The engine's
rulings on what the contract leaves open:

1. **summary counts** come from the INPUT graph: `sources` = source-role nodes;
   `sinks` = sink-role nodes with `privileged: true` (matches Person C's mock);
   `guards` = unique names in the union of guard-role node ids and the
   top-level `graph.guards` list; `vulnerablePaths` = array length.
2. **Zero vulnerable paths: `recommendedFix` is `null`** (Person C's mock and
   apply-fix both branch on null). The UI renders null as "no fix needed".
3. **Path ids are deterministic**: rows sorted by sink id then path array,
   numbered `p1..pN`. Same graph in, same ids out.
4. **Severity is a deterministic rule**: 3-node path (source, context,
   privileged sink) is `critical`, longer is `high`. Never `medium`, no LLM.
5. **`explanation` / `rationale` are always `""`** in engine output.
6. **`recommendedFix.guard` is always `"human_approval"`.**
7. **Edge `via` semantics**: `via: "context"` routes through the shared context
   node; any other or missing `via` is a direct edge (guard-in-the-middle
   wiring).
8. **Unknown node roles are rejected** (400), not coerced. Valid: source, sink,
   guard, passthrough.
9. **Top-level `graph.guards` entries are placement policies, applied by
   rewiring** (`guards.js`). Person C's classifier mock emits the full
   source-to-sink mesh and passes guards as `[{name, placement}]` (strings
   normalize to placement null). Before ingestion: a guard already named in any
   edge is left alone (hand-wired); otherwise its node is created if missing
   and spliced in front of its targets: a placement naming a node intercepts
   every edge INTO that node (or OUT OF it if it has no incoming edges);
   placement null / `"*"` / `"all"` targets every privileged sink. This
   reproduces Person C's `guardCoversPath` semantics in graph form.

## Data model (Neo4j)

- `(:Tool {id, role, privileged, rationale, scanId})` per node; one
  `(:Context {id: 'context', scanId})` per scan. Context has NO `role` property.
- All flow is `[:CAN_FLOW_INTO {scanId}]`, MERGEd (deduplicated): a
  `via: "context"` edge becomes `(from)->(context)` and `(context)->(to)`;
  anything else becomes one direct relationship.
- **Every node and relationship carries `scanId`** and every query filters on
  it: repeat scans are idempotent, concurrent scans cannot see each other, and
  cleanup is `MATCH (n {scanId}) DETACH DELETE n`. No constraints or indexes
  needed at this scale.

## Ingestion

`ingestGraph(graph, scanId)`: wipe the scanId namespace, UNWIND-MERGE Tool
nodes, MERGE Context, expand edges in JS (`expandEdges`), MERGE relationships.
Returns `{ nodesCreated, relationshipsCreated }` read back from the DB (true
post-MERGE state), logged as `[ingest]`. Assumes a validated graph; `scan()`
validates first.

## Queries

Vulnerable paths (parameterized, cycle-bounded):

```cypher
MATCH path = (s:Tool {role:'source', scanId:$scanId})-[:CAN_FLOW_INTO*..6]->(k:Tool {role:'sink', privileged:true, scanId:$scanId})
WHERE none(n IN nodes(path) WHERE coalesce(n.role, '') = 'guard')
  AND all(r IN relationships(path) WHERE r.scanId = $scanId)
RETURN [n IN nodes(path) | n.id] AS pathIds, k.id AS sinkId
ORDER BY sinkId, pathIds
```

**The `coalesce` is NOT optional.** Context nodes have no `role`, so
`n.role = 'guard'` is null for them, and Cypher's `none()` over a null
predicate returns null, which WHERE drops: without the coalesce EVERY path is
silently filtered and the scanner reports zero vulnerabilities (found
empirically; the originally circulated query had this bug). The `*..6` bound
plus relationship-uniqueness keeps cyclic inputs from exploding. The
relationship scanId check stops paths hopping between concurrent scans.

Best fix: same MATCH, `RETURN k.id, count(path) ORDER BY pathCount DESC,
sinkId ASC LIMIT 1` (deterministic alphabetical tie-break), mapped to the
recommendedFix shape with `pathsTotal` passed in; null when no rows. GDS
betweenness is out of scope (AuraDB Free has no GDS; paths-per-sink picks the
same chokepoint in the shared-context topology). Raw rows are logged as
`[paths:raw]` / `[bestfix:raw]` before mapping.

## scan() pipeline

validate (typed ValidationError, .status 400) -> `rewireGuards` (ruling 9,
logged as `[scan:rewired]` when it changes the edges) -> random 8-char scanId ->
`[scan:in]` log -> ingest -> both queries -> summary from the INPUT graph
(ruling 1) -> `[scan:out]` log -> cleanup of the scan namespace in `finally`
(skipped when `KEEP_SCAN_DATA=1`, the demo flag for showing the live graph in
Aura).

## Fixtures and expected results

Full JSON in `fixtures/`. Expectations (all asserted by `npm test`):

| Fixture | Shape | summary | paths | recommendedFix |
| --- | --- | --- | --- | --- |
| support-agent | 2 sources, 2 privileged sinks, passthrough, no guards, full mesh | 2/2/0/4 | 4, all critical, includes read_email->context->issue_refund | issue_refund, 2 of 4 |
| guarded-agent | same + human_approval guard hand-wired in front of issue_refund | 2/2/1/2 | 2, both into send_email, none touch the guard | send_email, 2 of 2 |
| clean-agent | 1 source, everything routed through the guard | 1/2/1/0 | 0 | null |

`test/run-samples.js` additionally asserts: a classifier-style graph (full mesh
plus `guards: [{name: 'human_approval', placement: 'issue_refund'}]`, exactly
what Person C's mock emits after apply-fix) loses both issue_refund paths to
rewiring; a wildcard string guard yields zero paths; garbage input rejects with
ValidationError; and the database is empty when the run ends.

## Acceptance criteria (all verified)

- [x] `npm run check:connect` prints the Aura address (stage-0 gate)
- [x] `node scripts/verify-ingest.js` — counts, idempotency, scanId isolation, direct edges
- [x] `node scripts/verify-queries.js` — 4/2/0 paths, determinism, tie-break, null fix
- [x] `npm test` — everything in the table above plus rewiring, wildcard, validation, empty DB
- [x] HTTP: health, bare and wrapped `/scan` bodies byte-identical and correct, 400 on malformed body and invalid JSON without crashing

## Integration

Person C's deployed `scan` function calls `SCAN_URL` with
`POST { graph }` and uses the JSON response as the Results. To go live: run
`npm start`, expose it publicly (tunnel or deploy), set `SCAN_URL` on the
Butterbase `scan` function, redeploy it. Until then their mock answers and
nobody is blocked. Known mock-vs-real divergences (severity vocabulary,
tie-break rule) are listed in the specs README.

## Open Questions

None.
