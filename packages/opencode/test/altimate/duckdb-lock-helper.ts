import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"

/**
 * Hold a DuckDB write lock on `storePath` from a *separate OS process*.
 *
 * It has to be a separate process. DuckDB's file lock is per-process: the same
 * process re-opening a store it already holds succeeds, so an in-process
 * "second open" proves nothing about the path this exercises. Every lock
 * assertion in these suites depends on the lock being genuinely foreign.
 *
 * Measured, and load-bearing for what the driver may claim: a write lock held
 * here is NOT rescued by opening READ_ONLY. `default`, `READ_ONLY` and
 * `read_only` all fail against it. So the read-only *retry* cannot recover a
 * locked store — only an up-front `config.readonly` open lets several processes
 * share a file that nobody has open read-write.
 */
export interface HeldLock {
  release(): Promise<void>
}

// The child takes the lock through the driver itself, by absolute path, rather
// than resolving the `duckdb` package on its own. Resolving `duckdb` from this
// directory works in some layouts and not others — it failed in CI, where the
// package is a dependency of `packages/drivers` and not reachable from here —
// which is the same class of fault this PR exists to fix, so it has no business
// being reintroduced by the test that proves the fix. The specifier below is
// the one both E2E suites already import successfully.
const DRIVER_PATH = fileURLToPath(new URL("../../../drivers/src/duckdb.ts", import.meta.url))

export async function holdWriteLock(storePath: string, scratchDir: string): Promise<HeldLock> {
  const scriptPath = path.join(scratchDir, "hold-duckdb-lock.ts")
  fs.writeFileSync(
    scriptPath,
    [
      `const { connect } = await import(${JSON.stringify(DRIVER_PATH)})`,
      `try {`,
      `  const c = await connect({ type: "duckdb", path: process.argv[2] })`,
      `  await c.connect()`,
      // A real write, so the lock is unambiguously a writer's.
      `  await c.execute("CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)")`,
      `  process.stdout.write("READY\\n")`,
      `} catch (e) {`,
      `  process.stderr.write("HOLD_FAILED " + (e instanceof Error ? e.message : String(e)) + "\\n")`,
      `  process.exit(1)`,
      `}`,
      `setInterval(() => {}, 1 << 30)`,
    ].join("\n"),
    "utf-8",
  )

  const child = Bun.spawn([process.execPath, scriptPath, storePath], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: scratchDir,
  })

  const ready = (async () => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      if (buffered.includes("READY")) {
        reader.releaseLock()
        return
      }
    }
    const err = await new Response(child.stderr).text()
    throw new Error(`lock holder exited without taking the lock: ${err || "(no output)"}`)
  })()

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("lock holder did not report READY within 30s")), 30_000),
  )

  try {
    await Promise.race([ready, timeout])
  } catch (e) {
    child.kill()
    throw e
  }

  return {
    async release() {
      child.kill()
      try {
        await child.exited
      } catch {
        // the process is gone either way
      }
    },
  }
}
