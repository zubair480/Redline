// RocketRide stage (Person B contract): /classify and /explain, LLM-powered.
//
// classify:  Config  -> Graph   (roles + rationale per tool, source->sink edges
//                                via the shared context, normalized guards)
// explain:   { path, severity, graph }      -> { explanation, fix, remediation }
//            { recommendedFix, graph }      -> { rationale, remediation }
//
// Shapes match the mock in functions/scan.ts field-for-field (spec 07), so the
// orchestrator swaps to these endpoints with env vars only. Every pipeline call
// has a deterministic heuristic fallback: if the SDK is unavailable or the call
// fails, we return the same output the mock would — the pipeline never breaks.
//
// Transport: RocketRide Cloud speaks DAP-over-WebSocket (not plain HTTP), so we
// use the rocketride SDK. The pipelines are booted once at startup and their
// tokens are reused for every request.

import { RocketRideClient, Question } from 'rocketride'

const ROCKETRIDE_URI = process.env.ROCKETRIDE_URI || 'https://api.rocketride.ai'
const ROCKETRIDE_AUTH = process.env.ROCKETRIDE_AUTH || process.env.ROCKETRIDE_API_KEY || ''

// Pipeline file paths (relative to cwd — the repo root)
const CLASSIFY_PIPE = 'pipelines/classify.pipe'
const EXPLAIN_PIPE = 'pipelines/explain.pipe'

// ---- SDK client + pipeline boot (singleton, lazy) ----

let _client = null
let _classifyToken = null
let _explainToken = null
let _bootPromise = null

async function usePipeline(filepath, source) {
  const opts = { filepath, useExisting: true }
  if (source) opts.source = source
  try {
    return (await _client.use(opts)).token
  } catch (_) {
    // First run — no existing pipeline yet
    const opts2 = { filepath }
    if (source) opts2.source = source
    return (await _client.use(opts2)).token
  }
}

async function boot() {
  if (_bootPromise) return _bootPromise
  _bootPromise = (async () => {
    try {
      _client = new RocketRideClient({ uri: ROCKETRIDE_URI, auth: ROCKETRIDE_AUTH })
      await _client.connect()

      _classifyToken = await usePipeline(CLASSIFY_PIPE)
      console.log('[rocketride:boot] classify pipeline ready, token:', _classifyToken)

      _explainToken = await usePipeline(EXPLAIN_PIPE)
      console.log('[rocketride:boot] explain pipeline ready, token:', _explainToken)
    } catch (err) {
      console.error('[rocketride:boot] SDK init failed, will use heuristic fallback:', err.message)
      _client = null
      _classifyToken = null
      _explainToken = null
    }
  })()
  return _bootPromise
}

// Boot eagerly on import so the first request doesn't wait.
boot()

// ---- JSON extraction ----

function extractJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i }))
  if (start === Infinity) throw new Error('no JSON in pipeline response')
  return JSON.parse(t.slice(start))
}

// Extract the best JSON answer from a pipeline response. The answers array may
// contain multiple elements (e.g. a summary object + the raw LLM JSON). We try
// each answer looking for one that parses into the expected shape.
function extractAnswer(response) {
  const answers = response && response.answers ? response.answers : []
  // Try each answer, preferring later ones (the LLM output tends to be last)
  for (let i = answers.length - 1; i >= 0; i--) {
    const a = answers[i]
    try {
      if (typeof a === 'object' && a !== null && (a.nodes || a.explanation || a.rationale)) return a
      if (typeof a === 'string') return extractJson(a)
    } catch (_) { /* try next */ }
  }
  // Fallback: try the first answer raw
  if (answers.length > 0) {
    const a = answers[0]
    if (typeof a === 'object') return a
    return extractJson(a)
  }
  throw new Error('no answers in pipeline response')
}

// Cache by exact input: repeat demo scans skip the pipeline entirely.
const cache = new Map()
const CACHE_MAX = 100
function cached(key, compute) {
  if (cache.has(key)) return cache.get(key)
  const p = compute().catch((err) => { cache.delete(key); throw err })
  cache.set(key, p)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return p
}

// ---- heuristic fallback (mirrors the orchestrator mock) ----

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

// ---- /classify via RocketRide SDK ----

const ROLES = new Set(['source', 'sink', 'guard', 'passthrough'])

async function sdkClassifyTools(tools) {
  await boot()
  if (!_client || !_classifyToken) throw new Error('SDK not available')

  // classify.pipe uses a chat source — use client.chat() with a Question
  const question = new Question({ expectJson: true })
  question.addQuestion(
    `Classify these AI agent tools into security roles (source/sink/guard/passthrough) and return the Graph JSON.\n\nTools:\n${JSON.stringify(tools, null, 2)}`
  )

  const response = await _client.chat({ token: _classifyToken, question })
  const parsed = extractAnswer(response)

  // If the pipeline returned a full Graph, use it directly
  if (parsed.nodes && Array.isArray(parsed.nodes)) return parsed

  // Otherwise treat as an array of per-tool classifications
  if (!Array.isArray(parsed)) throw new Error('classify: expected JSON array or Graph')
  return parsed
}

export async function classify(config) {
  const tools = Array.isArray(config.tools) ? config.tools : []
  let result
  try {
    result = await cached('classify:' + JSON.stringify(tools), async () => {
      const raw = await sdkClassifyTools(tools)

      // If we got a full Graph back (nodes, edges, guards), return it
      if (raw.nodes && Array.isArray(raw.nodes)) {
        console.log('[classify:rocketride]', { tools: tools.length })
        return raw
      }

      // Otherwise raw is a per-tool array — build the graph
      const byName = {}
      for (const e of raw) if (e && typeof e.name === 'string') byName[e.name] = e
      const nodes = tools.map((t) => {
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
      console.log('[classify:rocketride]', { tools: tools.length })
      return { nodes }
    })
  } catch (err) {
    console.error('[classify:fallback]', err.message)
    const nodes = tools.map((t) => {
      const { role, privileged } = heuristicRole(t.description)
      return { id: t.name, role, privileged, rationale: heuristicRationale(role, t.description) }
    })
    result = { nodes }
  }

  // Ensure edges and guards exist
  const nodes = result.nodes
  const edges = result.edges || []
  if (edges.length === 0) {
    for (const s of nodes.filter((n) => n.role === 'source')) {
      for (const k of nodes.filter((n) => n.role === 'sink')) {
        edges.push({ from: s.id, via: 'context', to: k.id })
      }
    }
  }
  return { nodes, edges, guards: result.guards || normalizeGuards(config.guards) }
}

// ---- /explain via RocketRide SDK ----

async function sdkExplain(body) {
  await boot()
  if (!_client || !_explainToken) throw new Error('SDK not available')

  // explain.pipe uses a chat source — use client.chat() with a Question
  const question = new Question({ expectJson: true })
  question.addQuestion(JSON.stringify(body))

  const response = await _client.chat({ token: _explainToken, question })
  return extractAnswer(response)
}

export async function explainPath(body) {
  const { path, severity } = body
  const src = path[0]
  const sink = path[path.length - 1]
  try {
    const out = await cached('explain:' + JSON.stringify([path, severity]), () => sdkExplain(body))
    console.log('[explain:rocketride]', { path: path.join('->') })
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

export async function explainFix(body) {
  const rf = body.recommendedFix
  try {
    const out = await cached('fix:' + JSON.stringify(rf), () => sdkExplain(body))
    console.log('[explain-fix:rocketride]', { placement: rf.placement })
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
