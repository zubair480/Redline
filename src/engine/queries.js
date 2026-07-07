import { getDriver } from './db.js'

// Both queries share the same MATCH. The coalesce in the guard filter is
// load-bearing: Context nodes have no role property, and in Cypher a null
// predicate inside none() nulls the whole expression, which WHERE drops.
// The relationship scanId check keeps a path from hopping between two
// concurrent scans through a shared id.
const VULNERABLE_PATHS = `
MATCH path = (s:Tool {role:'source', scanId:$scanId})-[:CAN_FLOW_INTO*..6]->(k:Tool {role:'sink', privileged:true, scanId:$scanId})
WHERE none(n IN nodes(path) WHERE coalesce(n.role, '') = 'guard')
  AND all(r IN relationships(path) WHERE r.scanId = $scanId)
RETURN [n IN nodes(path) | n.id] AS pathIds, k.id AS sinkId
ORDER BY sinkId, pathIds`

const BEST_FIX = `
MATCH path = (s:Tool {role:'source', scanId:$scanId})-[:CAN_FLOW_INTO*..6]->(k:Tool {role:'sink', privileged:true, scanId:$scanId})
WHERE none(n IN nodes(path) WHERE coalesce(n.role, '') = 'guard')
  AND all(r IN relationships(path) WHERE r.scanId = $scanId)
RETURN k.id AS sinkId, count(path) AS pathCount
ORDER BY pathCount DESC, sinkId ASC
LIMIT 1`

export async function findVulnerablePaths(scanId) {
  const session = getDriver().session()
  try {
    const res = await session.run(VULNERABLE_PATHS, { scanId })
    const rows = res.records.map((r) => ({ pathIds: r.get('pathIds'), sinkId: r.get('sinkId') }))
    console.log('[paths:raw]', scanId, JSON.stringify(rows))
    return rows.map((row, i) => ({
      id: `p${i + 1}`,
      path: row.pathIds,
      severity: row.pathIds.length === 3 ? 'critical' : 'high',
      explanation: '',
    }))
  } finally {
    await session.close()
  }
}

export async function findBestFix(scanId, pathsTotal) {
  const session = getDriver().session()
  try {
    const res = await session.run(BEST_FIX, { scanId })
    const row = res.records[0]
    const raw = row ? { sinkId: row.get('sinkId'), pathCount: row.get('pathCount').toNumber() } : null
    console.log('[bestfix:raw]', scanId, JSON.stringify(raw))
    // Null when there is nothing to fix, matching Person C's mock (spec 01 ruling 2).
    if (!raw) return null
    return {
      guard: 'human_approval',
      placement: raw.sinkId,
      pathsEliminated: raw.pathCount,
      pathsTotal,
      rationale: '',
    }
  } finally {
    await session.close()
  }
}
