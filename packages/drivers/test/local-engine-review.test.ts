import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { connect as connectDuckdb } from "../src/duckdb"
import { connect as connectSqlite } from "../src/sqlite"
import { LocalEngine, buildHelperEnv } from "../src/local-engine"
import { pack, unpack } from "../src/local-engine-codec"
import { LOCAL_ENGINE_CHILD_SOURCE } from "../src/local-engine-child-source"
import type { Connector } from "../src/types"

const dirs: string[] = []
const connections: Connector[] = []
afterEach(async () => {
  while (connections.length) await connections.pop()!.close()
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe("helper environment compatibility", () => {
  test("uppercase MotherDuck and both proxy cases pass through with HOME isolated", () => {
    const forwarded = {
      MOTHERDUCK_TOKEN: "test-uppercase-motherduck",
      HTTP_PROXY: "http://uppercase-http.invalid:8080",
      HTTPS_PROXY: "http://uppercase-https.invalid:8080",
      NO_PROXY: "uppercase.invalid",
      http_proxy: "http://lowercase-http.invalid:8080",
      https_proxy: "http://lowercase-https.invalid:8080",
      no_proxy: "lowercase.invalid",
    }
    const env = buildHelperEnv("/private/helper", { ...forwarded, HOME: "/caller/home" })
    expect(env).toMatchObject({ ...forwarded, HOME: "/private/helper" })
  })

  test("DuckDB inherits TZ for current_setting('TimeZone')", async () => {
    const previous = process.env.TZ
    process.env.TZ = "Asia/Kolkata"
    try {
      const connector = await connection("duckdb")
      await connector.connect()
      const result = await connector.execute("SELECT current_setting('TimeZone')")
      expect(result.rows).toEqual([["Asia/Kolkata"]])
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  test("DuckDB uses the caller's persistent extension directory", async () => {
    const dir = projectDir()
    const previous = process.env.HOME
    process.env.HOME = dir
    try {
      const connector = await connection("duckdb")
      await connector.connect()
      const result = await connector.execute("SELECT current_setting('extension_directory')")
      expect(result.rows).toEqual([[path.join(dir, ".duckdb", "extensions")]])
    } finally {
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
    }
  })

  test("only documented database environment variables accompany the isolated runtime", () => {
    const env = buildHelperEnv("/private/helper", {
      PATH: "/usr/bin",
      HOME: "/caller/home",
      TZ: "Asia/Kolkata",
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
      AWS_SESSION_TOKEN: "test-session",
      AWS_PROFILE: "test-profile",
      AWS_REGION: "us-east-1",
      GOOGLE_APPLICATION_CREDENTIALS: "/caller/test-credentials.json",
      motherduck_token: "test-motherduck",
      OPENAI_API_KEY: "test-provider-secret",
      ANTHROPIC_API_KEY: "test-provider-secret",
      BUN_OPTIONS: "--preload=untrusted.js",
    })
    expect(env.TZ).toBe("Asia/Kolkata")
    expect(env.AWS_ACCESS_KEY_ID).toBe("test-access")
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("test-secret")
    expect(env.AWS_SESSION_TOKEN).toBe("test-session")
    expect(env.AWS_PROFILE).toBe("test-profile")
    expect(env.AWS_REGION).toBe("us-east-1")
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/caller/test-credentials.json")
    expect(env.motherduck_token).toBe("test-motherduck")
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.BUN_OPTIONS).toBeUndefined()
    expect(env.HOME).toBe("/private/helper")
  })
})

describe("helper returned value compatibility", () => {
  test("DuckDB STRUCT values support String() formatting", async () => {
    const connector = await connection("duckdb")
    await connector.connect()
    const result = await connector.execute("SELECT {'a':1,'b':[1,2]} AS s")
    const value = result.rows[0]![0]
    expect(String(value)).toBe("[object Object]")
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(value).toEqual({ a: 1, b: [1, 2] })
  })

  test.each(["sqlite", "duckdb"] as const)("%s BLOB results are Buffers", async (engine) => {
    const connector = await connection(engine)
    await connector.connect()
    const result = await connector.execute(engine === "sqlite" ? "SELECT X'6162' AS b" : "SELECT 'ab'::BLOB AS b")
    const value = result.rows[0]![0]
    expect(Buffer.isBuffer(value)).toBe(true)
    expect(value.toString()).toBe("ab")
  })

  test("both codecs preserve plain objects and own __proto__ without modifying prototypes", () => {
    const childCodec = new Function(LOCAL_ENGINE_CHILD_SOURCE.split("// ---- orphan watchdog ----")[0] + "; return { pack, unpack }")() as {
      pack: typeof pack
      unpack: typeof unpack
    }
    for (const codec of [{ pack, unpack }, childCodec]) {
      const value = JSON.parse('{"__proto__":{"polluted":true},"nested":{"$t":"obj","v":"user-value"}}')
      const result = codec.unpack(JSON.parse(JSON.stringify(codec.pack(value))))
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(result.nested)).toBe(Object.prototype)
      expect(Object.hasOwn(result, "__proto__")).toBe(true)
      expect(result.__proto__).toEqual({ polluted: true })
      expect(result.polluted).toBeUndefined()
      expect(result.nested).toEqual(value.nested)
      expect(Buffer.isBuffer(codec.unpack(codec.pack(Buffer.from("ab"))))).toBe(true)
    }
  })
})

describe("helper close cancellation", () => {
  test("idle DuckDB close allows a checkpoint callback more than 500 ms to finish", async () => {
    const dir = projectDir()
    const sentinel = path.join(dir, "checkpoint-complete")
    const modulePath = path.join(dir, "delayed-duckdb.mjs")
    fs.writeFileSync(modulePath, `import * as fs from "fs";
export default {
  Database: class {
    constructor(path, options, callback) { callback(null); }
    connect() { return {}; }
    close(callback) {
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(sentinel)}, "complete");
        callback(null);
      }, 800);
    }
  }
};
`)
    const engine = new LocalEngine({ engine: "duckdb", label: "DuckDB", storePath: ":memory:" })
    try {
      await engine.open({ path: ":memory:", modulePath }, 1000)
      await engine.close()
      expect(fs.existsSync(sentinel)).toBe(true)
    } finally {
      await engine.close()
    }
  })

  test.each(["sqlite", "duckdb"] as const)("%s close interrupts a running query instead of waiting in its queue", async (engine) => {
    const connector = await connection(engine)
    await connector.connect()
    const sql = engine === "sqlite"
      ? "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 4000000000) SELECT count(*) AS n FROM c"
      : "SELECT count(*) AS n FROM range(100000000000) a, range(1000) b"
    // The finite query deadline keeps cleanup bounded even with the original broken close().
    const running = connector.execute(sql, 1, undefined, { queryTimeoutMs: 2500 }).then(
      () => undefined,
      (error) => error,
    )
    await Bun.sleep(50)
    const queued = connector.execute("SELECT 7").then(
      () => undefined,
      (error) => error,
    )
    const started = performance.now()
    await connector.close()
    expect(performance.now() - started).toBeLessThan(1200)
    expect((await running)?.message).toContain("closed")
    expect((await queued)?.message).toContain("not open")
    await expect(connector.execute("SELECT 1")).rejects.toThrow("not open")
    await connector.connect()
    expect(Number((await connector.execute("SELECT 9")).rows[0]![0])).toBe(9)
  })
})

function projectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-engine-review-"))
  dirs.push(dir)
  return dir
}

async function connection(engine: "sqlite" | "duckdb", options: Record<string, unknown> = {}) {
  const connect = engine === "sqlite" ? connectSqlite : connectDuckdb
  const connector = await connect({ type: engine, path: ":memory:", create: true, ...options })
  connections.push(connector)
  return connector
}

describe("helper caller working directory", () => {
  test("DuckDB connections use separate spill directories inside the private helper directory", async () => {
    const dir = projectDir()
    const previous = process.cwd()
    const connectors: Connector[] = []
    try {
      process.chdir(dir)
      connectors.push(await connection("duckdb"), await connection("duckdb"))
    } finally {
      process.chdir(previous)
    }
    const spillDirectories: string[] = []
    for (const connector of connectors) {
      await connector.connect()
      await connector.execute("SET memory_limit = '16MB'")
      const result = await connector.execute("SELECT current_setting('temp_directory')")
      const spillDirectory = result.rows[0]![0] as string
      expect(path.isAbsolute(spillDirectory)).toBe(true)
      expect(path.basename(spillDirectory)).toMatch(/^duckdb-\d+$/)
      const helperDirectory = path.dirname(spillDirectory)
      expect(path.basename(helperDirectory)).toMatch(/^altimate-local-engine-/)
      expect(fs.realpathSync(path.dirname(helperDirectory))).toBe(fs.realpathSync(os.tmpdir()))
      if (process.platform !== "win32") expect(fs.statSync(helperDirectory).mode & 0o777).toBe(0o700)
      spillDirectories.push(spillDirectory)
    }
    expect(new Set(spillDirectories).size).toBe(connectors.length)
    expect(fs.existsSync(path.join(dir, ".tmp"))).toBe(false)
  })

  test.each(["sqlite", "duckdb"] as const)("%s guards and opens a relative store against the connector's cwd", async (engine) => {
    const dir = projectDir()
    const seed = await connection(engine, { path: path.join(dir, "store.db") })
    await seed.connect()
    await seed.execute("CREATE TABLE kept (value INTEGER)")
    await seed.execute("INSERT INTO kept VALUES (7)")
    await seed.close()
    const previous = process.cwd()
    let connector: Connector
    try {
      process.chdir(dir)
      connector = await connection(engine, { path: "store.db", readonly: true, create: false })
    } finally {
      process.chdir(previous)
    }
    await connector!.connect()
    expect((await connector!.execute("SELECT value FROM kept")).rows).toEqual([[7]])
  })

  test("caller cwd does not load project Bun preloads or .env files", async () => {
    const dir = projectDir()
    const sentinel = path.join(dir, "PRELOAD_RAN")
    fs.writeFileSync(path.join(dir, "pre.ts"), `require("fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`)
    fs.writeFileSync(path.join(dir, "bunfig.toml"), 'preload = ["./pre.ts"]\n')
    fs.writeFileSync(path.join(dir, ".env"), "ALTIMATE_TEST_DOTENV=from-project\n")
    const engine = new LocalEngine({
      engine: "sqlite", label: "SQLite", storePath: ":memory:", cwd: dir,
      childSource: `let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const result = request.op === "all" ? [{ cwd: process.cwd(), dotenv: process.env.ALTIMATE_TEST_DOTENV ?? null }] : null;
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\\n");
  }
}`,
    })
    try {
      await engine.open({ path: ":memory:" }, 1000)
      const rows = await engine.call("all", { sql: "probe" }, 1000)
      expect(fs.realpathSync(rows[0].cwd)).toBe(fs.realpathSync(dir))
      expect(rows[0].dotenv).toBeNull()
      expect(fs.existsSync(sentinel)).toBe(false)
    } finally {
      await engine.close()
    }
  })

  test("DuckDB resolves relative read_csv_auto against the connector's cwd", async () => {
    const dir = projectDir()
    fs.writeFileSync(path.join(dir, "data.csv"), "id,name\n1,Ada\n")
    const previous = process.cwd()
    let connector: Connector
    try {
      process.chdir(dir)
      connector = await connection("duckdb")
    } finally {
      process.chdir(previous)
    }
    await connector!.connect()
    const result = await connector!.execute("SELECT name FROM read_csv_auto('data.csv')")
    expect(result.rows).toEqual([["Ada"]])
  })

  test.each(["sqlite", "duckdb"] as const)("%s ATTACH creates a persistent file in the connector's cwd", async (engine) => {
    const dir = projectDir()
    const previous = process.cwd()
    let connector: Connector
    try {
      process.chdir(dir)
      connector = await connection(engine)
    } finally {
      process.chdir(previous)
    }
    await connector!.connect()
    await connector!.execute(`ATTACH '${engine}-other.db' AS other`)
    await connector!.execute("CREATE TABLE other.kept (value INTEGER)")
    await connector!.close()
    expect(fs.existsSync(path.join(dir, `${engine}-other.db`))).toBe(true)
  })
})

test("helper retains default AWS profile paths while isolating its home", () => {
  const env = buildHelperEnv("/private/helper", { HOME: "/caller/home", AWS_PROFILE: "analytics" })
  expect(env.HOME).toBe("/private/helper")
  expect(env.AWS_PROFILE).toBe("analytics")
  expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/caller/home/.aws/credentials")
  expect(env.AWS_CONFIG_FILE).toBe("/caller/home/.aws/config")
  const explicit = buildHelperEnv("/private/helper", {
    USERPROFILE: "/caller/windows",
    AWS_SHARED_CREDENTIALS_FILE: "/custom/credentials",
    AWS_CONFIG_FILE: "/custom/config",
  })
  expect(explicit.AWS_SHARED_CREDENTIALS_FILE).toBe("/custom/credentials")
  expect(explicit.AWS_CONFIG_FILE).toBe("/custom/config")
  expect(buildHelperEnv("/private/helper", { USERPROFILE: "/caller/windows" }).AWS_CONFIG_FILE).toBe(
    "/caller/windows/.aws/config",
  )
})
