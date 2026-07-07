// Stage-0 gate: prove Aura connectivity before implementing any spec.
import 'dotenv/config'
import neo4j from 'neo4j-driver'

const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env
if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
  console.error('[check] missing NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD in .env')
  process.exit(1)
}

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD))
try {
  const info = await driver.getServerInfo()
  console.log('[check] connected:', info.address, '|', info.agent)
  const session = driver.session()
  const res = await session.run('RETURN 1 AS ok')
  console.log('[check] query ok:', res.records[0].get('ok').toNumber())
  await session.close()
} catch (err) {
  console.error('[check] FAILED:', err.message)
  process.exitCode = 1
} finally {
  await driver.close()
}
