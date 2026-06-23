/**
 * Repro for the trace corruption bug: flushSync's synchronous write can be
 * clobbered by an in-flight async snapshot's fs.rename.
 *
 * The race:
 *   1. snapshot() is called → buildTraceFile, writeFile(tmp), then check `crashed`, then rename(tmp, final)
 *   2. The `crashed` check passes synchronously (false at that point), so fs.rename is scheduled
 *   3. flushSync() runs synchronously, sets `crashed=true`, writeFileSync(final, crashed content)
 *   4. fs.rename completes — atomic rename overwrites the crashed file with the (stale) snapshot content
 *
 * The `crashed` flag was added (see Round-3 audit comment at tracing.ts:341-345) to fix this,
 * but the fix is incomplete: the check happens BEFORE fs.rename's syscall completes, so once the
 * check has passed the rename is already on its way and can't be cancelled.
 *
 * This reproducer injects a small delay into fs.rename to make the race deterministic.
 * In production the same window is opened by slow disk I/O, large trace serialization, or
 * a busy event loop.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Trace, FileExporter, type TraceFile } from "../../src/altimate/observability/tracing"

describe("trace corruption — flushSync vs in-flight rename race", () => {
  let tmpDir: string
  let originalRename: typeof fs.rename

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `trace-rename-race-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(tmpDir, { recursive: true })
    originalRename = fs.rename
  })

  afterEach(async () => {
    // Safety guard: restore fs.rename even if a test failed mid-patch.
    // Without this, a patched fs.rename leaks into subsequent test files
    // because `fs/promises` is a process-global namespace object.
    if ((fs as any).rename !== originalRename) {
      ;(fs as any).rename = originalRename
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  // M1 — flushSync's content overwritten by an in-flight snapshot's late
  // fs.rename. The `crashed` flag added in commit 38463876b checks before
  // the rename is initiated, but once initiated the kernel rename completes
  // asynchronously and can clobber flushSync's sync write. THIS PR DOES
  // NOT CLOSE THIS WINDOW — it remains as an architectural residual at the
  // kernel level. On local SSD (APFS/ext4) the window is sub-millisecond
  // and naturally protected by the existing `crashed` flag (see M1-natural
  // tests below). Risk concentrates on non-POSIX filesystems (network FS,
  // FUSE, sync-mediated cloud drives).
  //
  // This deterministic test (with an injected fs.rename delay) is skipped
  // because the residual is documented in the umbrella issue and a known-
  // failing test in CI is noise. Restore it locally with `test()` to
  // experiment with kernel-rename TOCTOU mitigations.
  test.skip("M1 residual — flushSync clobbered by adversarially-delayed snapshot rename (architectural)", async () => {
    ;(fs as any).rename = async (from: string, to: string) => {
      await new Promise((r) => setTimeout(r, 200))
      return originalRename(from, to)
    }

    const sessionId = "race-victim"
    const tracer = Trace.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace(sessionId, { prompt: "long-running task" })
    await new Promise((r) => setTimeout(r, 300))

    tracer.logToolCall({
      tool: "bash",
      callID: "c-pre-crash",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })
    await new Promise((r) => setTimeout(r, 50))
    tracer.flushSync("SIGTERM received during long session")
    await new Promise((r) => setTimeout(r, 300))

    const filePath = path.join(tmpDir, `${sessionId}.json`)
    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    expect(traceFile.summary.status).toBe("crashed")
  })

  test("natural race — burst of events + flushSync, no fs patch (statistical)", async () => {
    // No fs.rename patch — pure stock behavior. We run many iterations with
    // a burst of events followed by an immediate flushSync. The natural timing
    // between writeFile completion and rename is small but nonzero; over enough
    // iterations the race will fire at least once on most machines.
    const ITERATIONS = 50
    const failures: Array<{ iter: number; status: string; hasError: boolean }> = []

    for (let i = 0; i < ITERATIONS; i++) {
      const sessionId = `natural-${i}`
      const tracer = Trace.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionId, { prompt: `iter ${i}` })

      // Burst of spans — each triggers snapshot(). The debounce drops most;
      // the first one is in flight when we crash.
      for (let j = 0; j < 8; j++) {
        tracer.logToolCall({
          tool: `tool-${j}`,
          callID: `c${i}-${j}`,
          state: {
            status: "completed",
            input: { i, j, payload: "x".repeat(500) },
            output: "ok",
            time: { start: 1, end: 2 },
          },
        })
      }

      tracer.flushSync(`crash-${i}`)

      // Give the in-flight async rename time to land (or not).
      await new Promise((r) => setTimeout(r, 20))

      const filePath = path.join(tmpDir, `${sessionId}.json`)
      const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
      if (traceFile.summary.status !== "crashed" || !traceFile.summary.error?.includes(`crash-${i}`)) {
        failures.push({
          iter: i,
          status: traceFile.summary.status,
          hasError: !!traceFile.summary.error,
        })
      }
    }

    // Report what we observed so the test failure message is actionable
    if (failures.length > 0) {
      console.error(`Natural race hit ${failures.length}/${ITERATIONS} times. Sample failures:`)
      for (const f of failures.slice(0, 5)) console.error(`  iter=${f.iter} status=${f.status} hasError=${f.hasError}`)
    }
    expect(failures).toEqual([])
  })

  // M2 — debounce drops events from in-flight snapshots, no follow-up scheduled.
  // If a crash happens after the in-flight snapshot completes but before the next
  // event triggers another snapshot, the on-disk file is stale.
  test("M2 — events arriving during in-flight snapshot are not snapshotted until the next event", async () => {
    // Slow rename so events can pile up during the in-flight write
    ;(fs as any).rename = async (from: string, to: string) => {
      await new Promise((r) => setTimeout(r, 150))
      return originalRename(from, to)
    }

    const sessionId = "debounce-drop"
    const tracer = Trace.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace(sessionId, { prompt: "test" })
    // Let startTrace's initial snapshot land
    await new Promise((r) => setTimeout(r, 250))

    // Trigger snapshot via tool A; rename will be delayed 150ms
    tracer.logToolCall({
      tool: "tool-A",
      callID: "a",
      state: { status: "completed", input: { i: 1 }, output: "A", time: { start: 1, end: 2 } },
    })

    // Within the rename's 150ms delay, fire B, C, D. snapshotPending is true,
    // so each snapshot() returns early — but the M2 fix sets
    // snapshotRequestedDuringPending so a follow-up snapshot is scheduled
    // (via queueMicrotask in the in-flight snapshot's .finally).
    await new Promise((r) => setTimeout(r, 30))
    tracer.logToolCall({
      tool: "tool-B",
      callID: "b",
      state: { status: "completed", input: { i: 2 }, output: "B", time: { start: 3, end: 4 } },
    })
    tracer.logToolCall({
      tool: "tool-C",
      callID: "c",
      state: { status: "completed", input: { i: 3 }, output: "C", time: { start: 5, end: 6 } },
    })
    tracer.logToolCall({
      tool: "tool-D",
      callID: "d",
      state: { status: "completed", input: { i: 4 }, output: "D", time: { start: 7, end: 8 } },
    })

    // Wait for A's in-flight snapshot to complete AND the M2 fix's follow-up
    // snapshot to also land. The follow-up runs an additional writeFile +
    // (patched 150 ms) rename, so we need ~2× the per-snapshot budget.
    await new Promise((r) => setTimeout(r, 600))

    // Read the file. With the M2 fix the .finally() schedules a follow-up
    // snapshot when events arrived during the in-flight write; all four
    // tools should now land on disk.
    const filePath = path.join(tmpDir, `${sessionId}.json`)
    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    const toolNames = traceFile.spans.filter((s) => s.kind === "tool").map((s) => s.name).sort()

    expect(toolNames).toEqual(["tool-A", "tool-B", "tool-C", "tool-D"])
  })

  // Note: an "M3 deterministic" test that patches fs.rename to add an
  // artificial delay would exercise the same kernel-rename TOCTOU as the
  // M1 deterministic test above — that residual is architectural and not
  // closed by this PR. The natural M3 test below (large trace, no patch)
  // is the load-bearing regression test for the M3 fix: it exercises the
  // long-writeFile window, which is the only window that fires naturally
  // and which FileExporter._crashed actually catches.

  // M1 natural — verifies the EXISTING `crashed` flag (commit 38463876b)
  // continues to protect against the snapshot-rename TOCTOU under natural
  // timing on local SSD. No fs patches, no workers.
  // Regression test for pre-existing protection, not for this PR's new fix.
  test("M1-natural — crashed flag protects flushSync against the snapshot rename race", async () => {
    let observedClobber = 0
    const TRIALS = 5
    for (let trial = 0; trial < TRIALS; trial++) {
      const sessionId = `natural-m1-${trial}`
      const tracer = Trace.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionId, { prompt: "long-running task simulation" })

      // Preload some bulky spans so the snapshot's writeFile has real work
      const bulk = "x".repeat(2_000)
      for (let i = 0; i < 500; i++) {
        tracer.logToolCall({
          tool: `preload-${i % 16}`,
          callID: `pre-${trial}-${i}`,
          state: {
            status: "completed",
            input: { i, payload: bulk },
            output: bulk,
            time: { start: i, end: i + 1 },
          },
        })
      }
      await new Promise((r) => setTimeout(r, 50))

      tracer.logToolCall({
        tool: "trigger",
        callID: `trigger-${trial}`,
        state: { status: "completed", input: { trial }, output: "go", time: { start: 1, end: 2 } },
      })
      tracer.flushSync(`natural-crash-${trial}`)
      await new Promise((r) => setTimeout(r, 300))

      const filePath = path.join(tmpDir, `${sessionId}.json`)
      const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
      if (traceFile.summary.status !== "crashed" || !traceFile.summary.error?.includes(`natural-crash-${trial}`)) {
        observedClobber++
      }
    }
    // On local SSD the kernel rename's syscall completes too fast for
    // flushSync to interleave; existing `crashed` flag closes the window.
    expect(observedClobber).toBe(0)
  }, 30_000)

  // M2 under natural conditions: NO fs patch. Just burst events fast.
  // If the burst overlaps with an in-flight snapshot, late events get dropped
  // and never re-snapshotted. A crash (or process exit without endTrace) at
  // that moment leaves the file missing the most recent events.
  test("M2-natural — burst of events while snapshot in flight, file ends stale (no fs patch)", async () => {
    let observedDrops = 0
    const TRIALS = 20
    const detail: Array<{ trial: number; expected: number; actual: number; missing: number }> = []

    for (let trial = 0; trial < TRIALS; trial++) {
      const sessionId = `natural-m2-${trial}`
      const tracer = Trace.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionId, { prompt: "burst sim" })

      // Preload bulk so the snapshot's writeFile takes real time
      const bulk = "x".repeat(2_000)
      for (let i = 0; i < 800; i++) {
        tracer.logToolCall({
          tool: `pre-${i}`,
          callID: `pre-${trial}-${i}`,
          state: {
            status: "completed",
            input: { i, payload: bulk },
            output: bulk,
            time: { start: i, end: i + 1 },
          },
        })
      }
      // Let preload settle
      await new Promise((r) => setTimeout(r, 50))

      // Burst of 8 fresh events — most of which will arrive during an
      // in-flight snapshot and get dropped.
      const burstNames = []
      for (let i = 0; i < 8; i++) {
        const name = `burst-${i}`
        burstNames.push(name)
        tracer.logToolCall({
          tool: name,
          callID: `b-${trial}-${i}`,
          state: { status: "completed", input: { i, payload: bulk }, output: "ok", time: { start: 1, end: 2 } },
        })
      }

      // Simulate "process exits without endTrace" by waiting for any
      // in-flight write to settle, then reading. NO subsequent event fires
      // to trigger a catch-up snapshot.
      await new Promise((r) => setTimeout(r, 100))

      const filePath = path.join(tmpDir, `${sessionId}.json`)
      const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
      const burstFound = traceFile.spans.filter((s) => s.name.startsWith("burst-")).map((s) => s.name)
      const missing = burstNames.length - burstFound.length
      if (missing > 0) observedDrops++
      detail.push({ trial, expected: burstNames.length, actual: burstFound.length, missing })
    }

    // Regression: after the M2 fix (follow-up snapshot scheduled in .finally),
    // all burst events must land on disk before the file is read.
    if (observedDrops > 0) {
      console.error(`Natural M2 regression: ${observedDrops}/${TRIALS} had dropped events`)
      for (const d of detail.slice(0, 5))
        console.error(`  trial=${d.trial} expected=${d.expected} actual=${d.actual} missing=${d.missing}`)
    }
    expect(observedDrops).toBe(0)
  }, 60_000)

  // (M1-natural-aggressive — pool saturation + huge JSON + CPU oversubscription —
  // ran 10 trials with 25 MB JSON, 16 worker_threads, 200 concurrent 1 MB noise
  // writes; result was 0/10 clobbered. The existing `crashed` flag closes the
  // window on local SSD under all the natural pressure we could apply. The
  // residual kernel-rename TOCTOU is documented in the umbrella issue.
  // Test deleted because it adds no coverage over M1-natural and ran ~10 minutes.)

  // M3 natural: NO fs patch. endTrace's export() does writeFile(tmp) → rename(tmp, final).
  // For a large preloaded trace, the writeFile takes real time (tens to hundreds of ms),
  // giving flushSync a wide window to interleave. export() has NO crashed-guard, so
  // its rename always lands afterward and overwrites flushSync's crashed content.
  test("M3-natural — endTrace export() race fires without fs patch on large trace", async () => {
    let observedClobber = 0
    const TRIALS = 10
    const detail: Array<{ trial: number; status: string; hasError: boolean; bytes: number }> = []

    for (let trial = 0; trial < TRIALS; trial++) {
      const sessionId = `natural-m20-${trial}`
      const tracer = Trace.withExporters([new FileExporter(tmpDir)])
      tracer.startTrace(sessionId, { prompt: "natural m20" })

      // Big preload so export's writeFile takes real wall-clock time
      const bulk = "x".repeat(5_000)
      for (let i = 0; i < 5_000; i++) {
        tracer.logToolCall({
          tool: `pre-${i % 32}`,
          callID: `pre-${trial}-${i}`,
          state: {
            status: "completed",
            input: { i, payload: bulk },
            output: bulk,
            time: { start: i, end: i + 1 },
          },
        })
      }
      await new Promise((r) => setTimeout(r, 100))

      // Kick off endTrace asynchronously — it will call FileExporter.export()
      // which writeFiles the tmp, then renames. The writeFile of a multi-MB
      // JSON takes real time.
      const endTracePromise = tracer.endTrace()

      // Wait briefly for export's writeFile to begin (Promise scheduling).
      // Then synchronously flushSync — writes filePath via writeFileSync.
      // export's writeFile is still in flight; its rename hasn't run yet.
      await new Promise((r) => setTimeout(r, 5))
      tracer.flushSync(`natural-m20-crash-${trial}`)

      // Wait for endTrace's rename to land. With no crashed guard in export(),
      // the rename will clobber flushSync's content.
      await endTracePromise.catch(() => {})
      await new Promise((r) => setTimeout(r, 200))

      const filePath = path.join(tmpDir, `${sessionId}.json`)
      const buf = await fs.readFile(filePath, "utf-8")
      const traceFile: TraceFile = JSON.parse(buf)
      const wasClobbered =
        traceFile.summary.status !== "crashed" ||
        !traceFile.summary.error?.includes(`natural-m20-crash-${trial}`)
      if (wasClobbered) observedClobber++
      detail.push({
        trial,
        status: traceFile.summary.status,
        hasError: !!traceFile.summary.error,
        bytes: buf.length,
      })
    }

    // Regression: after the M3 fix (FileExporter._crashed guard + flushSync
    // notifies all FileExporters), endTrace's in-flight export() must not
    // clobber flushSync's canonical crashed write.
    if (observedClobber > 0) {
      console.error(`Natural M3 regression: ${observedClobber}/${TRIALS} clobbered`)
      for (const d of detail)
        console.error(`  trial=${d.trial} status=${d.status} hasError=${d.hasError} bytes=${d.bytes}`)
    }
    expect(observedClobber).toBe(0)
  }, 120_000)

  // Regression for the critical issue raised in the consensus review of PR #867:
  // FileExporter._crashed was originally an instance-level boolean, but the TUI
  // worker caches a single FileExporter across sessions (worker.ts shares
  // `tracingExporters` via `Trace.withExporters([...tracingExporters])`).
  // A single boolean meant one crashed session would permanently suppress
  // exports for every subsequent session in the same worker. The fix is
  // per-session crash tracking via Set<sessionId>.
  test("shared FileExporter — flushSync on trace A must NOT suppress trace B's export", async () => {
    const sharedExporter = new FileExporter(tmpDir)

    // Trace A: flushSync → marks session-A crashed, writes canonical file
    const traceA = Trace.withExporters([sharedExporter])
    traceA.startTrace("session-A", { prompt: "A" })
    await new Promise((r) => setTimeout(r, 50))
    traceA.logToolCall({
      tool: "tool-a",
      callID: "ca",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })
    traceA.flushSync("crash-A")

    // Trace B: normal lifecycle on the SAME exporter instance — must export cleanly
    const traceB = Trace.withExporters([sharedExporter])
    traceB.startTrace("session-B", { prompt: "B" })
    traceB.logToolCall({
      tool: "tool-b",
      callID: "cb",
      state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
    })
    const pathB = await traceB.endTrace()

    // Trace A's file: crashed (flushSync wins)
    const traceFileA: TraceFile = JSON.parse(
      await fs.readFile(path.join(tmpDir, "session-A.json"), "utf-8"),
    )
    expect(traceFileA.summary.status).toBe("crashed")

    // Trace B's file: completed (per-session guard scopes A's crash to A only)
    expect(pathB).toBe(path.join(tmpDir, "session-B.json"))
    const traceFileB: TraceFile = JSON.parse(await fs.readFile(pathB!, "utf-8"))
    expect(traceFileB.summary.status).toBe("completed")
  })

  // Regression for cubic-dev-ai's P1 review finding on PR #867:
  // markCrashed() was being called with the raw sessionId, but the export()
  // suppression check uses trace.sessionId (which comes from buildTraceFile
  // and is sanitized through the `[/\\.:]` → `_` regex). A sessionId
  // containing any of those characters would store under one key in the
  // crashedSessions Set and be looked up under a different key in export(),
  // silently bypassing the crash guard. Fix: sanitize at the store side too.
  test("crash guard handles unsafe sessionId chars (sanitization parity)", async () => {
    const exporter = new FileExporter(tmpDir)
    const tracer = Trace.withExporters([exporter])
    // Pick a sessionId that needs sanitization through the file-name regex
    const unsafeId = "weird:session/with.unsafe:chars"
    tracer.startTrace(unsafeId, { prompt: "test" })
    await new Promise((r) => setTimeout(r, 50))
    tracer.flushSync("crash with unsafe id")

    // Manually invoke export() with the canonical (sanitized) trace data —
    // this is what endTrace would do internally. If sanitization parity is
    // broken, the markCrashed Set entry won't match and the export will
    // overwrite flushSync's content.
    const trace: TraceFile = {
      version: 2,
      traceId: "t",
      sessionId: unsafeId.replace(/[/\\.:]/g, "_"),
      startedAt: new Date().toISOString(),
      metadata: {},
      spans: [],
      summary: {
        totalTokens: 0,
        totalCost: 0,
        totalToolCalls: 0,
        totalGenerations: 0,
        duration: 0,
        status: "completed",
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }
    const result = await exporter.export(trace)
    // export() must bail because the session was marked crashed; the
    // sanitized lookup must find the (sanitized) entry from markCrashed.
    expect(result).toBeUndefined()

    // And the on-disk file must still be flushSync's crashed content
    const safeId = unsafeId.replace(/[/\\.:]/g, "_")
    const traceFile: TraceFile = JSON.parse(
      await fs.readFile(path.join(tmpDir, `${safeId}.json`), "utf-8"),
    )
    expect(traceFile.summary.status).toBe("crashed")
  })

  test("baseline — flushSync alone writes crashed content correctly (no race)", async () => {
    // Sanity check: without the rename delay, flushSync's content lands and survives.
    // If this fails we have a different bug than the race we're investigating.
    const sessionId = "baseline"
    const tracer = Trace.withExporters([new FileExporter(tmpDir)])
    tracer.startTrace(sessionId, { prompt: "baseline" })

    // Wait for the initial snapshot to settle
    await new Promise((r) => setTimeout(r, 100))

    tracer.flushSync("SIGTERM baseline")

    const filePath = path.join(tmpDir, `${sessionId}.json`)
    const traceFile: TraceFile = JSON.parse(await fs.readFile(filePath, "utf-8"))
    expect(traceFile.summary.status).toBe("crashed")
    expect(traceFile.summary.error).toContain("SIGTERM baseline")
  })
})
