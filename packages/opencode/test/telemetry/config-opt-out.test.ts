// altimate_change — regression test for two fixes that together make the `telemetry.disabled`
// config opt-out actually work.
//
// Fix 1 (src/cli/tui/worker.ts): `Telemetry.init()` used to run at module top level in the bare
// TUI worker, where `Config.get()` throws (no Instance context yet), so `doInit()` proceeded as
// enabled and the opt-out was silently bypassed for the whole first session. It now runs inside
// `Instance.restore(ctx, ...)` in `traceReady` (worker.ts's `traceReady` IIFE), specifically so
// `doInit()`'s `Config.get()` can see the merged, instance-scoped config.
//
// Fix 2 (packages/core/src/v1/config/config.ts): even with fix 1, `ConfigV1.Info` (the schema
// every project/global/local config file is parsed against) had NO `telemetry` field at all.
// `doInit()` (packages/opencode/src/altimate/telemetry/index.ts:2019-2020) reads
// `(await Config.get() as any).telemetry?.disabled` — before this fix the `as any` cast was hiding
// that it read a field the schema never declared. Writing `{ "telemetry": { "disabled": true } }`
// to a config file made THAT FILE's `ConfigParse.schema(ConfigV1.Info, ...)` call throw
// `unrecognized_keys`, which propagated out of `Config.get()` as a `ConfigInvalidError` Die defect
// instead of merging past that file — `doInit()`'s own try/catch around `Config.get()`
// (index.ts:2017-2023) treats ANY failure as "Config unavailable — proceed with telemetry
// enabled", so the opt-out did not merely fail silently: adding it to a config file broke that
// file's config loading entirely (for every other config-dependent feature in that Instance too,
// not just telemetry) and telemetry stayed on regardless. `ConfigV1.Info` now declares
// `telemetry: Schema.optional(Schema.Struct({ disabled: Schema.optional(Schema.Boolean) }))`, so
// the field parses cleanly and `doInit()` can actually see it.
//
// Both fixes are necessary: fix 1 alone gets `Config.get()` a working Instance context but the
// schema still rejected the field; fix 2 alone adds the field to the schema but the bare worker's
// `Config.get()` call still would have thrown before ever reading it. The three tests below prove,
// in order: the Instance-context mechanism resolves the right config (fix 1), the happy path with
// no opt-out still enables telemetry, and the opt-out itself now disables it end to end (fix 2).
import { afterEach, describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { Telemetry } from "@/altimate/telemetry"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Config.defaultLayer, FSUtil.defaultLayer))

// Local copy of config.test.ts's / tui.test.ts's env-restore helper — neither file exports it, and
// every existing suite that needs one duplicates it rather than centralizing.
function withProcessEnvs<A, E, R>(entries: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originals: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(entries)) {
        originals[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return originals
    }),
    () => effect,
    (originals) =>
      Effect.sync(() => {
        for (const [key, original] of Object.entries(originals)) {
          if (original !== undefined) process.env[key] = original
          else delete process.env[key]
        }
      }),
  )
}

// Explicit connection string bypasses isAutomatedRun()'s implicit-production-sink withholding (see
// doInit()'s comment: "Telemetry's own tests set APPLICATIONINSIGHTS_CONNECTION_STRING explicitly
// and are unaffected"), and both disable env vars must be cleared so only the config path is live.
const TELEMETRY_ENV = {
  APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=config-opt-out-test;IngestionEndpoint=https://example.com",
  ALTIMATE_TELEMETRY_DISABLED: undefined,
  OPENCODE_DISABLE_TELEMETRY: undefined,
}

describe("Telemetry.init() inside an Instance context — config.telemetry.disabled opt-out", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
  })

  it.instance(
    "Config.get(), called the same way doInit() calls it, resolves the Instance-scoped project config instead of throwing — the mechanism the worker.ts fix relies on",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const test = yield* TestInstance
        yield* fs.writeJson(`${test.directory}/opencode.json`, {
          $schema: "https://opencode.ai/config.json",
          username: "instance-scoped-marker",
        })
        // The plain async Config.get() facade is exactly what doInit() calls; invoking it via
        // Effect.promise from inside this it.instance's Instance/InstanceRef context mirrors
        // Instance.restore(ctx, () => Telemetry.init()) in worker.ts's traceReady. Before the fix,
        // calling this at bare module scope (no Instance) would throw instead of resolving.
        const config = yield* Effect.promise(() => Config.get())
        expect((config as any).username).toBe("instance-scoped-marker")
      }),
  )

  it.instance(
    "without a telemetry opt-out, Telemetry.init() run inside the Instance context enables telemetry and flushes anchor events",
    () =>
      withProcessEnvs(
        TELEMETRY_ENV,
        Effect.gen(function* () {
          const flushSpy = spyOn(Telemetry, "flush")
          try {
            yield* Effect.promise(() => Telemetry.init())
            expect(Telemetry.isEnabled()).toBe(true)
            Telemetry.track({
              type: "startup_ready",
              timestamp: Date.now(),
              session_id: "config-opt-out-enabled",
              command: "test",
              duration_ms: 1,
              fresh_install: false,
            })
            expect(flushSpy).toHaveBeenCalled()
          } finally {
            flushSpy.mockRestore()
          }
        }),
      ),
  )

  it.instance(
    "telemetry.disabled: true in project config disables telemetry end to end, with no flush",
    () =>
      withProcessEnvs(
        TELEMETRY_ENV,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const test = yield* TestInstance
          const flushSpy = spyOn(Telemetry, "flush")
          try {
            yield* fs.writeJson(`${test.directory}/opencode.json`, {
              $schema: "https://opencode.ai/config.json",
              telemetry: { disabled: true },
            })
            yield* Effect.promise(() => Telemetry.init())
            expect(Telemetry.isEnabled()).toBe(false)
            expect(flushSpy).not.toHaveBeenCalled()
          } finally {
            flushSpy.mockRestore()
          }
        }),
      ),
  )
})
