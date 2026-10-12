import { Database } from "bun:sqlite"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

export const SLOW_SQL =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 4000000000) SELECT count(*) AS n FROM c"

export interface Fixtures {
  sensors: string
  readings: string
  wide?: string
  wideSkip?: string
  expectedAverage: number
  northReadings: number
  slowSql: string
}

/** Seeded integer arithmetic keeps both the data and the independent oracle repeatable. */
export async function createFixtures(dir: string): Promise<Fixtures> {
  mkdirSync(dir, { recursive: true })
  const sensors = path.resolve(dir, "sensors.db")
  const readings = path.resolve(dir, "readings.db")
  for (const file of [sensors, readings, path.resolve(dir, "wide.duckdb")]) {
    if (existsSync(file)) throw new Error(`Refusing to overwrite existing fixture: ${file}`)
  }

  const regions = ["north", "south", "east", "west"]
  const sensorDb = new Database(sensors, { create: true })
  try {
    sensorDb.exec("CREATE TABLE sensor(sensor_id TEXT, region TEXT)")
    const insert = sensorDb.prepare("INSERT INTO sensor VALUES (?, ?)")
    sensorDb.transaction(() => {
      for (let i = 1; i <= 300; i++) insert.run(`S-${String(i).padStart(3, "0")}`, regions[(i - 1) % 4]!)
    })()
  } finally {
    sensorDb.close()
  }

  let seed = 0x51a7c0de
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const readingDb = new Database(readings, { create: true })
  try {
    readingDb.exec("CREATE TABLE reading(sid TEXT, temp REAL)")
    const insert = readingDb.prepare("INSERT INTO reading VALUES (?, ?)")
    readingDb.transaction(() => {
      for (let i = 0; i < 200_000; i++) {
        const sensor = (i % 300) + 1
        const cents = (next() % 6001) - 1000
        insert.run(`s${String(sensor).padStart(3, "0")}`, cents / 100)
      }
    })()
  } finally {
    readingDb.close()
  }

  // Read the persisted files, normalize keys in code, and sum integer cents. The
  // oracle does not share a SQL join or aggregation with the analyst's answer.
  const normalize = (id: string) => id.toLowerCase().replaceAll("-", "")
  const north = new Set<string>()
  const savedSensors = new Database(sensors, { readonly: true })
  try {
    for (const row of savedSensors.query<{ sensor_id: string; region: string }, []>("SELECT * FROM sensor").iterate()) {
      if (row.region === "north") north.add(normalize(row.sensor_id))
    }
  } finally {
    savedSensors.close()
  }
  let northReadings = 0
  let northCents = 0
  const savedReadings = new Database(readings, { readonly: true })
  try {
    for (const row of savedReadings.query<{ sid: string; temp: number }, []>("SELECT * FROM reading").iterate()) {
      if (!north.has(normalize(row.sid))) continue
      northReadings++
      northCents += Math.round(row.temp * 100)
    }
  } finally {
    savedReadings.close()
  }

  const result: Fixtures = {
    sensors,
    readings,
    expectedAverage: northCents / northReadings / 100,
    northReadings,
    slowSql: SLOW_SQL,
  }
  // Resolve from the dev driver's package, never a globally installed CLI.
  const requireDriver = createRequire(new URL("../../../drivers/package.json", import.meta.url))
  let duckdb: any
  try {
    duckdb = requireDriver(requireDriver.resolve("duckdb"))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const message = error instanceof Error ? error.message : String(error)
    if (
      code === "MODULE_NOT_FOUND" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "ERR_DLOPEN_FAILED" ||
      /Could not locate the bindings file|dlopen\(|invalid ELF|incompatible architecture/i.test(message)
    ) {
      result.wideSkip = `DuckDB dev package/native binding unavailable: ${message}`
      return result
    }
    throw error
  }

  const wide = path.resolve(dir, "wide.duckdb")
  let wideDb: any
  try {
    await new Promise<void>((resolve, reject) => {
      wideDb = new duckdb.Database(wide, (error: Error | null) => (error ? reject(error) : resolve()))
    })
    const run = (sql: string, ...values: unknown[]) =>
      new Promise<void>((resolve, reject) => {
        wideDb.run(sql, ...values, (error: Error | null) => (error ? reject(error) : resolve()))
      })
    await run("CREATE TABLE wide(payload TEXT)")
    await run("INSERT INTO wide VALUES (?)", "w".repeat(100 * 1024))
  } finally {
    if (wideDb) {
      await new Promise<void>((resolve, reject) => {
        wideDb.close((error: Error | null) => (error ? reject(error) : resolve()))
      })
    }
  }
  result.wide = wide
  return result
}

/** Prove the exact SQL is still running after two minutes without a deadline. */
export async function verifySlowQuery(directory: string): Promise<{ verifiedMs: number; log: string }> {
  mkdirSync(directory, { recursive: true })
  const log = path.resolve(directory, "slow-query-baseline.log")
  const python = [
    "import sqlite3, sys, time",
    "connection = sqlite3.connect(':memory:')",
    "print('READY', flush=True)",
    "started = time.monotonic()",
    "result = connection.execute(sys.argv[1]).fetchone()",
    "print('FINISHED', time.monotonic() - started, result, flush=True)",
    "connection.close()",
  ].join("\n")
  const child = spawn("python3", ["-I", "-c", python, SLOW_SQL], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let ended = false
  let readyAt = 0
  let verifiedMs = 0
  let failure: unknown
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      ended = true
      rejectReady(error)
      resolve()
    })
    child.once("exit", () => {
      ended = true
      rejectReady(new Error("Slow-query baseline exited before readiness"))
      resolve()
    })
  })
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
    if (!readyAt && output.includes("READY\n")) {
      readyAt = performance.now()
      resolveReady()
    }
  })
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
  async function finishesWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  let readinessTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        readinessTimer = setTimeout(() => reject(new Error("Slow-query baseline did not become ready in 10s")), 10_000)
      }),
    ])
    clearTimeout(readinessTimer)
    if (await finishesWithin(121_000)) throw new Error("Slow-query fixture finished within two minutes")
    verifiedMs = performance.now() - readyAt
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(readinessTimer)
    if (!ended) {
      child.kill("SIGTERM")
      if (!(await finishesWithin(2_000))) {
        child.kill("SIGKILL")
        if (!(await finishesWithin(2_000)))
          failure = new Error("Slow-query baseline process did not exit after SIGKILL")
      }
    }
    output += `\nVerified running for ${verifiedMs}ms; exit=${child.exitCode}; signal=${child.signalCode}\n`
    if (failure) output += `ERROR: ${String(failure)}\n`
    writeFileSync(log, output)
    writeFileSync(
      path.resolve(directory, "slow-query-baseline.json"),
      JSON.stringify(
        { sql: SLOW_SQL, verifiedMs, exited: ended, exitCode: child.exitCode, signal: child.signalCode, log },
        null,
        2,
      ),
    )
  }
  if (failure) throw new Error(`${String(failure)}; log: ${log}`)
  return { verifiedMs, log }
}
