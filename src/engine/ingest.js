import { getDriver } from './db.js'

// Spec 02 edge rule: via 'context' routes through the shared Context node,
// anything else is a direct edge.
export function expandEdges(edges) {
  const legs = []
  for (const edge of edges) {
    if (edge.via === 'context') {
      legs.push({ fromId: edge.from, toId: 'context' })
      legs.push({ fromId: 'context', toId: edge.to })
    } else {
      legs.push({ fromId: edge.from, toId: edge.to })
    }
  }
  return legs
}

export async function ingestGraph(graph, scanId) {
  const session = getDriver().session()
  try {
    await session.run('MATCH (n {scanId: $scanId}) DETACH DELETE n', { scanId })

    await session.run(
      `UNWIND $nodes AS node
       MERGE (t:Tool {id: node.id, scanId: $scanId})
       SET t.role = node.role, t.privileged = node.privileged, t.rationale = node.rationale`,
      {
        scanId,
        nodes: graph.nodes.map((n) => ({
          id: n.id,
          role: n.role,
          privileged: Boolean(n.privileged),
          rationale: n.rationale ?? '',
        })),
      }
    )

    await session.run("MERGE (c:Context {id: 'context', scanId: $scanId})", { scanId })

    const legs = expandEdges(graph.edges ?? [])
    if (legs.length > 0) {
      await session.run(
        `UNWIND $legs AS leg
         MATCH (a {id: leg.fromId, scanId: $scanId})
         MATCH (b {id: leg.toId, scanId: $scanId})
         MERGE (a)-[r:CAN_FLOW_INTO {scanId: $scanId}]->(b)`,
        { scanId, legs }
      )
    }

    // Read counts back from the DB so the log reflects true post-MERGE state.
    const nodeRes = await session.run('MATCH (n {scanId: $scanId}) RETURN count(n) AS c', { scanId })
    const relRes = await session.run(
      'MATCH ({scanId: $scanId})-[r:CAN_FLOW_INTO {scanId: $scanId}]->({scanId: $scanId}) RETURN count(r) AS c',
      { scanId }
    )
    const nodesCreated = nodeRes.records[0].get('c').toNumber()
    const relationshipsCreated = relRes.records[0].get('c').toNumber()
    console.log('[ingest]', scanId, { nodesCreated, relationshipsCreated })
    return { nodesCreated, relationshipsCreated }
  } finally {
    await session.close()
  }
}

export async function deleteScan(scanId) {
  const session = getDriver().session()
  try {
    await session.run('MATCH (n {scanId: $scanId}) DETACH DELETE n', { scanId })
  } finally {
    await session.close()
  }
}
