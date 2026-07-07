// Acceptance checks for specs 02 (data model) and 03 (ingestion).
import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getDriver, close } from '../src/engine/db.js'
import { ingestGraph, deleteScan } from '../src/engine/ingest.js'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/support-agent.json', import.meta.url)))
const SCAN_A = 'verify-a'
const SCAN_B = 'verify-b'
const SCAN_DIRECT = 'verify-direct'

async function run(cypher, params) {
  const session = getDriver().session()
  try {
    const res = await session.run(cypher, params)
    return res.records
  } finally {
    await session.close()
  }
}

const num = (records, key) => records[0].get(key).toNumber()

try {
  // Spec 03: ingest returns exact counts
  const first = await ingestGraph(fixture, SCAN_A)
  assert.deepEqual(first, { nodesCreated: 6, relationshipsCreated: 4 }, 'first ingest counts')

  // Spec 02: read-back counts
  const toolCount = num(await run('MATCH (n:Tool {scanId: $id}) RETURN count(n) AS c', { id: SCAN_A }), 'c')
  assert.equal(toolCount, 5, 'Tool node count')

  const ctx = await run('MATCH (c:Context {scanId: $id}) RETURN count(c) AS c, collect(c.role) AS roles', { id: SCAN_A })
  assert.equal(num(ctx, 'c'), 1, 'Context node count')
  assert.deepEqual(ctx[0].get('roles'), [], 'Context has no role property')

  const relCount = num(
    await run('MATCH ({scanId: $id})-[r:CAN_FLOW_INTO {scanId: $id}]->({scanId: $id}) RETURN count(r) AS c', { id: SCAN_A }),
    'c'
  )
  assert.equal(relCount, 4, 'deduped relationship count')

  // Spec 02: roles read back correctly
  const roles = await run('MATCH (t:Tool {scanId: $id}) RETURN t.id AS id, t.role AS role, t.privileged AS priv ORDER BY id', { id: SCAN_A })
  const byId = Object.fromEntries(roles.map((r) => [r.get('id'), { role: r.get('role'), priv: r.get('priv') }]))
  assert.deepEqual(byId, {
    fetch_url: { role: 'source', priv: false },
    issue_refund: { role: 'sink', priv: true },
    read_email: { role: 'source', priv: false },
    search_orders: { role: 'passthrough', priv: false },
    send_email: { role: 'sink', priv: true },
  }, 'roles and privileged flags')

  // Spec 03: idempotency, same scanId twice gives identical counts
  const second = await ingestGraph(fixture, SCAN_A)
  assert.deepEqual(second, first, 'second ingest identical')

  // Spec 02: a second scanId does not disturb the first
  await ingestGraph(fixture, SCAN_B)
  const toolCountAfterB = num(await run('MATCH (n:Tool {scanId: $id}) RETURN count(n) AS c', { id: SCAN_A }), 'c')
  assert.equal(toolCountAfterB, 5, 'scan A untouched by scan B')

  // Spec 03: direct edge (no via) produces a single direct relationship
  const directGraph = {
    nodes: [
      { id: 'guard_x', role: 'guard', privileged: false, rationale: '' },
      { id: 'sink_y', role: 'sink', privileged: true, rationale: '' },
    ],
    edges: [{ from: 'guard_x', to: 'sink_y' }],
    guards: ['guard_x'],
  }
  const direct = await ingestGraph(directGraph, SCAN_DIRECT)
  assert.deepEqual(direct, { nodesCreated: 3, relationshipsCreated: 1 }, 'direct edge counts (2 tools + context)')
  const directRel = num(
    await run("MATCH (:Tool {id: 'guard_x', scanId: $id})-[r:CAN_FLOW_INTO]->(:Tool {id: 'sink_y', scanId: $id}) RETURN count(r) AS c", { id: SCAN_DIRECT }),
    'c'
  )
  assert.equal(directRel, 1, 'direct relationship exists between named nodes')

  console.log('[verify] all spec 02 and 03 acceptance criteria passed')
} finally {
  await deleteScan(SCAN_A)
  await deleteScan(SCAN_B)
  await deleteScan(SCAN_DIRECT)
  await close()
}
