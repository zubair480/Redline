// RocketRide stage (Person B contract): /classify and /explain, LLM-powered.
//
// classify:  Config  -> Graph   (roles + rationale per tool, source->sink edges
//                                via the shared context, normalized guards)
// explain:   { path, severity, graph }      -> { explanation, fix, remediation }
//            { recommendedFix, graph }      -> { rationale, remediation }
//
// Shapes match the mock in functions/scan.ts field-for-field (spec 07), so the
// orchestrator swaps to these endpoints with env vars only. Every LLM call has
// a deterministic heuristic fallback: if the API key is missing or the call
// fails, we return the same output the mock would — the pipeline never breaks.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const CLASSIFY_MODEL = process.env.ROCKETRIDE_CLASSIFY_MODEL || 'claude-sonnet-5'
const EXPLAIN_MODEL = process.env.ROCKETRIDE_EXPLAIN_MODEL || 'claude-haiku-4-5-20251001'
const LLM_TIMEOUT_MS = 30000

// ------------------------- LLM plumbing -------------------------

async function complete(model, system, user, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    })
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`)
    const data = await r.json()
    return data.content?.[0]?.text ?? ''
  } finally {
    clearTimeout(timer)
  }
}

// The model is told to answer with bare JSON, but strip fences defensively.
function extractJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i }))
  if (start === Infinity) throw new Error('no JSON in LLM response')
  return JSON.parse(t.slice(start))
}

// Cache by exact input: repeat demo scans skip the LLM entirely and always
// show the same prose.
const cache = new Map()
const CACHE_MAX = 100
function cached(key, compute) {
  if (cache.has(key)) return cache.get(key)
  const p = compute().catch((err) => { cache.delete(key); throw err })
  cache.set(key, p)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return p
}

// ------------------------- heuristic fallback (mirrors the orchestrator mock) -------------------------

const GUARD_KW = ['approv', 'verify', 'confirm', 'human', 'review', 'sanitiz',
  'moderat', 'allowlist', 'whitelist', 'guard', 'permission check', 'validate input']
const SINK_KW = ['refund', 'payment', 'pay ', 'transfer', 'send', 'delete', 'remove',
  'execute', 'run command', 'deploy', 'purchase', 'charge', 'issue', 'publish',
  'post ', 'write', 'modify', 'wire', 'provision', 'grant', 'email a', 'reply']
const SOURCE_KW = ['read', 'incoming', 'customer-provided', 'fetch', 'url', 'external',
  'scrape', 'download', 'receive', 'inbox', 'message', 'comment', 'ticket', 'upload',
  'webhook', 'user input', 'untrusted', 'browse']

function anyKw(text, kws) {
  const t = ' ' + (text || '').toLowerCase() + ' '
  return kws.some((k) => t.includes(k))
}

function heuristicRole(desc) {
  if (anyKw(desc, GUARD_KW)) return { role: 'guard', privileged: false }
  if (anyKw(desc, SINK_KW)) return { role: 'sink', privileged: true }
  if (anyKw(desc, SOURCE_KW)) return { role: 'source', privileged: false }
  return { role: 'passthrough', privileged: false }
}

function heuristicRationale(role, desc) {
  return role === 'source' ? `Ingests untrusted external input: "${desc}"`
    : role === 'sink' ? `Performs a privileged action: "${desc}"`
    : role === 'guard' ? `Acts as a safety check: "${desc}"`
    : `Internal / low-risk operation: "${desc}"`
}

function normalizeGuards(guards) {
  if (!Array.isArray(guards)) return []
  return guards.map((g) => {
    if (typeof g === 'string') return { name: g, placement: null }
    return { name: g.guard || g.name || g.id || 'guard', placement: g.placement ?? g.at ?? g.on ?? null }
  })
}

// ------------------------- /classify -------------------------

const ROLES = new Set(['source', 'sink', 'guard', 'passthrough'])

const CLASSIFY_SYSTEM = `You are a security classifier for AI agent tools. For each tool, assign exactly one role:
- "source": ingests data an attacker could influence (emails, URLs, webhooks, user messages, scraped content)
- "sink": takes a privileged or irreversible action (payments, sending messages, deleting, executing, deploying)
- "guard": a safety check that gates other actions (human approval, verification, sanitization)
- "passthrough": internal, read-only, or low-risk operations

Mark sinks "privileged": true (others false). Write a "rationale": one concrete sentence tied to the tool's description explaining the classification from a prompt-injection standpoint.

Respond with ONLY a JSON array, one object per tool, in the same order:
[{ "name": "...", "role": "...", "privileged": true|false, "rationale": "..." }]`

async function llmClassifyTools(tools) {
  const user = `Agent tools to classify:\n${JSON.stringify(tools, null, 2)}`
  const raw = await complete(CLASSIFY_MODEL, CLASSIFY_SYSTEM, user, 220 * tools.length + 200)
  const parsed = extractJson(raw)
  if (!Array.isArray(parsed)) throw new Error('classify: expected a JSON array')
  const byName = {}
  for (const e of parsed) if (e && typeof e.name === 'string') byName[e.name] = e
  // Per-tool validation: any entry the LLM fumbled falls back to the heuristic.
  return tools.map((t) => {
    const e = byName[t.name]
    if (!e || !ROLES.has(e.role)) {
      const { role, privileged } = heuristicRole(t.description)
      return { id: t.name, role, privileged, rationale: heuristicRationale(role, t.description) }
    }
    return {
      id: t.name,
      role: e.role,
      privileged: e.role === 'sink' ? e.privileged !== false : e.privileged === true,
      rationale: typeof e.rationale === 'string' && e.rationale ? e.rationale : heuristicRationale(e.role, t.description),
    }
  })
}

export async function classify(config) {
  const tools = Array.isArray(config.tools) ? config.tools : []
  let nodes
  try {
    nodes = await cached('classify:' + JSON.stringify(tools), () => llmClassifyTools(tools))
    console.log('[classify:llm]', { model: CLASSIFY_MODEL, tools: tools.length })
  } catch (err) {
    console.error('[classify:fallback]', err.message)
    nodes = tools.map((t) => {
      const { role, privileged } = heuristicRole(t.description)
      return { id: t.name, role, privileged, rationale: heuristicRationale(role, t.description) }
    })
  }
  // Shared-context assumption (spec 01): every source can steer every sink
  // through the agent's context window.
  const edges = []
  for (const s of nodes.filter((n) => n.role === 'source')) {
    for (const k of nodes.filter((n) => n.role === 'sink')) {
      edges.push({ from: s.id, via: 'context', to: k.id })
    }
  }
  return { nodes, edges, guards: normalizeGuards(config.guards) }
}

// ------------------------- /explain -------------------------

function pathContext(graph, ids) {
  const byId = {}
  for (const n of graph?.nodes || []) byId[n.id] = n
  return ids
    .filter((id) => id !== 'context')
    .map((id) => `- ${id}: ${byId[id]?.rationale || byId[id]?.role || 'tool'}`)
    .join('\n')
}

const EXPLAIN_SYSTEM = `You are a security analyst explaining prompt-injection paths in AI agents to a developer.
Respond with ONLY a JSON object: { "explanation": "...", "fix": "...", "remediation": "..." }
- "explanation": 2-3 sentences, concrete about the attack (e.g. "a crafted email instructs the agent to...") and naming the actual source and sink tools by id.
- "fix": one line stating the guard to add and where.
- "remediation": a short paste-ready Python validator stub gating the sink.`

async function llmExplainPath({ path, severity, graph }) {
  const src = path[0]
  const sink = path[path.length - 1]
  const user = `Vulnerable path: ${path.join(' -> ')} (severity: ${severity})
The "context" node is the agent's shared LLM context window.
Tools on the path:
${pathContext(graph, path)}
Explain how an attacker exploits this path from "${src}" to "${sink}".`
  return extractJson(await complete(EXPLAIN_MODEL, EXPLAIN_SYSTEM, user, 500))
}

export async function explainPath(body) {
  const { path, severity } = body
  const src = path[0]
  const sink = path[path.length - 1]
  try {
    const out = await cached('explain:' + JSON.stringify([path, severity]), () => llmExplainPath(body))
    console.log('[explain:llm]', { model: EXPLAIN_MODEL, path: path.join('->') })
    return {
      explanation: out.explanation || fallbackExplanation(body),
      fix: out.fix || `Require a guard before "${sink}".`,
      remediation: out.remediation || fallbackRemediation(sink),
    }
  } catch (err) {
    console.error('[explain:fallback]', err.message)
    return {
      explanation: fallbackExplanation(body),
      fix: `Require human approval before "${sink}" runs on input influenced by "${src}".`,
      remediation: fallbackRemediation(sink),
    }
  }
}

const RATIONALE_SYSTEM = `You are a security analyst justifying a recommended fix for an AI agent to a developer.
Respond with ONLY a JSON object: { "rationale": "...", "remediation": "..." }
- "rationale": 1-2 sentences on why this guard at this placement is the optimal chokepoint, citing the paths eliminated.
- "remediation": a short paste-ready Python validator stub implementing the guard.`

export async function explainFix(body) {
  const rf = body.recommendedFix
  try {
    const user = `Recommended fix: ${JSON.stringify(rf)}
Graph nodes:
${pathContext(body.graph, (body.graph?.nodes || []).map((n) => n.id))}
Justify placing guard "${rf.guard}" at "${rf.placement}".`
    const out = await cached('fix:' + JSON.stringify(rf), async () => extractJson(await complete(EXPLAIN_MODEL, RATIONALE_SYSTEM, user, 400)))
    console.log('[explain-fix:llm]', { placement: rf.placement })
    return {
      rationale: out.rationale || fallbackRationale(rf),
      remediation: out.remediation || fallbackRemediation(rf.placement),
    }
  } catch (err) {
    console.error('[explain-fix:fallback]', err.message)
    return { rationale: fallbackRationale(rf), remediation: fallbackRemediation(rf.placement) }
  }
}

// Fallback prose mirrors the orchestrator mock's templates.
function fallbackExplanation({ path, severity, graph }) {
  const byId = {}
  for (const n of graph?.nodes || []) byId[n.id] = n
  const src = path[0]
  const sink = path[path.length - 1]
  return `Untrusted data from "${src}" (${byId[src]?.rationale || 'external input'}) flows through the agent's shared context into "${sink}" (${byId[sink]?.rationale || 'privileged action'}) with no guard in between. A prompt injection planted in the "${src}" input can coerce the agent into calling "${sink}", triggering a ${severity}-severity action the user never intended.`
}

function fallbackRationale(rf) {
  return `Placing a ${rf.guard} check at "${rf.placement}" forces explicit approval before the most dangerous action, eliminating ${rf.pathsEliminated} of ${rf.pathsTotal} vulnerable paths with a single guard.`
}

function fallbackRemediation(sink) {
  return `def guard_${sink}(request):\n    if not request.human_approved:\n        raise PermissionError('${sink} requires human approval')\n    return request`
}
