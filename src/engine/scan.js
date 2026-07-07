import { randomUUID } from 'node:crypto'
import { ingestGraph, deleteScan } from './ingest.js'
import { findVulnerablePaths, findBestFix } from './queries.js'
import { rewireGuards } from './guards.js'

const ROLES = new Set(['source', 'sink', 'guard', 'passthrough'])

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
  }
}

function validate(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new ValidationError('graph must be an object with a nodes array')
  }
  if (!Array.isArray(graph.nodes)) throw new ValidationError('graph.nodes must be an array')
  const ids = new Set()
  for (const n of graph.nodes) {
    if (!n || typeof n.id !== 'string' || n.id.length === 0) {
      throw new ValidationError('every node needs a non-empty string id')
    }
    if (!ROLES.has(n.role)) {
      throw new ValidationError(`node "${n.id}" has invalid role "${n.role}" (expected source | sink | guard | passthrough)`)
    }
    ids.add(n.id)
  }
  const edges = graph.edges ?? []
  if (!Array.isArray(edges)) throw new ValidationError('graph.edges must be an array')
  for (const e of edges) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') {
      throw new ValidationError('every edge needs string from and to')
    }
    if (!ids.has(e.from)) throw new ValidationError(`edge references unknown node "${e.from}"`)
    if (!ids.has(e.to)) throw new ValidationError(`edge references unknown node "${e.to}"`)
  }
}

function buildSummary(graph, rewired, vulnerablePathCount) {
  const guardNames = new Set(rewired.guards.map((g) => g.name))
  for (const n of graph.nodes) if (n.role === 'guard') guardNames.add(n.id)
  return {
    sources: graph.nodes.filter((n) => n.role === 'source').length,
    sinks: graph.nodes.filter((n) => n.role === 'sink' && Boolean(n.privileged)).length,
    guards: guardNames.size,
    vulnerablePaths: vulnerablePathCount,
  }
}

export async function scan(graph) {
  validate(graph)

  const rewired = rewireGuards(graph)
  if (rewired.edges.length !== (graph.edges ?? []).length) {
    console.log('[scan:rewired]', JSON.stringify(rewired.edges))
  }

  const scanId = randomUUID().slice(0, 8)
  console.log('[scan:in]', scanId, JSON.stringify(graph))
  try {
    await ingestGraph(rewired, scanId)
    const vulnerablePaths = await findVulnerablePaths(scanId)
    const recommendedFix = await findBestFix(scanId, vulnerablePaths.length)
    const results = {
      summary: buildSummary(graph, rewired, vulnerablePaths.length),
      vulnerablePaths,
      recommendedFix,
    }
    console.log('[scan:out]', scanId, JSON.stringify(results))
    return results
  } finally {
    if (process.env.KEEP_SCAN_DATA !== '1') await deleteScan(scanId)
  }
}
