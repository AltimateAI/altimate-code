// altimate_change start — TUI worker console guard (systemic fix for recurring log regressions)
//
// WHY THIS EXISTS / WHY LOG REGRESSIONS KEEP COMING BACK ON EVERY UPSTREAM MERGE:
// The interactive TUI runs the server in a Bun Worker *thread* (cli/tui/worker.ts ->
// Server.Default().fetch). A worker thread shares the process's stdout/stderr file
// descriptors with the main thread, which is where the TUI draws. RPC between the two
// is over postMessage (util/rpc.ts), NOT stdout — so the worker's stdout/stderr carry
// nothing functional, yet ANY in-process write to them corrupts the render:
//   - snowflake-sdk's Winston console transport,
//   - upstream Effect `Logging`,
//   - our own Log shim when --print-logs is on,
//   - and, critically, any dependency or code path a FUTURE upstream merge introduces.
//
// Historically each offender was suppressed one-by-one inside upstream-owned files, so
// every bridge merge that re-extracted those files silently dropped the hook and the TUI
// flooded again. This guard fixes the whole CLASS at the single chokepoint: it redirects
// THIS worker's stdout/stderr to the persistent log file once, before any other module
// runs. New offenders are handled automatically; there is nothing per-offender for a
// merge to drop — only this one guard, which a presence test asserts stays wired
// (test/upstream/fork-feature-guards.test.ts) and an output-hygiene smoke test backstops
// (test/cli/smokes/output-hygiene.test.ts).
//
// Must be imported FIRST in worker.ts so the redirect is installed before anything logs.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { xdgData } from "xdg-basedir"

// Compute the log dir inline (no heavy imports that might log before the redirect is up).
// Mirrors @opencode-ai/core/global Path.log: <xdgData>/opencode/log.
function logFilePath(): string {
  const base = xdgData ?? path.join(os.homedir(), ".local", "share")
  const dir = path.join(base, "opencode", "log")
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `tui-worker-${process.pid}.log`)
}

function install(): void {
  let sink: ((chunk: any) => void) | undefined
  try {
    const stream = fs.createWriteStream(logFilePath(), { flags: "a" })
    stream.on("error", () => {}) // never let a logging stream crash the worker
    ;(stream as { unref?: () => void }).unref?.() // don't keep the worker alive for buffered writes
    sink = (chunk) => stream.write(chunk)
  } catch {
    // If the log file can't be opened, swallow instead — a clean TUI matters more than
    // these incidental lines, and the real log paths (run/serve, the trace files) are
    // unaffected.
    sink = undefined
  }

  const redirect = (chunk: any, encodingOrCb?: unknown, cb?: unknown): boolean => {
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb
    try {
      sink?.(chunk)
    } catch {
      // logging must never throw
    }
    if (typeof callback === "function") {
      try {
        ;(callback as () => void)()
      } catch {}
    }
    return true
  }

  process.stdout.write = redirect as typeof process.stdout.write
  process.stderr.write = redirect as typeof process.stderr.write
}

install()
// altimate_change end
