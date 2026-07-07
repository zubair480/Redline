// Spec 06: run scan() on all fixtures plus a classifier-style graph, assert
// the exact Results per spec 01 rulings. npm test runs this.
import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getDriver, close } from '../src/engine/db.js'
import { scan, ValidationError } from '../src/engine/scan.js'

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)))
const show = (label, results) => console.log(`\n=== ${label} ===\n` + JSON.stringify(results, null, 2))

try {
  // 1. support-agent: 4 unguarded paths, fix on issue_refund
  const support = await scan(load('support-agent'))
  show('support-agent', support)
  assert.deepEqual(support.summary, { sources: 2, sinks: 2, guards: 0, vulnerablePaths: 4 })
  assert.equal(support.vulnerablePaths.length, 4)
  assert.ok(support.vulnerablePaths.every((p) => p.severity === 'critical'))
  assert.ok(support.vulnerablePaths.every((p) => p.explanation === ''))
  assert.ok(
    support.vulnerablePaths.some((p) => JSON.stringify(p.path) === JSON.stringify(['read_email', 'context', 'issue_refund'])),
    'contains read_email -> context -> issue_refund'
  )
  assert.deepEqual(support.recommendedFix, {
    guard: 'human_approval', placement: 'issue_refund', pathsEliminated: 2, pathsTotal: 4, rationale: '',
  })

  // 2. guarded-agent: guard hand-wired in edges, only send_email reachable
  const guarded = await scan(load('guarded-agent'))
  show('guarded-agent', guarded)
  assert.deepEqual(guarded.summary, { sources: 2, sinks: 2, guards: 1, vulnerablePaths: 2 })
  assert.ok(guarded.vulnerablePaths.every((p) => p.path.at(-1) === 'send_email'))
  assert.ok(guarded.vulnerablePaths.every((p) => !p.path.includes('human_approval')))
  assert.deepEqual(guarded.recommendedFix, {
    guard: 'human_approval', placement: 'send_email', pathsEliminated: 2, pathsTotal: 2, rationale: '',
  })

  // 3. clean-agent: zero paths, null recommendedFix (spec 01 ruling 2)
  const clean = await scan(load('clean-agent'))
  show('clean-agent', clean)
  assert.deepEqual(clean.summary, { sources: 1, sinks: 2, guards: 1, vulnerablePaths: 0 })
  assert.deepEqual(clean.vulnerablePaths, [])
  assert.equal(clean.recommendedFix, null)

  // 4. classifier-style graph: full mesh, guard supplied as data with a
  // placement, exactly as Person C's mock classifier emits after apply-fix.
  const classifierStyle = {
    nodes: load('support-agent').nodes,
    edges: load('support-agent').edges,
    guards: [{ name: 'human_approval', placement: 'issue_refund' }],
  }
  const rewired = await scan(classifierStyle)
  show('classifier-style (guard as data)', rewired)
  assert.deepEqual(rewired.summary, { sources: 2, sinks: 2, guards: 1, vulnerablePaths: 2 })
  assert.ok(rewired.vulnerablePaths.every((p) => p.path.at(-1) === 'send_email'), 'issue_refund paths eliminated by rewiring')
  assert.equal(rewired.recommendedFix.placement, 'send_email')

  // 5. wildcard guard covers everything
  const wildcard = await scan({ ...classifierStyle, guards: ['human_approval'] })
  show('wildcard guard', wildcard)
  assert.equal(wildcard.summary.vulnerablePaths, 0)
  assert.equal(wildcard.recommendedFix, null)

  // 6. validation rejects garbage without touching the DB
  await assert.rejects(() => scan({ nodes: 'nope' }), ValidationError)
  await assert.rejects(() => scan({ nodes: [{ id: 'x', role: 'wizard' }] }), ValidationError)

  // 7. cleanup: no scan namespaces left behind
  const session = getDriver().session()
  const count = (await session.run('MATCH (n) RETURN count(n) AS c')).records[0].get('c').toNumber()
  await session.close()
  assert.equal(count, 0, 'database empty after all scans')

  console.log('\n[test] all spec 06 assertions passed')
} finally {
  await close()
}
