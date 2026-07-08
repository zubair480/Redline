// Pre-warm the RocketRide LLM cache before a demo.
//
// The engine caches /classify and /explain by exact input, so the first scan of
// each config is ~15-20s (cold LLM calls) and every scan after is sub-second.
// This walks each demo preset through the same stages the orchestrator does —
// classify -> scan -> explain each vulnerable path -> explain the fix — so the
// cache is fully populated and every on-stage scan (and apply-fix) is instant.
//
// Usage:
//   node scripts/prewarm.js                       # warms http://localhost:3000
//   node scripts/prewarm.js <base-url>            # e.g. the tunnel URL
//   PREWARM_BASE=https://<tunnel> node scripts/prewarm.js
//
// The cache lives in the engine process, so localhost and the tunnel warm the
// same store — localhost is fastest. Run it while the engine is up.

const BASE = (process.argv[2] || process.env.PREWARM_BASE || 'http://localhost:3000').replace(/\/$/, '')

// The three demo presets (kept in sync with frontend/src/data.ts).
const PRESETS = [
  {
    name: 'Customer Support Agent (Refund Sink)',
    config: {
      agent: 'customer-support-agent',
      tools: [
        { name: 'read_email', description: 'Read incoming customer emails' },
        { name: 'fetch_url', description: 'Fetch content from a customer-provided URL' },
        { name: 'search_orders', description: 'Look up internal order history' },
        { name: 'issue_refund', description: 'Issue a refund to a payment method' },
        { name: 'send_email', description: 'Send a reply email' },
      ],
      guards: [],
    },
  },
  {
    name: 'Slack Copilot (SQL Sink)',
    config: {
      agent: 'slack-copilot',
      tools: [
        { name: 'listen_mentions', description: 'Read incoming Slack mentions from any channel member' },
        { name: 'fetch_link', description: 'Fetch and summarize an external URL shared in chat' },
        { name: 'run_sql', description: 'Execute a SQL query against the internal production database' },
        { name: 'post_message', description: 'Send a message back to the Slack channel' },
      ],
      guards: [],
    },
  },
  {
    name: 'CI/CD Deploy Bot (RCE)',
    config: {
      agent: 'cicd-deploy-agent',
      tools: [
        { name: 'read_pr_comment', description: 'Read comments posted on a pull request by any external GitHub user' },
        { name: 'fetch_build_log', description: 'Fetch a build log from a contributor-supplied CI URL' },
        { name: 'run_shell', description: 'Execute an arbitrary shell command on the deploy runner' },
        { name: 'deploy_production', description: 'Deploy the current build to the production Kubernetes cluster' },
      ],
      guards: [],
    },
  },
  {
    name: 'Fintech Treasury (Partial Guard)',
    config: {
      agent: 'treasury-ops-agent',
      tools: [
        { name: 'read_invoice_email', description: 'Read incoming vendor invoice emails from an external inbox' },
        { name: 'wire_transfer', description: 'Send a wire transfer to a supplier bank account' },
        { name: 'email_vendor', description: 'Send an email to an external vendor address' },
      ],
      guards: [{ guard: 'human_approval', placement: 'wire_transfer' }],
    },
  },
  {
    name: 'Healthcare Intake (Guarded)',
    config: {
      agent: 'patient-intake-agent',
      tools: [
        { name: 'read_patient_message', description: 'Read an incoming patient message from the portal' },
        { name: 'lookup_record', description: 'Look up an internal patient record by id' },
        { name: 'send_prescription', description: 'Submit a prescription order to the pharmacy system' },
        { name: 'clinician_review', description: 'Require a licensed clinician to review and approve before any prescription is submitted' },
      ],
      guards: ['clinician_review'],
    },
  },
  {
    name: 'Shopify Bot (Guarded)',
    config: {
      agent: 'shopify-fulfillment-bot',
      tools: [
        { name: 'receive_webhook', description: 'Receive an incoming order webhook from an untrusted external source' },
        { name: 'lookup_inventory', description: 'Check internal inventory levels' },
        { name: 'fulfill_order', description: 'Charge the customer and ship the order via the Shopify API' },
        { name: 'human_approval', description: 'Require a human to approve the action before it runs' },
      ],
      guards: ['human_approval'],
    },
  },
]

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

async function warmPreset(preset) {
  const t0 = Date.now()
  // 1) classify: Config -> Graph (warms the classify cache for this config)
  const graph = await post('/classify', preset.config)
  // 2) scan: Graph -> Results (Neo4j, not cached — gives the exact paths/fix)
  const results = await post('/scan', { graph })
  const paths = results.vulnerablePaths || []
  // 3) explain each vulnerable path (warms per-path narratives; the 2 paths that
  //    survive apply-fix share these same cache keys, so apply-fix is warm too)
  for (const vp of paths) {
    await post('/explain', { path: vp.path, severity: vp.severity, graph })
  }
  // 4) explain the recommended fix (warms the headline rationale)
  if (results.recommendedFix) {
    await post('/explain', { recommendedFix: results.recommendedFix, graph })
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  return { paths: paths.length, fix: !!results.recommendedFix, secs }
}

async function main() {
  console.log(`Pre-warming RocketRide cache via ${BASE}\n`)
  // Confirm the engine is reachable before doing real work.
  try {
    const h = await fetch(`${BASE}/health`).then((r) => r.json())
    if (!h.ok) throw new Error('health not ok')
  } catch (err) {
    console.error(`Engine not reachable at ${BASE} (${err.message}). Start it with 'npm start'.`)
    process.exit(1)
  }

  let failed = 0
  for (const preset of PRESETS) {
    process.stdout.write(`  ${preset.name} ... `)
    try {
      const r = await warmPreset(preset)
      console.log(`OK (${r.paths} path${r.paths === 1 ? '' : 's'}${r.fix ? ' + fix' : ''}, ${r.secs}s)`)
    } catch (err) {
      failed += 1
      console.log(`FAILED: ${err.message}`)
    }
  }

  console.log(failed === 0
    ? '\nAll presets warm. Demo scans will be sub-second.'
    : `\n${failed} preset(s) failed — check the engine and RocketRide env.`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
