import 'dotenv/config'
import express from 'express'
import { scan, ValidationError } from './scan.js'
import { getDriver } from './db.js'
import { classify, explainPath, explainFix } from './rocketride.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

// CORS: Person C's orchestrator and any static UI may live on other origins.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.post('/scan', async (req, res) => {
  try {
    // The Butterbase orchestrator sends { graph }; direct callers send the bare shape.
    const graph = req.body?.graph ?? req.body
    const results = await scan(graph)
    res.json(results)
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message })
    }
    console.error('[scan:error]', err)
    res.status(500).json({ error: err.message })
  }
})

// RocketRide stage (spec 07): Config -> Graph. LLM-backed with a heuristic
// fallback, so this always returns a valid Graph.
app.post('/classify', async (req, res) => {
  try {
    const config = req.body || {}
    if (!Array.isArray(config.tools) || config.tools.length === 0) {
      return res.status(400).json({ error: "Config must include a non-empty 'tools' array." })
    }
    res.json(await classify(config))
  } catch (err) {
    console.error('[classify:error]', err)
    res.status(500).json({ error: err.message })
  }
})

// RocketRide stage (spec 07): one URL, two request forms. { path, severity,
// graph } explains a vulnerable path; { recommendedFix, graph } justifies the fix.
app.post('/explain', async (req, res) => {
  try {
    const body = req.body || {}
    if (body.recommendedFix) return res.json(await explainFix(body))
    if (!Array.isArray(body.path) || body.path.length === 0) {
      return res.status(400).json({ error: "Body must include 'path' (array) or 'recommendedFix'." })
    }
    res.json(await explainPath(body))
  } catch (err) {
    console.error('[explain:error]', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/health', async (req, res) => {
  try {
    const info = await getDriver().getServerInfo()
    res.json({ ok: true, neo4j: info.address })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// Malformed JSON bodies from express.json() land here, not in the route.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' })
  }
  console.error('[server:error]', err)
  res.status(500).json({ error: err.message })
})

const port = Number(process.env.PORT || 3000)
app.listen(port, () => console.log(`[server] redline engine listening on :${port}`))
