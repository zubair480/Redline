// RocketRide stage (Person B contract): /classify and /explain.
//
// classify:  Config  -> Graph   (roles + rationale per tool, source->sink edges
//                                via the shared context, normalized guards)
// explain:   { path, severity, graph }      -> { explanation, fix, remediation }
//            { recommendedFix, graph }      -> { rationale, remediation }
//
// Shapes match the mock in functions/scan.ts field-for-field (spec 07).
//
// THREE-TIER strategy, so the demo is always correct:
//   1. RocketRide Cloud pipeline (via the rocketride SDK, DAP-over-WebSocket).
//      Validated hard: the returned graph must cover exactly the input tools.
//   2. Direct Claude (Anthropic API) if RocketRide errors OR fails validation.
//   3. Deterministic keyword heuristic if the LLM is unavailable too.
//
// Why the hard validation: RocketRide's pipelines use a *chat* source, which
// accumulates conversation state — a call can return the previous call's tools
// merged in, or (until the stale conversation is cleared) a canned example.
// A 200 with wrong data would otherwise sail past a naive error-only fallback.
// We reset the pipeline conversation at boot and filter every response down to
// the exact input tools; anything short of a clean match drops to Claude.

import { RocketRideClient, Question } from 'rocketride'

const ROCKETRIDE_URI = process.env.ROCKETRIDE_URI || 'https://api.rocketride.ai'
const ROCKETRIDE_AUTH = process.env.ROCKETRIDE_AUTH || process.env.ROCKETRIDE_API_KEY || ''
const CLASSIFY_PIPE = 'pipelines/classify.pipe'
const EXPLAIN_PIPE = 'pipelines/explain.pipe'

// Claude fallback models
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const CLASSIFY_MODEL = process.env.ROCKETRIDE_CLASSIFY_MODEL || 'claude-sonnet-5'
const EXPLAIN_MODEL = process.env.ROCKETRIDE_EXPLAIN_MODEL || 'claude-haiku-4-5-20251001'
const LLM_TIMEOUT_MS = 30000

const ROLES = new Set(['source', 'sink', 'guard', 'passthrough'])

// ---- SDK client + pipeline boot (singleton, lazy) ----

let _client = null
let _classifyToken = null
let _explainToken = null
let _bootPromise = null

// Attach to the running pipeline, then terminate + re-acquire so we start from a
// CLEAN conversation (RocketRide chat sources persist history across clients).
async function freshPipeline(filepath) {
  let token
  try {
    token = (await _client.use({ filepath, useExisting: true })).token
    try { await _client.terminate(token) } catch (_) { /* nothing to stop */ }
  } catch (_) { /* not running yet */ }
  return (await _client.use({ filepath })).token
}

async function boot() {
  if (_bootPromise) return _bootPromise
  _bootPromise = (async () => {
    if (!ROCKETRIDE_AUTH) { console.log('[rocketride:boot] no ROCKETRIDE_AUTH — using Claude/heuristic'); return }
    try {
      _client = new RocketRideClient({ uri: ROCKETRIDE_URI, auth: ROCKETRIDE_AUTH, requestTimeout: LLM_TIMEOUT_MS })
      await _client.connect()
      _classifyToken = await freshPipeline(CLASSIFY_PIPE)
      _explainToken = await freshPipeline(EXPLAIN_PIPE)
      console.log('[rocketride:boot] pipelines ready (classify + explain)')
    } catch (err) {
      console.error('[rocketride:boot] SDK init failed, falling back to Claude:', err.message)
      _client = null; _classifyToken = null; _explainToken = null
    }
  })()
  return _bootPromise
}
boot()

// ---- response parsing ----

function extractJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i }))
  if (start === Infinity) throw new Error('no JSON in response')
  // Walk to the matching close so trailing prose doesn't break JSON.parse.
  const open = t[start], close = open === '[' ? ']' : '}'
  let depth = 0
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++
    else if (t[i] === close && --depth === 0) return JSON.parse(t.slice(start, i + 1))
  }
  return JSON.parse(t.slice(start))
}

// A RocketRide response has an `answers` array that may hold several shapes; find
// the one that parses to an object exposing any of the requested keys.
function pickAnswer(response, keys) {
  const answers = (response && response.answers) || []
  for (let i = answers.length - 1; i >= 0; i--) {
    const a = answers[i]
    try {
      const obj = typeof a === 'string' ? extractJson(a) : a
      if (obj && typeof obj === 'object' && keys.some((k) => obj[k] !== undefined)) return obj
    } catch (_) { /* try the next answer */ }
  }
  return null
}

// Cache by exact input: repeat scans skip the LLM entirely.
const cache = new Map()
const CACHE_MAX = 200
function cached(key, compute) {
  if (cache.has(key)) return cache.get(key)
  const p = compute().catch((err) => { cache.delete(key); throw err })
  cache.set(key, p)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return p
}

// ---- Claude (tier 2) ----

async function complete(model, system, user, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal: controller.signal,
    })
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`)
    return (await r.json()).content?.[0]?.text ?? ''
  } finally { clearTimeout(timer) }
}

const CLASSIFY_SYSTEM = `You are a security classifier for AI agent tools. For each tool, assign exactly one role:
- "source": ingests data an attacker could influence (emails, URLs, webhooks, user messages, scraped content)
- "sink": takes a privileged or irreversible action (payments, sending messages, deleting, executing, deploying)
- "guard": a safety check that gates other actions (human approval, verification, sanitization)
- "passthrough": internal, read-only, or low-risk operations
Mark sinks "privileged": true (others false). Write a "rationale": one concrete sentence tied to the tool's description, from a prompt-injection standpoint.
Respond with ONLY a JSON array, one object per tool, same order:
[{ "name": "...", "role": "...", "privileged": true|false, "rationale": "..." }]`

async function claudeClassify(tools) {
  const raw = await complete(CLASSIFY_MODEL, CLASSIFY_SYSTEM, `Agent tools:\n${JSON.stringify(tools, null, 2)}`, 220 * tools.length + 200)
  const parsed = extractJson(raw)
  if (!Array.isArray(parsed)) throw new Error('claude classify: expected array')
  return parsed
}

const EXPLAIN_SYSTEM = `You are a security analyst explaining prompt-injection paths in AI agents to a developer.
Respond with ONLY a JSON object: { "explanation": "...", "fix": "...", "remediation": "..." }
- "explanation": 2-3 sentences, concrete about the attack (e.g. "a crafted email instructs the agent to...") naming the source and sink tools by id.
- "fix": one line stating the guard to add and where.
- "remediation": a short paste-ready Python validator stub gating the sink.`

const RATIONALE_SYSTEM = `You are a security analyst justifying a recommended fix for an AI agent.
Respond with ONLY a JSON object: { "rationale": "...", "remediation": "..." }
- "rationale": 1-2 sentences on why this guard at this placement is the optimal chokepoint, citing paths eliminated.
- "remediation": a short paste-ready Python validator stub implementing the guard.`

function pathContext(graph, ids) {
  const byId = {}
  for (const n of graph?.nodes || []) byId[n.id] = n
  return ids.filter((id) => id !== 'context').map((id) => `- ${id}: ${byId[id]?.rationale || byId[id]?.role || 'tool'}`).join('\n')
}

async function claudeExplainPath(body) {
  const { path, severity, graph } = body
  const src = path[0], sink = path[path.length - 1]
  const user = `Vulnerable path: ${path.join(' -> ')} (severity: ${severity})
The "context" node is the agent's shared LLM context window.
Tools on the path:
${pathContext(graph, path)}
Explain how an attacker exploits this path from "${src}" to "${sink}".`
  return extractJson(await complete(EXPLAIN_MODEL, EXPLAIN_SYSTEM, user, 500))
}

async function claudeExplainFix(body) {
  const rf = body.recommendedFix
  const user = `Recommended fix: ${JSON.stringify(rf)}
Graph nodes:
${pathContext(body.graph, (body.graph?.nodes || []).map((n) => n.id))}
Justify placing guard "${rf.guard}" at "${rf.placement}".`
  return extractJson(await complete(EXPLAIN_MODEL, RATIONALE_SYSTEM, user, 400))
}

// ---- heuristic (tier 3) ----

const GUARD_KW = ['approv', 'verify', 'confirm', 'human', 'review', 'sanitiz', 'moderat', 'allowlist', 'whitelist', 'guard', 'permission check', 'validate input']
const SINK_KW = ['refund', 'payment', 'pay ', 'transfer', 'send', 'delete', 'remove', 'execute', 'run command', 'deploy', 'purchase', 'charge', 'issue', 'publish', 'post ', 'write', 'modify', 'wire', 'provision', 'grant', 'email a', 'reply']
const SOURCE_KW = ['read', 'incoming', 'customer-provided', 'fetch', 'url', 'external', 'scrape', 'download', 'receive', 'inbox', 'message', 'comment', 'ticket', 'upload', 'webhook', 'user input', 'untrusted', 'browse']

function anyKw(text, kws) { const t = ' ' + (text || '').toLowerCase() + ' '; return kws.some((k) => t.includes(k)) }
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
  return guards.map((g) => (typeof g === 'string'
    ? { name: g, placement: null }
    : { name: g.guard || g.name || g.id || 'guard', placement: g.placement ?? g.at ?? g.on ?? null }))
}

// ---- normalization + validation ----

// Turn a raw per-tool array (from RocketRide or Claude) into clean nodes, but
// ONLY if it covers exactly the input tools. Returns null on any gap so the
// caller drops to the next tier. Extra nodes (chat-state leakage) are ignored.
function nodesFrom(rawArray, tools) {
  if (!Array.isArray(rawArray)) return null
  const byName = new Map()
  for (const e of rawArray) if (e && typeof e.name === 'string') byName.set(e.name, e)
  const nodes = []
  for (const t of tools) {
    const e = byName.get(t.name)
    if (!e || !ROLES.has(e.role)) return null // missing/invalid -> reject whole result
    nodes.push({
      id: t.name,
      role: e.role,
      privileged: e.role === 'sink' ? e.privileged !== false : e.privileged === true,
      rationale: (typeof e.rationale === 'string' && e.rationale) ? e.rationale : heuristicRationale(e.role, t.description),
    })
  }
  return nodes
}

// RocketRide may return a full Graph ({nodes:[{id,role,...}]}) or a per-tool
// array ([{name,role,...}]). Normalize either into a per-tool-array shape.
function toToolArray(obj) {
  if (Array.isArray(obj)) return obj
  if (obj && Array.isArray(obj.nodes)) return obj.nodes.map((n) => ({ name: n.id ?? n.name, role: n.role, privileged: n.privileged, rationale: n.rationale }))
  return null
}

// ---- classify ----

// Serialize SDK access: chat is stateful per token, so we reset the pipeline to
// a clean single-turn conversation before each call. Running these concurrently
// would let one call terminate another's token mid-flight.
let _sdkChain = Promise.resolve()
function withSdkLock(fn) {
  const run = _sdkChain.then(fn, fn)
  _sdkChain = run.then(() => {}, () => {})
  return run
}

// Reset to a fresh, empty conversation so accumulated chat history from prior
// calls can't merge into this response.
async function resetClassify() {
  if (_classifyToken) { try { await _client.terminate(_classifyToken) } catch (_) { /* already stopped */ } }
  _classifyToken = (await _client.use({ filepath: CLASSIFY_PIPE })).token
}

async function rocketrideClassify(tools) {
  await boot()
  if (!_client) throw new Error('RocketRide unavailable')
  return withSdkLock(async () => {
    await resetClassify()
    const q = new Question({ expectJson: true })
    q.addQuestion(`Classify these AI agent tools into security roles (source/sink/guard/passthrough) and return the Graph JSON.\n\nTools:\n${JSON.stringify(tools, null, 2)}`)
    const res = await _client.chat({ token: _classifyToken, question: q })
    const obj = pickAnswer(res, ['nodes', 'name', 'role'])
    const nodes = nodesFrom(toToolArray(obj), tools)
    if (!nodes) throw new Error('RocketRide classify did not cover the input tools')
    return nodes
  })
}

export async function classify(config) {
  const tools = Array.isArray(config.tools) ? config.tools : []
  let nodes = null
  try {
    nodes = await cached('classify:' + JSON.stringify(tools), async () => {
      try {
        const n = await rocketrideClassify(tools)
        console.log('[classify:rocketride]', { tools: tools.length })
        return n
      } catch (err) {
        console.error('[classify:rocketride-miss]', err.message)
        const n = nodesFrom(await claudeClassify(tools), tools)
        if (!n) throw new Error('claude classify incomplete')
        console.log('[classify:claude]', { tools: tools.length })
        return n
      }
    })
  } catch (err) {
    console.error('[classify:heuristic]', err.message)
    nodes = tools.map((t) => { const { role } = heuristicRole(t.description); return { id: t.name, role, privileged: heuristicRole(t.description).privileged, rationale: heuristicRationale(role, t.description) } })
  }

  // Edges: shared-context source->sink (engine rewires guards from graph.guards).
  const edges = []
  for (const s of nodes.filter((n) => n.role === 'source')) {
    for (const k of nodes.filter((n) => n.role === 'sink')) edges.push({ from: s.id, via: 'context', to: k.id })
  }
  return { nodes, edges, guards: normalizeGuards(config.guards) }
}

// ---- explain ----

async function rocketrideExplain(body) {
  await boot()
  if (!_client || !_explainToken) throw new Error('RocketRide unavailable')
  const q = new Question({ expectJson: true })
  q.addQuestion(JSON.stringify(body))
  const res = await _client.chat({ token: _explainToken, question: q })
  const obj = pickAnswer(res, ['explanation', 'rationale'])
  if (!obj) throw new Error('RocketRide explain returned no usable answer')
  return obj
}

export async function explainPath(body) {
  const { path, severity } = body
  const src = path[0], sink = path[path.length - 1]
  try {
    const out = await cached('explain:' + JSON.stringify([path, severity]), async () => {
      try {
        const o = await rocketrideExplain(body)
        if (!o.explanation) throw new Error('no explanation field')
        console.log('[explain:rocketride]', { path: path.join('->') })
        return o
      } catch (err) {
        console.error('[explain:rocketride-miss]', err.message)
        const o = await claudeExplainPath(body)
        console.log('[explain:claude]', { path: path.join('->') })
        return o
      }
    })
    return {
      explanation: out.explanation || fallbackExplanation(body),
      fix: out.fix || `Require a guard before "${sink}".`,
      remediation: out.remediation || fallbackRemediation(sink),
    }
  } catch (err) {
    console.error('[explain:template]', err.message)
    return { explanation: fallbackExplanation(body), fix: `Require human approval before "${sink}" runs on input influenced by "${src}".`, remediation: fallbackRemediation(sink) }
  }
}

export async function explainFix(body) {
  const rf = body.recommendedFix
  try {
    const out = await cached('fix:' + JSON.stringify(rf), async () => {
      try {
        const o = await rocketrideExplain(body)
        if (!o.rationale) throw new Error('no rationale field')
        console.log('[explain-fix:rocketride]', { placement: rf.placement })
        return o
      } catch (err) {
        console.error('[explain-fix:rocketride-miss]', err.message)
        const o = await claudeExplainFix(body)
        console.log('[explain-fix:claude]', { placement: rf.placement })
        return o
      }
    })
    return { rationale: out.rationale || fallbackRationale(rf), remediation: out.remediation || fallbackRemediation(rf.placement) }
  } catch (err) {
    console.error('[explain-fix:template]', err.message)
    return { rationale: fallbackRationale(rf), remediation: fallbackRemediation(rf.placement) }
  }
}

// ---- template fallbacks (tier 3 prose) ----

function fallbackExplanation({ path, severity, graph }) {
  const byId = {}
  for (const n of graph?.nodes || []) byId[n.id] = n
  const src = path[0], sink = path[path.length - 1]
  return `Untrusted data from "${src}" (${byId[src]?.rationale || 'external input'}) flows through the agent's shared context into "${sink}" (${byId[sink]?.rationale || 'privileged action'}) with no guard in between. A prompt injection planted in the "${src}" input can coerce the agent into calling "${sink}", triggering a ${severity}-severity action the user never intended.`
}
function fallbackRationale(rf) {
  return `Placing a ${rf.guard} check at "${rf.placement}" forces explicit approval before the most dangerous action, eliminating ${rf.pathsEliminated} of ${rf.pathsTotal} vulnerable paths with a single guard.`
}
function fallbackRemediation(sink) {
  return `def guard_${sink}(request):\n    if not request.human_approved:\n        raise PermissionError('${sink} requires human approval')\n    return request`
}
