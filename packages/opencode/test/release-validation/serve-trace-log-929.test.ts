/**
 * Regression tests for PR #929 — log the session-trace directory on serve startup.
 *
 * The change adds `TraceConsumer.getTraceDirectory()` (returns the configured
 * FileExporter's dir, or undefined when no file exporter exists) and has
 * `subscribeTraceConsumer` emit a single `[tracing] session traces` info log
 * carrying that directory once, before the reconnect loop.
 *
 * These tests assert the INTENDED behaviour and pass against the merged code:
 *   1-3. getTraceDirectory() resolution across exporter shapes.
 *   4.   config-load-failure fallback: directory is undefined (the known gap)
 *        yet tracing still functions (the warn fallback path fires).
 *   5-6. subscribeTraceConsumer logs the directory once iff a FileExporter
 *        is present, and not at all otherwise.
 *
 * Style/helpers mirror test/altimate/trace-consumer.test.ts (the existing
 * consumer test): temp-dir FileExporter, an injectable event source, and a
 * held-open stream for the startup path. Per that file's guidance we use
 * spyOn (NOT mock.module) for shared infra modules (@/util/log, @/config/config)
 * so the global module isn't clobbered for other test files.
 */

import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import {
  TraceConsumer,
  subscribeTraceConsumer,
  type TraceEventSource,
} from "../../src/altimate/observability/trace-consumer"
import { FileExporter, HttpExporter } from "../../src/altimate/observability/tracing"
import { Log } from "@/util/log"
import { Config } from "@/config/config"

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `serve-trace-log-929-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

/**
 * Held-open, empty event source for the subscribe() seam: yields nothing and
 * blocks until the shutdown signal fires, so the startup info-log (which runs
 * once before the reconnect loop) is the only observable effect.
 */
function heldOpenEmptySource(signal: AbortSignal): TraceEventSource {
  async function* gen() {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }
  return { stream: gen() }
}

/** Yield to the event loop so the subscribe loop's pre-loop body runs. */
async function tick() {
  await new Promise((r) => setTimeout(r, 20))
}

describe("getTraceDirectory", () => {
  test("returns the FileExporter dir when a FileExporter is configured", () => {
    const c = new TraceConsumer({ exporters: [new FileExporter(tmpDir)] })
    expect(c.getTraceDirectory()).toBe(tmpDir)
  })

  test("returns undefined when tracing is disabled (no exporters set)", () => {
    // Disabled + no exporters → no FileExporter → directory undefined, so the
    // startup directory-log is suppressed for a disabled consumer.
    const c = new TraceConsumer({ enabled: false, exporters: undefined })
    expect(c.getTraceDirectory()).toBeUndefined()
  })

  test("returns undefined when only an HttpExporter is present", () => {
    // find() finds no FileExporter among HTTP-only exporters.
    const c = new TraceConsumer({ exporters: [new HttpExporter("cloud", "http://x")] })
    expect(c.getTraceDirectory()).toBeUndefined()
  })

  test("finds the FileExporter even when mixed with an HttpExporter", () => {
    const c = new TraceConsumer({
      exporters: [new HttpExporter("cloud", "http://x"), new FileExporter(tmpDir)],
    })
    expect(c.getTraceDirectory()).toBe(tmpDir)
  })
})

describe("getTraceDirectory — config-load-failure fallback (the known gap)", () => {
  test("config load failure leaves directory undefined yet tracing still functions", async () => {
    // When Config.get() rejects, loadConfig() catches it, leaves `enabled`
    // true and `exporters` undefined (so getOrCreateTrace falls back to
    // Trace.create()'s default FileExporter), and logs a warn so the fallback
    // isn't silent. getTraceDirectory() is therefore undefined — the
    // directory-log gap is intentional/known, NOT a bug — but tracing is NOT
    // disabled. We assert both: undefined dir AND the warn fallback path taken.
    const configSpy = spyOn(Config as any, "get").mockImplementation(() =>
      Promise.reject(new Error("boom: config unreadable")),
    )
    const warnSpy = spyOn(Log.Default, "warn")
    try {
      // Bare consumer (no overrides) so loadConfig() actually runs Config.get.
      const c = new TraceConsumer()
      await c.loadConfig()

      // Directory is undefined: the startup log is correctly suppressed even
      // though tracing remains enabled and operational via the default tracer.
      expect(c.getTraceDirectory()).toBeUndefined()

      // Tracing still functions: the fallback warn fired (not silent).
      const warned = warnSpy.mock.calls.some(
        (call) => call[0] === "[tracing] failed to load config, using default tracer",
      )
      expect(warned).toBe(true)
    } finally {
      configSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})

describe("subscribeTraceConsumer — startup directory log", () => {
  test("logs the trace directory exactly once on startup when a FileExporter is configured", async () => {
    const consumer = new TraceConsumer({ exporters: [new FileExporter(tmpDir)] })
    const infoSpy = spyOn(Log.Default, "info")
    let sub: { stop: () => Promise<void> } | undefined
    try {
      sub = subscribeTraceConsumer(
        { directory: tmpDir },
        {
          consumer,
          subscribe: async (signal) => heldOpenEmptySource(signal),
        },
      )
      await tick()

      const traceLogCalls = infoSpy.mock.calls.filter((call) => call[0] === "[tracing] session traces")
      // Exactly one — the log sits BEFORE the reconnect loop, so it is not
      // re-emitted per reconnect.
      expect(traceLogCalls.length).toBe(1)
      expect((traceLogCalls[0]?.[1] as { directory?: string } | undefined)?.directory).toBe(tmpDir)
    } finally {
      await sub?.stop()
      infoSpy.mockRestore()
    }
  })

  test("does NOT log the trace directory when no FileExporter is configured", async () => {
    // HTTP-only consumer → getTraceDirectory() undefined → startup log skipped.
    const consumer = new TraceConsumer({ exporters: [new HttpExporter("cloud", "http://x")] })
    const infoSpy = spyOn(Log.Default, "info")
    let sub: { stop: () => Promise<void> } | undefined
    try {
      sub = subscribeTraceConsumer(
        { directory: tmpDir },
        {
          consumer,
          subscribe: async (signal) => heldOpenEmptySource(signal),
        },
      )
      await tick()

      const traceLogCalls = infoSpy.mock.calls.filter((call) => call[0] === "[tracing] session traces")
      expect(traceLogCalls.length).toBe(0)
    } finally {
      await sub?.stop()
      infoSpy.mockRestore()
    }
  })
})
