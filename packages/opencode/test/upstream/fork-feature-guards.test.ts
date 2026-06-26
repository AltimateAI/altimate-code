import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"

// PRESENCE guards for fork features that hook into upstream-owned files. Every upstream merge
// re-extracts those files (worker.ts, server.ts, serve.ts, the TUI logo, …) and can silently drop a
// fork hook — no compile error, no failing test, because the dropped code needs no markers and the
// existing "absence" tests still pass. These assert each hook is PRESENT so a drop turns into a red
// test on the next merge. The inverse of test/cli/tui/worker-trace-clearing.test.ts (which asserts
// OLD logic is absent). See .github/meta/night-run/RETROSPECTIVE-missed-bugs.md.
//
// These are intentionally string-level source checks: cheap, no creds, CI-friendly, and aimed at one
// failure mode only — a merge silently deleting the hook. If a hook is legitimately renamed/moved,
// update the matching guard (that edit is itself the signal that the hook changed).
const REPO = path.resolve(__dirname, "../../") // packages/opencode
const MONO = path.resolve(__dirname, "../../../") // repo packages root

async function read(rel: string, base = REPO): Promise<string> {
  return fs.readFile(path.join(base, rel), "utf-8")
}

describe("fork feature presence guards (merge drop detection)", () => {
  test("log shim is quiet-by-default and honors --print-logs (TUI flood guard)", async () => {
    const src = await read("src/altimate/util/log.ts")
    // The flood regression was a hard-coded always-on writer.
    expect(src).not.toMatch(/printEnabled\s*=\s*true/)
    // It must gate on the --print-logs env the CLI sets.
    expect(src).toContain("OPENCODE_PRINT_LOGS")
  })

  test("serve wires the trace consumer (serve-mode tracing)", async () => {
    const src = await read("src/cli/cmd/serve.ts")
    expect(src).toContain("subscribeTraceConsumer")
  })

  test("server preserves the v1.17.9 /api HttpApi bridge", async () => {
    // Without this bridge the legacy Hono catch-all proxies /api/* to app.altimate.ai and floods the
    // TUI with connection errors (the bridge is the altimate_change that keeps /api/provider etc local).
    const src = await read("src/server/server.ts")
    expect(src).toContain("httpApiBridge")
  })

  test("server auth default username is opencode (TUI/worker auth)", async () => {
    // The TUI worker authenticates with `opencode:<password>`; a branded default broke authenticated
    // server/TUI calls. Guard the aligned default.
    const src = await read("src/server/auth.ts")
    expect(src).toContain('"opencode"')
  })

  test("TUI wordmark is the Altimate brand wordmark (not opencode)", async () => {
    const src = await read("src/logo.ts", MONO + "/tui")
    // The rebrand marker + Altimate letterforms must survive a merge that ships upstream's wordmark.
    expect(src).toContain("rebrand")
    expect(src).not.toMatch(/\bopen\b.*\bcode\b/i) // not the literal opencode wordmark comment
    // The wordmark is the clean 2-row uppercase ALTIMATE CODE block font (a lowercase variant rendered
    // cramped through the subpixel renderer). The "ALT" start glyphs uniquely identify it — a merge
    // that dropped the rebrand back to opencode's wordmark would not contain them.
    expect(src).toContain("▄▀█ █   ▀█▀") // A L T  — start of "ALTIMATE"
  })

  // The interactive TUI worker must feed bus events to the TraceConsumer AND finalize synchronously on
  // shutdown, or TUI sessions write no traces (the v1.17.9 regression — async fs writes don't flush on
  // the quiet Bun Worker thread). See E2E-TUI-TRACING-REGRESSION.md.
  test("TUI worker wires the trace consumer + sync shutdown finalize", async () => {
    const src = await read("src/cli/tui/worker.ts")
    expect(src).toContain("TraceConsumer")
    expect(src).toContain("handleEvent")
    expect(src).toContain("flushSync") // synchronous finalize on shutdown is the load-bearing part
  })

  // The fff file picker must stay scoped to the active project. Upstream enables filesystem-root +
  // home-dir scanning, which leaks high-frecency files from OTHER repos (e.g. an altimate-backend
  // checkout) into the @-attach suggestions of a project that doesn't contain them. A merge that
  // re-extracts search.ts would silently restore the upstream defaults. See the Altimate Code Issues
  // report (RCA 2).
  test("fff file search is scoped to the project (no home/root scanning leak)", async () => {
    const src = await read("core/src/filesystem/search.ts", MONO)
    expect(src).toContain("enableFsRootScanning: false")
    expect(src).toContain("enableHomeDirScanning: false")
    expect(src).not.toMatch(/enable(FsRoot|HomeDir)Scanning:\s*true/)
  })

  // SYSTEMIC fix for the recurring "library logs corrupt the TUI after a merge" class: the worker
  // redirects its stdout/stderr to the log file. A merge that re-extracts worker.ts could drop the
  // first-import guard, which would silently re-flood the TUI. Assert both the wiring and the redirect.
  test("TUI worker redirects stdout/stderr away from the terminal (console guard)", async () => {
    const worker = await read("src/cli/tui/worker.ts")
    // The guard must be imported FIRST (before any module that could log).
    const firstImport = worker.split("\n").find((l) => l.trim().startsWith("import "))
    expect(firstImport).toContain("worker-console-guard")

    const guard = await read("src/cli/tui/worker-console-guard.ts")
    expect(guard).toContain("process.stdout.write")
    expect(guard).toContain("process.stderr.write")
    // In Bun, console.* bypasses process.stdout/stderr.write, so the guard MUST also override the
    // console methods or raw console.* still corrupts the TUI. Guard against a regression that drops it.
    expect(guard).toContain("console.log")
    expect(guard).toContain("console.error")
    expect(guard).toContain("console.warn")
  })
})
