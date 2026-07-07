// Spec 01 ruling 9: top-level graph.guards entries are placement policies.
// Person C's classifier mock emits the full source->sink mesh and passes
// guards as data; this module rewires them into the edge list so the path
// query needs no special cases.

export function normalizeGuards(guards) {
  if (!Array.isArray(guards)) return []
  return guards.map((g) => {
    if (typeof g === 'string') return { name: g, placement: null }
    return {
      name: g.guard || g.name || g.id || 'guard',
      placement: g.placement ?? g.at ?? g.on ?? null,
    }
  })
}

// Returns { nodes, edges, guards } with guard policies applied. Pure function.
export function rewireGuards(graph) {
  const nodes = [...(graph.nodes ?? [])]
  let edges = [...(graph.edges ?? [])]
  const guards = normalizeGuards(graph.guards)
  const nodeIds = new Set(nodes.map((n) => n.id))

  for (const guard of guards) {
    const wired = edges.some((e) => e.from === guard.name || e.to === guard.name)
    if (wired) continue

    const wildcard = guard.placement === null || guard.placement === '*' || guard.placement === 'all'
    const targets = wildcard
      ? nodes.filter((n) => n.role === 'sink' && n.privileged).map((n) => n.id)
      : [guard.placement]

    if (targets.length === 0) continue

    if (!nodeIds.has(guard.name)) {
      nodes.push({ id: guard.name, role: 'guard', privileged: false, rationale: '' })
      nodeIds.add(guard.name)
    }

    for (const target of targets) {
      const incoming = edges.filter((e) => e.to === target)
      if (incoming.length > 0) {
        // Intercept edges INTO the target: X -> guard, guard -> target.
        edges = edges.filter((e) => e.to !== target)
        for (const e of incoming) edges.push({ ...e, to: guard.name })
        edges.push({ from: guard.name, to: target })
      } else {
        // No incoming edges (e.g. a source): intercept its OUTGOING edges.
        const outgoing = edges.filter((e) => e.from === target)
        if (outgoing.length === 0) continue
        edges = edges.filter((e) => e.from !== target)
        edges.push({ from: target, to: guard.name })
        for (const e of outgoing) edges.push({ ...e, from: guard.name })
      }
    }
  }

  // Dedupe edges (rewiring can converge several mesh edges onto one leg).
  const seen = new Set()
  edges = edges.filter((e) => {
    const key = `${e.from}|${e.via ?? ''}|${e.to}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { nodes, edges, guards }
}
