// Acceptance checks for spec 04 (vulnerable-path and best-fix queries).
import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { close } from '../src/engine/db.js'
import { ingestGraph, deleteScan } from '../src/engine/ingest.js'
import { findVulnerablePaths, findBestFix } from '../src/engine/queries.js'

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)))
const SCANS = { support: 'vq-support', guarded: 'vq-guarded', clean: 'vq-clean' }

try {
  await ingestGraph(load('support-agent'), SCANS.support)
  await ingestGraph(load('guarded-agent'), SCANS.guarded)
  await ingestGraph(load('clean-agent'), SCANS.clean)

  // support-agent: exactly 4 paths, all critical, stable ids
  const support = await findVulnerablePaths(SCANS.support)
  assert.equal(support.length, 4, 'support path count')
  assert.ok(
    support.some((p) => JSON.stringify(p.path) === JSON.stringify(['read_email', 'context', 'issue_refund'])),
    'contains read_email -> context -> issue_refund'
  )
  assert.ok(support.every((p) => p.severity === 'critical'), 'all critical')
  assert.deepEqual(support.map((p) => p.id), ['p1', 'p2', 'p3', 'p4'], 'ids p1..p4')
  assert.ok(support.every((p) => p.explanation === ''), 'explanations empty')

  const supportAgain = await findVulnerablePaths(SCANS.support)
  assert.deepEqual(supportAgain, support, 'deterministic across repeated runs')

  // support-agent best fix: alphabetical tie-break picks issue_refund
  const supportFix = await findBestFix(SCANS.support, support.length)
  assert.deepEqual(
    supportFix,
    { guard: 'human_approval', placement: 'issue_refund', pathsEliminated: 2, pathsTotal: 4, rationale: '' },
    'support best fix'
  )

  // guarded-agent: 2 paths, both into send_email, none through the guard
  const guarded = await findVulnerablePaths(SCANS.guarded)
  assert.equal(guarded.length, 2, 'guarded path count')
  assert.ok(guarded.every((p) => p.path.at(-1) === 'send_email'), 'both end in send_email')
  assert.ok(guarded.every((p) => !p.path.includes('human_approval')), 'no path contains the guard')
  assert.ok(guarded.every((p) => p.path.at(-1) !== 'issue_refund'), 'nothing reaches issue_refund')
  const guardedFix = await findBestFix(SCANS.guarded, guarded.length)
  assert.deepEqual(
    guardedFix,
    { guard: 'human_approval', placement: 'send_email', pathsEliminated: 2, pathsTotal: 2, rationale: '' },
    'guarded best fix'
  )

  // clean-agent: zero paths, null-placement fix
  const clean = await findVulnerablePaths(SCANS.clean)
  assert.equal(clean.length, 0, 'clean path count')
  const cleanFix = await findBestFix(SCANS.clean, 0)
  assert.equal(cleanFix, null, 'clean fix is null (spec 01 ruling 2)')

  console.log('[verify] all spec 04 acceptance criteria passed')
} finally {
  await deleteScan(SCANS.support)
  await deleteScan(SCANS.guarded)
  await deleteScan(SCANS.clean)
  await close()
}
