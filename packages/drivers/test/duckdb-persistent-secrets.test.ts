// altimate_change start — preserve ordinary DuckDB secrets without exposing them to scratch helpers
import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { connect } from "../src/duckdb"
import type { Connector } from "../src/types"

const connectors: Connector[] = []
const directories: string[] = []
const originalHome = process.env.HOME

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.close()))
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function callerHome() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "duckdb-secrets-test-"))
  directories.push(directory)
  process.env.HOME = directory
  return directory
}

async function connector(sandboxDirectory?: string) {
  const connection = await connect({ type: "duckdb", path: ":memory:", sandbox_directory: sandboxDirectory })
  connectors.push(connection)
  await connection.connect()
  return connection
}

const secretNames = "SELECT name FROM duckdb_secrets() WHERE persistent ORDER BY name"

describe("DuckDB persistent secrets", () => {
  test("ordinary helpers load caller secrets and persist new secrets across close and timeout", async () => {
    const home = callerHome()
    const secretDirectory = path.join(home, ".duckdb", "stored_secrets")
    const seed = await connector()
    await seed.execute(`SET secret_directory = '${secretDirectory.replace(/'/g, "''")}'`)
    // The built-in HTTP secret type needs neither an extension nor network access.
    await seed.execute("CREATE PERSISTENT SECRET existing_fixture (TYPE http, BEARER_TOKEN 'fixture-only')")
    await seed.close()

    const first = await connector()
    expect((await first.execute(secretNames)).rows).toEqual([["existing_fixture"]])
    expect((await first.execute("SELECT current_setting('secret_directory')")).rows).toEqual([[secretDirectory]])
    await first.execute("CREATE PERSISTENT SECRET new_fixture (TYPE http, BEARER_TOKEN 'fixture-only')")
    expect(fs.readdirSync(secretDirectory).sort()).toEqual([
      "existing_fixture.duckdb_secret",
      "new_fixture.duckdb_secret",
    ])
    await first.close()

    const second = await connector()
    expect((await second.execute(secretNames)).rows).toEqual([["existing_fixture"], ["new_fixture"]])
    await expect(
      second.execute("SELECT count(*) FROM range(100000000000) a, range(1000) b", 1, undefined, {
        queryTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" })
    expect((await second.execute(secretNames)).rows).toEqual([["existing_fixture"], ["new_fixture"]])
  })

  test("scratch helpers keep caller persistent secrets isolated", async () => {
    const home = callerHome()
    const secretDirectory = path.join(home, ".duckdb", "stored_secrets")
    const seed = await connector()
    await seed.execute(`SET secret_directory = '${secretDirectory.replace(/'/g, "''")}'`)
    await seed.execute("CREATE PERSISTENT SECRET caller_fixture (TYPE http, BEARER_TOKEN 'fixture-only')")
    await seed.close()

    const scratch = path.join(home, "scratch")
    fs.mkdirSync(scratch)
    const isolated = await connector(scratch)
    expect((await isolated.execute(secretNames)).rows).toEqual([])
    const result = await isolated.execute(
      "SELECT current_setting('secret_directory'), current_setting('temp_directory')",
    )
    const [secrets, spill] = result.rows[0]
    expect(secrets).toBe(path.join(path.dirname(spill), ".duckdb", "stored_secrets"))
    expect(secrets).not.toBe(secretDirectory)
    expect(fs.readdirSync(secretDirectory)).toEqual(["caller_fixture.duckdb_secret"])
  })
})
// altimate_change end
