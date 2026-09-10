/**
 * Adversarial coverage for the v0.11.1 same-day patch payload (v0.11.0..HEAD, 2 commits).
 *
 * v0.11.0 shipped earlier today (2026-09-09) and froze on fresh install for 2.5-5 minutes: Config
 * and TuiConfig both forked an in-process @npmcli/arborist reify of @opencode-ai/plugin into every
 * config dir on every start, which saturated Bun's event loop. This patch adds two fixes and their
 * own dedicated suites, which this file does NOT re-cover:
 *
 *   1. `ConfigPlugin.needsDependencies` (packages/opencode/src/config/plugin.ts) gates the install to
 *      dirs that can actually import the package. `test/config/config.test.ts`'s "config dir plugin
 *      dependency install" describe block (~260 new lines) and `test/config/tui.test.ts`'s TUI gate
 *      matrix already exercise it end-to-end through `loadConfigDirWithDependencies` / `TuiConfig` for
 *      every real-world plugin/tool/node_modules shape, PURE mode, and both symlink directions at the
 *      config-loading layer.
 *   2. First-run health telemetry (`src/altimate/telemetry/index.ts`, `src/altimate/free/client.ts`).
 *      `test/altimate/telemetry/first-run-health.test.ts` covers startup_ready once-only semantics,
 *      `loopStallFor`'s basic threshold behavior, the monitor firing after a real block, and
 *      idempotent start/stop. `test/altimate/altimate-base-registration-telemetry.test.ts` covers
 *      success/http/network/malformed-token/misconfigured-gateway reporting for
 *      `altimate_base_registration`.
 *
 * This file adds boundary classes those suites do not reach:
 *
 *   - `ConfigPlugin.needsDependencies` called DIRECTLY (not through the config-loading pipeline) with
 *     adversarial inputs: a dir that doesn't exist, a dir that is a file, an unreadable dir, a
 *     `node_modules` that is a FILE (existsSync doesn't check type), a directory literally named
 *     like a source file, `.mjs` sources (must NOT match the install-trigger glob), `plugin/`
 *     (singular) sources, percent-encoded `..` traversal in `file://` specs (both directions),
 *     `file://` URLs with a host component or a Windows drive letter on POSIX, a dangling `file://`
 *     target, and a symlinked config dir referenced by its real path, plus a malformed plugin tuple
 *     whose first element is not a string (guarded with a `typeof spec !== "string"` check).
 *   - `Telemetry.loopStallFor` and the loop monitor's numeric edge cases (negative/NaN/Infinity lag,
 *     the exact-threshold boundary, rounding) and its `LOOP_STALL_MAX_EVENTS` cap — the existing
 *     suite only checks one real stall fires, not that the cap holds after many.
 *   - `Telemetry.startupReady` / `setCommand` combinations the existing suite doesn't try: a second
 *     call with an explicit different name (not just a no-arg call) still being ignored, and
 *     `setCommand` actually writing `process.env.ALTIMATE_CLI_COMMAND`.
 *   - `Telemetry.track` for an anchor event type before `init()` completes: must buffer without
 *     throwing and must NOT call `flush` (the existing pre-init buffering test uses non-anchor events
 *     and never spies on `flush`).
 *   - `registerAfterConsent`: a consent token redeemed a second time (the existing "expired consent
 *     token" test uses a garbage string that was never armed; this exercises the real one-shot
 *     `consume()` path with a token that WAS valid) and a configured gateway URL that fails the
 *     https-only / no-credentials check via a different branch than the existing `ftp://` test
 *     (plain `http://` and an embedded-credentials `https://` URL).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { pathToFileURL } from "url"
import { ConfigPlugin } from "../../src/config/plugin"
import { Telemetry } from "../../src/altimate/telemetry"
import { consented, isolateAltimateBaseHome, resetGatewayEnv } from "../altimate/_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "../altimate/_fixtures/fake-gateway"

// Harness contract: isolate the Altimate Base home BEFORE importing src/altimate/free/*.
isolateAltimateBaseHome("release-v0.11.1-adversarial")

const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")

// ---------------------------------------------------------------------------
// ConfigPlugin.needsDependencies — direct unit-level adversarial cases
// ---------------------------------------------------------------------------
const tmpDirs: string[] = []
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-v0.11.1-adversarial-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    // A permission-denied test may leave a dir chmod'd 000; restore before recursive removal.
    try {
      fs.chmodSync(dir, 0o755)
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("needsDependencies — dir argument edge cases", () => {
  test("a dir that does not exist returns false without throwing", () => {
    const base = tmp()
    expect(() => ConfigPlugin.needsDependencies(path.join(base, "does-not-exist"), undefined)).not.toThrow()
    expect(ConfigPlugin.needsDependencies(path.join(base, "does-not-exist"), undefined)).toBe(false)
  })

  test("a dir path that is actually a file returns false without throwing", () => {
    const base = tmp()
    const file = path.join(base, "actually-a-file")
    fs.writeFileSync(file, "x")
    expect(() => ConfigPlugin.needsDependencies(file, undefined)).not.toThrow()
    expect(ConfigPlugin.needsDependencies(file, undefined)).toBe(false)
  })

  test("an unreadable dir (chmod 000) with a real tool source still returns false without throwing", () => {
    if (process.getuid && process.getuid() === 0) return // root bypasses permission bits
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "tools"))
    fs.writeFileSync(path.join(dir, "tools", "hello.ts"), "export default {}\n")
    fs.chmodSync(dir, 0o000)
    let result: boolean | undefined
    expect(() => {
      result = ConfigPlugin.needsDependencies(dir, undefined)
    }).not.toThrow()
    // existsSync(dir/node_modules) fails closed and the glob walk cannot enter the dir either, so
    // the real source underneath is invisible — pinning that an unreadable dir degrades to "no
    // install" rather than crashing the config load.
    expect(result).toBe(false)
  })
})

describe("needsDependencies — malformed plugin spec shapes", () => {
  test("an empty-string plugin spec is ignored, not matched as a file:// spec", () => {
    const dir = tmp()
    expect(ConfigPlugin.needsDependencies(dir, [""])).toBe(false)
  })

  test("plugins undefined on a bare dir returns false", () => {
    const dir = tmp()
    expect(ConfigPlugin.needsDependencies(dir, undefined)).toBe(false)
  })

  test("an empty plugins array on a bare dir returns false", () => {
    const dir = tmp()
    expect(ConfigPlugin.needsDependencies(dir, [])).toBe(false)
  })

  test("a plugin tuple whose first element is not a string is ignored, not thrown on", () => {
    // plugin.ts:64 guards `typeof spec !== "string"` before `spec.startsWith("file://")`, so a
    // tuple that survived schema parsing (or any caller-provided spec) with a non-string first
    // element degrades to "not a file plugin" instead of throwing TypeError.
    const dir = tmp()
    expect(() => ConfigPlugin.needsDependencies(dir, [[123 as any, {}]] as any)).not.toThrow()
    expect(ConfigPlugin.needsDependencies(dir, [[123 as any, {}]] as any)).toBe(false)
  })
})

describe("needsDependencies — file:// traversal, host, and drive-letter edge cases", () => {
  test("a percent-encoded '..' that lexically decodes to escape the dir is rejected", () => {
    const dir = tmp()
    const encoded = pathToFileURL(dir).href + "/%2e%2e/outside/plugin.ts"
    expect(ConfigPlugin.needsDependencies(dir, [encoded])).toBe(false)
  })

  test("a percent-encoded '..' that decodes back inside the dir is accepted", () => {
    const dir = tmp()
    const encoded = pathToFileURL(dir).href + "/sub/%2e%2e/inside.ts"
    expect(ConfigPlugin.needsDependencies(dir, [encoded])).toBe(true)
  })

  test("a file:// URL with a host component does not crash and is not treated as inside the dir", () => {
    const dir = tmp()
    expect(() => ConfigPlugin.needsDependencies(dir, ["file://example.com/plugin.ts"])).not.toThrow()
    expect(ConfigPlugin.needsDependencies(dir, ["file://example.com/plugin.ts"])).toBe(false)
  })

  test("a Windows-style file:///C:/ URL evaluated on POSIX does not crash and is not treated as inside the dir", () => {
    const dir = tmp()
    expect(() => ConfigPlugin.needsDependencies(dir, ["file:///C:/plugin.ts"])).not.toThrow()
    if (process.platform !== "win32") {
      expect(ConfigPlugin.needsDependencies(dir, ["file:///C:/plugin.ts"])).toBe(false)
    }
  })

  test("a dangling file:// target under the dir still triggers install via the lexical fallback", () => {
    const dir = tmp()
    const spec = pathToFileURL(path.join(dir, "does-not-exist.ts")).href
    expect(ConfigPlugin.needsDependencies(dir, [spec])).toBe(true)
  })

  test("a symlinked config dir whose plugin spec is the real (non-alias) path is realpath-matched", () => {
    const base = tmp()
    const real = path.join(base, "real")
    fs.mkdirSync(real)
    const pluginFile = path.join(real, "plugin.ts")
    fs.writeFileSync(pluginFile, "export default {}\n")
    const alias = path.join(base, "alias")
    fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir")
    // The spec points at the REAL path, not the alias `dir` argument — only realpath-aware
    // comparison (not lexical) can see this is under `dir` once `dir` itself is resolved.
    expect(ConfigPlugin.needsDependencies(alias, [pathToFileURL(pluginFile).href])).toBe(true)
  })

  test("a plugin spec reached through an internal symlink that resolves outside the dir is rejected", () => {
    const dir = tmp()
    const outsideBase = tmp()
    const outsidePlugin = path.join(outsideBase, "plugin.ts")
    fs.writeFileSync(outsidePlugin, "export default {}\n")
    const innerAlias = path.join(dir, "alias")
    fs.symlinkSync(outsideBase, innerAlias, process.platform === "win32" ? "junction" : "dir")
    // Lexically "alias/plugin.ts" looks like it's inside `dir`; only realpath resolution reveals
    // the symlink actually leads outside.
    const spec = pathToFileURL(path.join(innerAlias, "plugin.ts")).href
    expect(ConfigPlugin.needsDependencies(dir, [spec])).toBe(false)
  })
})

describe("needsDependencies — glob source-detection edge cases", () => {
  test("node_modules present as a FILE (not a directory) still triggers install — pins existsSync's type-blind check", () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, "node_modules"), "not actually a directory")
    expect(ConfigPlugin.needsDependencies(dir, undefined)).toBe(true)
  })

  test("a directory literally named like a source file under tools/ does NOT match the source glob", () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "tools"))
    // A directory, not a file — the glob call passes no include:"all", so it walks with nodir:true
    // and this must not match.
    fs.mkdirSync(path.join(dir, "tools", "hello.ts"))
    expect(ConfigPlugin.needsDependencies(dir, undefined)).toBe(false)
  })

  test(".mjs sources do not match the {js,ts} install-trigger glob", () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "tools"))
    fs.writeFileSync(path.join(dir, "tools", "hello.mjs"), "export default {}\n")
    expect(ConfigPlugin.needsDependencies(dir, undefined)).toBe(false)
  })

  test("a singular plugin/ source dir (not plugins/) matches the glob", () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "plugin"))
    fs.writeFileSync(path.join(dir, "plugin", "hello.js"), "export default {}\n")
    expect(ConfigPlugin.needsDependencies(dir, undefined)).toBe(true)
  })
})

describe("shouldInstallDependencies — Flag.OPENCODE_PURE fold", () => {
  const ENV_KEY = "OPENCODE_PURE"
  let saved: string | undefined
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = saved
  })

  test("OPENCODE_PURE=1 suppresses installation even when needsDependencies would be true", () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "node_modules"))
    saved = process.env[ENV_KEY]
    process.env[ENV_KEY] = "1"
    expect(ConfigPlugin.needsDependencies(dir, undefined)).toBe(true)
    expect(ConfigPlugin.shouldInstallDependencies(dir, undefined)).toBe(false)
  })

  test("without OPENCODE_PURE, shouldInstallDependencies matches needsDependencies", () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, "node_modules"))
    saved = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
    expect(ConfigPlugin.shouldInstallDependencies(dir, undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Telemetry.loopStallFor — numeric adversarial cases beyond the basic threshold check
// ---------------------------------------------------------------------------
describe("loopStallFor — numeric edge cases", () => {
  test("a negative lag (timer fired early) never reports a stall", () => {
    expect(Telemetry.loopStallFor(100, 200, 1_000, "main")).toBeUndefined()
  })

  test("lag exactly equal to the threshold is not a stall — the check is strict greater-than", () => {
    expect(Telemetry.loopStallFor(2_000, 1_000, 1_000, "main")).toBeUndefined()
  })

  test("lag one millisecond over the threshold is a stall", () => {
    const stall = Telemetry.loopStallFor(2_001, 1_000, 1_000, "main")
    expect(stall?.type).toBe("event_loop_stall")
    if (stall?.type !== "event_loop_stall") throw new Error("unreachable")
    expect(stall.blocked_ms).toBe(1_001)
  })

  test("a NaN lag (NaN now or expectedAt) never reports a stall", () => {
    // telemetry/index.ts:2154 uses the negated form `if (!(lag > thresholdMs)) return undefined`,
    // so a NaN lag (any comparison against NaN is false) correctly falls into "not a stall" instead
    // of falling through to construct an event with NaN blocked_ms/since_start_ms.
    expect(Telemetry.loopStallFor(NaN, 1_000, 1_000, "main")).toBeUndefined()
    expect(Telemetry.loopStallFor(2_000, NaN, 1_000, "main")).toBeUndefined()
  })

  test("Infinity lag reports a stall with an Infinity blocked_ms rather than throwing", () => {
    const stall = Telemetry.loopStallFor(Infinity, 0, 1_000, "main")
    expect(stall?.type).toBe("event_loop_stall")
    if (stall?.type !== "event_loop_stall") throw new Error("unreachable")
    expect(stall.blocked_ms).toBe(Infinity)
  })

  test("a huge but finite lag rounds cleanly with no precision loss visible at millisecond scale", () => {
    const stall = Telemetry.loopStallFor(1e12 + 1_500, 1e12, 1_000, "main")
    expect(stall?.type).toBe("event_loop_stall")
    if (stall?.type !== "event_loop_stall") throw new Error("unreachable")
    expect(stall.blocked_ms).toBe(1_500)
    expect(Number.isFinite(stall.blocked_ms)).toBe(true)
  })

  test("a fractional lag is rounded, not truncated, in blocked_ms", () => {
    const stall = Telemetry.loopStallFor(1_000.6, 0, 100, "main")
    expect(stall?.type).toBe("event_loop_stall")
    if (stall?.type !== "event_loop_stall") throw new Error("unreachable")
    expect(stall.blocked_ms).toBe(Math.round(1_000.6))
  })
})

// ---------------------------------------------------------------------------
// startLoopMonitor / stopLoopMonitor — cap and idempotency the existing suite doesn't exercise
// ---------------------------------------------------------------------------
describe("startLoopMonitor — LOOP_STALL_MAX_EVENTS cap and idempotency", () => {
  let savedCommand: string | undefined
  afterEach(() => {
    if (savedCommand === undefined) delete process.env.ALTIMATE_CLI_COMMAND
    else process.env.ALTIMATE_CLI_COMMAND = savedCommand
    Telemetry.resetFirstRunStateForTest()
  })

  function blockFor(ms: number) {
    const until = performance.now() + ms
    while (performance.now() < until) {
      // Deliberately synchronous.
    }
  }

  test("no more than 20 event_loop_stall events are ever emitted in one process lifetime", async () => {
    savedCommand = process.env.ALTIMATE_CLI_COMMAND
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event) => {
      events.push(event)
    })
    try {
      // A tiny interval/threshold plus many short synchronous blocks generates far more than 20
      // stall opportunities without needing a long test.
      Telemetry.startLoopMonitor({ intervalMs: 5, thresholdMs: 3 })
      for (let i = 0; i < 30; i++) {
        blockFor(8)
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const stalls = events.filter((e) => e.type === "event_loop_stall")
      expect(stalls.length).toBeLessThanOrEqual(20)
      expect(stalls.length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
      Telemetry.stopLoopMonitor()
    }
  }, 10_000)

  test("stopLoopMonitor before any start is a safe no-op", () => {
    Telemetry.resetFirstRunStateForTest()
    expect(() => Telemetry.stopLoopMonitor()).not.toThrow()
    expect(() => Telemetry.stopLoopMonitor()).not.toThrow()
  })

  test("the monitor's interval timer is unref'd so it cannot keep the process alive", () => {
    Telemetry.startLoopMonitor({ intervalMs: 50, thresholdMs: 50 })
    try {
      // resetFirstRunStateForTest/stopLoopMonitor don't expose the handle, but Node/Bun timers
      // created with setInterval implement Timeout#hasRef(); the production code path explicitly
      // guards `"unref" in timer` before calling it, so this only asserts when that guard held.
      const activeHandles = (process as any)._getActiveHandles?.() as unknown[] | undefined
      if (!activeHandles) return // not observable on this runtime — skip rather than assume
      const timeoutLike = activeHandles.find(
        (h: any) => typeof h?.hasRef === "function" && typeof h?._idleTimeout === "number" && h._idleTimeout === 50,
      ) as { hasRef: () => boolean } | undefined
      if (!timeoutLike) return // handle not identifiable this way on this runtime — skip
      expect(timeoutLike.hasRef()).toBe(false)
    } finally {
      Telemetry.stopLoopMonitor()
    }
  })
})

// ---------------------------------------------------------------------------
// startupReady / setCommand — latch and env-propagation combinations
// ---------------------------------------------------------------------------
describe("startupReady / setCommand — latch and env propagation", () => {
  // Each test captures the "before" value as its first line (mirroring first-run-health.test.ts's
  // save/restore-in-afterEach shape) rather than a beforeEach, since every test here is short.
  let savedCommand: string | undefined
  afterEach(() => {
    if (savedCommand === undefined) delete process.env.ALTIMATE_CLI_COMMAND
    else process.env.ALTIMATE_CLI_COMMAND = savedCommand
    Telemetry.resetFirstRunStateForTest()
  })

  test("setCommand writes process.env.ALTIMATE_CLI_COMMAND so a spawned worker inherits it", () => {
    savedCommand = process.env.ALTIMATE_CLI_COMMAND
    Telemetry.setCommand("run")
    expect(process.env.ALTIMATE_CLI_COMMAND).toBe("run")
    expect(Telemetry.getCommand()).toBe("run")
  })

  test("a second startupReady call with an explicit different name is ignored — the latch wins over the argument", () => {
    savedCommand = process.env.ALTIMATE_CLI_COMMAND
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event) => {
      events.push(event)
    })
    try {
      Telemetry.setCommand("tui")
      Telemetry.startupReady("run")
      Telemetry.startupReady("serve")
      const ready = events.filter((e) => e.type === "startup_ready")
      expect(ready).toHaveLength(1)
      const event = ready[0] as Extract<Telemetry.Event, { type: "startup_ready" }>
      expect(event.command).toBe("run")
      // getCommand() reflects the first call's name too — the latch gates the whole update, not
      // just the emitted event.
      expect(Telemetry.getCommand()).toBe("run")
    } finally {
      spy.mockRestore()
    }
  })

  test("startupReady() with no name keeps whatever setCommand established", () => {
    savedCommand = process.env.ALTIMATE_CLI_COMMAND
    const events: Telemetry.Event[] = []
    const spy = spyOn(Telemetry, "track").mockImplementation((event) => {
      events.push(event)
    })
    try {
      Telemetry.setCommand("serve")
      Telemetry.startupReady()
      const ready = events.filter((e) => e.type === "startup_ready")
      expect(ready).toHaveLength(1)
      const event = ready[0] as Extract<Telemetry.Event, { type: "startup_ready" }>
      expect(event.command).toBe("serve")
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Telemetry.track — anchor events must buffer, not flush, before init completes
// ---------------------------------------------------------------------------
describe("track — anchor events before init", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
  })

  test("an anchor event tracked before init() completes is buffered without throwing and does not call flush", async () => {
    await Telemetry.shutdown()
    const flushSpy = spyOn(Telemetry, "flush")
    try {
      expect(() => {
        Telemetry.track({
          type: "startup_ready",
          timestamp: Date.now(),
          session_id: "pre-init",
          command: "run",
          duration_ms: 1,
          fresh_install: false,
        })
      }).not.toThrow()
      // track()'s immediate-flush branch requires `initDone && enabled`; before init() has ever
      // resolved, initDone is false, so even an anchor event must not trigger a flush.
      expect(flushSpy).not.toHaveBeenCalled()
    } finally {
      flushSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// registerAfterConsent — reuse and gateway-URL rejection branches not already covered
// ---------------------------------------------------------------------------
const gateway = new FakeGateway()
const GATEWAY_ENV = ["ALTIMATE_BASE_GATEWAY_URL", "ALTIMATE_FREE_GATEWAY_URL"] as const
let savedGatewayEnv: Record<string, string | undefined> = {}

describe("registerAfterConsent — consent reuse and gateway URL validation", () => {
  afterEach(async () => {
    gateway.restore()
    for (const key of GATEWAY_ENV) {
      if (savedGatewayEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedGatewayEnv[key]
    }
    await FreeTier.logout()
    await FreeTierStore.remove()
  })

  async function setUp() {
    savedGatewayEnv = Object.fromEntries(GATEWAY_ENV.map((key) => [key, process.env[key]]))
    gateway.install()
    gateway.reset()
    await FreeTier.logout()
    await FreeTierStore.remove()
    resetGatewayEnv(GATEWAY_URL)
  }

  test("redeeming the same consent token twice fails the second time as cancelled", async () => {
    await setUp()
    const token = consented()
    gateway.registerNext({ kind: "ok" })
    await expect(FreeTier.registerAfterConsent(token)).resolves.toBeDefined()

    await expect(FreeTier.registerAfterConsent(token)).rejects.toMatchObject({
      name: "AltimateBaseRegistrationError",
      kind: "cancelled",
    })
  })

  test("a plain http:// gateway URL is rejected as a configuration error, not a network error", async () => {
    await setUp()
    process.env.ALTIMATE_BASE_GATEWAY_URL = "http://gateway.test"
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toMatchObject({
      name: "AltimateBaseConfigurationError",
    })
    // The rejection must come from the URL check before any network call, so nothing was sent.
    expect(gateway.registerCalls).toHaveLength(0)
  })

  test("a gateway URL with embedded credentials is rejected as a configuration error", async () => {
    await setUp()
    process.env.ALTIMATE_BASE_GATEWAY_URL = "https://user:pass@gateway.test"
    await expect(FreeTier.registerAfterConsent(consented())).rejects.toMatchObject({
      name: "AltimateBaseConfigurationError",
    })
    expect(gateway.registerCalls).toHaveLength(0)
  })
})
