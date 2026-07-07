import neo4j from 'neo4j-driver'

let driver = null

export function getDriver() {
  if (!driver) {
    const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env
    if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
      throw new Error('Missing NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD in environment')
    }
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD))
  }
  return driver
}

export async function close() {
  if (driver) {
    await driver.close()
    driver = null
  }
}
