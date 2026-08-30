import { createRequire } from "node:module"
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

const require_ = createRequire(import.meta.url)

export async function holdWriteLock(storePath: string, scratchDir: string): Promise<HeldLock> {
  // Resolve `duckdb` here rather than in the child: the child's cwd is not
  // guaranteed to sit under the node_modules tree that resolves it, and a
  // resolution failure there would look like "no lock was taken".
  const duckdbEntry = require_.resolve("duckdb")

  const scriptPath = path.join(scratchDir, "hold-duckdb-lock.cjs")
  fs.writeFileSync(
    scriptPath,
    [
      `const duckdb = require(${JSON.stringify(duckdbEntry)})`,
      `const mod = duckdb.default || duckdb`,
      `const db = new mod.Database(process.argv[2], (err) => {`,
      `  if (err) { process.stderr.write("HOLD_FAILED " + (err.message || err) + "\\n"); process.exit(1) }`,
      // Take a real write so the lock is unambiguously a writer's.
      `  db.run("CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)", (e) => {`,
      `    if (e) { process.stderr.write("HOLD_FAILED " + (e.message || e) + "\\n"); process.exit(1) }`,
      `    process.stdout.write("READY\\n")`,
      `  })`,
      `})`,
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
