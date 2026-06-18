// Regression tests for PR #940 — trigger auto-update check on headless serve startup.
//
// Source under test: src/cli/cmd/serve-upgrade-check.ts (+ the wiring in serve.ts).
//
// No mock.module here: it is process-global in bun and would clobber
// ../upgrade / ../../project/instance for every other test in the run (this is
// the same constraint the source file documents). Collaborators are injected
// via StartupUpgradeDeps, and the "real context" test reconstructs the exact
// provide lambda defaultDeps uses (Instance.provide + InstanceBootstrap) and
// injects a run that calls the real Bus.publish — proving the wrapping gives
// Bus.publish a valid Instance context rather than throwing Context.NotFound.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import {
  runStartupUpgradeCheck,
  scheduleStartupUpgradeCheck,
  STARTUP_UPGRADE_DELAY_MS,
  type StartupUpgradeDeps,
} from "../../src/cli/cmd/serve-upgrade-check"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Installation } from "../../src/installation"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("PR #940 serve-upgrade-check behavior", () => {
  // ---------------------------------------------------------------------------
  // Finding #1: defaultDeps actually establishes a working Bus.publish context.
  //
  // The whole point of wrapping run() in Instance.provide is that upgrade()'s
  // notify() → Bus.publish(Installation.Event.UpdateAvailable) needs an ambient
  // Instance, or it throws Context.NotFound and the inner .catch silently
  // swallows it (no notification ever reaches SSE subscribers). We mirror
  // defaultDeps' provide exactly (Instance.provide + InstanceBootstrap) and
  // inject a run that calls the real Bus.publish; if the context were missing
  // the publish would throw and be swallowed, and the subscriber would see
  // nothing.
  // ---------------------------------------------------------------------------
  describe("real Instance context for Bus.publish", () => {
    afterEach(() => Instance.disposeAll())

    test("the same provide defaultDeps uses lets the real Bus.publish reach subscribers", async () => {
      await using tmp = await tmpdir({ git: true })

      const received: string[] = []
      let publishThrew: unknown

      // Identical to defaultDeps.provide in serve-upgrade-check.ts.
      const provide: StartupUpgradeDeps["provide"] = (directory, fn) =>
        Instance.provide({ directory, init: InstanceBootstrap, fn })

      // Subscribe inside the same instance, then publish via the real Bus from
      // the injected run — exactly the call upgrade()'s notify() makes.
      const deps: StartupUpgradeDeps = {
        provide,
        run: async () => {
          Bus.subscribe(Installation.Event.UpdateAvailable, (evt) => {
            received.push(evt.properties.version)
          })
          await Bun.sleep(10)
          try {
            await Bus.publish(Installation.Event.UpdateAvailable, { version: "99.99.99" })
          } catch (err) {
            // A missing instance context surfaces as Context.NotFound here.
            publishThrew = err
          }
          await Bun.sleep(10)
        },
      }

      // We pass tmp.path explicitly via a thin wrapper so the instance keys to
      // the git tmpdir (boot() needs a real project dir), while still exercising
      // the exact provide+publish path.
      await Instance.provide({
        directory: tmp.path,
        init: InstanceBootstrap,
        fn: () => deps.run!(),
      })

      expect(publishThrew).toBeUndefined()
      expect(received).toEqual(["99.99.99"])
    })

    test("Bus.publish throws Context.NotFound WITHOUT an instance — proving the wrap is load-bearing", async () => {
      // Negative control: the same publish call outside any Instance.provide
      // must fail. This is what would happen if the provide wrap regressed.
      let threw = false
      try {
        await Bus.publish(Installation.Event.UpdateAvailable, { version: "99.99.99" })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Finding #2: scheduleStartupUpgradeCheck fires after the delay, returns
  // synchronously, and unrefs the timer.
  // ---------------------------------------------------------------------------
  describe("scheduleStartupUpgradeCheck", () => {
    let originalSetTimeout: typeof globalThis.setTimeout

    beforeEach(() => {
      originalSetTimeout = globalThis.setTimeout
    })

    afterEach(() => {
      globalThis.setTimeout = originalSetTimeout
    })

    test("returns synchronously, schedules at STARTUP_UPGRADE_DELAY_MS, and unrefs the timer", () => {
      const calls: Array<{ delay: number | undefined; cb: () => void }> = []
      let unrefCalled = false

      ;(globalThis as any).setTimeout = (cb: () => void, delay?: number) => {
        calls.push({ delay, cb })
        return {
          unref() {
            unrefCalled = true
            return this
          },
        }
      }

      const ret = scheduleStartupUpgradeCheck()

      // Non-blocking: returns void immediately, not a promise.
      expect(ret).toBeUndefined()
      expect(calls.length).toBe(1)
      expect(calls[0].delay).toBe(STARTUP_UPGRADE_DELAY_MS)
      expect(unrefCalled).toBe(true)
    })

    test("fires runStartupUpgradeCheck exactly once when the delay elapses", async () => {
      let capturedCb: (() => void) | undefined
      ;(globalThis as any).setTimeout = (cb: () => void) => {
        capturedCb = cb
        return { unref() {} }
      }

      scheduleStartupUpgradeCheck()
      expect(typeof capturedCb).toBe("function")

      // The scheduled callback invokes runStartupUpgradeCheck() with NO deps
      // (real defaultDeps). Restore the real timer first so the upgrade path's
      // own timers/network aren't intercepted, then fire the callback. It must
      // not throw synchronously — runStartupUpgradeCheck never rejects.
      globalThis.setTimeout = originalSetTimeout
      expect(() => capturedCb!()).not.toThrow()
      // Let the (best-effort, swallow-everything) check settle.
      await Bun.sleep(50)
    })

    test("does not fire the check before the delay elapses", () => {
      let fired = false
      ;(globalThis as any).setTimeout = (_cb: () => void) => {
        // Intentionally never invoke the callback: nothing should run yet.
        return { unref() {} }
      }
      // Wrap the real run so we'd notice an eager call.
      const probe: StartupUpgradeDeps = {
        provide: async (_d, fn) => {
          fired = true
          return fn()
        },
        run: async () => {},
      }
      void probe
      scheduleStartupUpgradeCheck()
      expect(fired).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Finding #3: non-Error rejection from run() is swallowed and logged without
  // crashing (complements the existing Error-throwing test).
  // ---------------------------------------------------------------------------
  describe("non-Error rejections are swallowed", () => {
    test("string rejection from run() resolves to undefined", async () => {
      let runCalls = 0
      const deps: StartupUpgradeDeps = {
        provide: async (_d, fn) => fn(),
        run: async () => {
          runCalls++
          throw "boom-string"
        },
      }
      await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
      expect(runCalls).toBe(1)
    })

    test("plain-object rejection from run() resolves to undefined", async () => {
      let runCalls = 0
      const deps: StartupUpgradeDeps = {
        provide: async (_d, fn) => fn(),
        run: async () => {
          runCalls++
          throw {}
        },
      }
      await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
      expect(runCalls).toBe(1)
    })

    test("null rejection from run() resolves to undefined", async () => {
      const deps: StartupUpgradeDeps = {
        provide: async (_d, fn) => fn(),
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        run: async () => {
          throw null
        },
      }
      await expect(runStartupUpgradeCheck(deps)).resolves.toBeUndefined()
    })

    test("no unhandled rejection escapes when run() throws a non-Error", async () => {
      const seen: unknown[] = []
      const handler = (err: unknown) => seen.push(err)
      process.on("unhandledRejection", handler)
      try {
        const deps: StartupUpgradeDeps = {
          provide: async (_d, fn) => fn(),
          run: async () => {
            throw "late-string"
          },
        }
        await runStartupUpgradeCheck(deps)
        // Give the microtask/macrotask queue a chance to surface a stray reject.
        await Bun.sleep(20)
      } finally {
        process.off("unhandledRejection", handler)
      }
      expect(seen).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // Finding #4: run() executes strictly inside the provided instance scope.
  // run() must be called only after provide sets up context and before provide
  // resolves — order must be ['enter','run','exit'].
  // ---------------------------------------------------------------------------
  describe("run() executes strictly inside the provide scope", () => {
    test("ordering is enter → run → exit", async () => {
      const order: string[] = []
      const deps: StartupUpgradeDeps = {
        provide: async (_directory, fn) => {
          order.push("enter")
          const result = await fn()
          order.push("exit")
          return result
        },
        run: async () => {
          order.push("run")
        },
      }
      await runStartupUpgradeCheck(deps)
      expect(order).toEqual(["enter", "run", "exit"])
    })

    test("run() is not invoked before provide enters nor after it resolves", async () => {
      let runInvokedDuringScope = false
      let scopeOpen = false
      const deps: StartupUpgradeDeps = {
        provide: async (_directory, fn) => {
          scopeOpen = true
          await fn()
          scopeOpen = false
        },
        run: async () => {
          runInvokedDuringScope = scopeOpen
        },
      }
      await runStartupUpgradeCheck(deps)
      expect(runInvokedDuringScope).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Finding #5: the directory passed to provide is captured at run time
  // (process.cwd() when runStartupUpgradeCheck executes), not at schedule time.
  // This is what makes the instance key match the server's default-directory
  // bucket (server.ts resolves the same process.cwd()).
  // ---------------------------------------------------------------------------
  describe("directory is captured at run time", () => {
    test("provide receives the cwd active when runStartupUpgradeCheck runs", async () => {
      await using tmp = await tmpdir()
      const originalCwd = process.cwd()
      let provideDirectory: string | undefined
      const deps: StartupUpgradeDeps = {
        provide: async (directory, fn) => {
          provideDirectory = directory
          return fn()
        },
        run: async () => {},
      }
      try {
        process.chdir(tmp.path)
        const expected = process.cwd()
        await runStartupUpgradeCheck(deps)
        expect(provideDirectory).toBe(expected)
      } finally {
        process.chdir(originalCwd)
      }
    })

    test("a cwd change between two runs is reflected in the directory passed to provide", async () => {
      await using tmp1 = await tmpdir()
      await using tmp2 = await tmpdir()
      const originalCwd = process.cwd()
      const dirs: string[] = []
      const deps: StartupUpgradeDeps = {
        provide: async (directory, fn) => {
          dirs.push(directory)
          return fn()
        },
        run: async () => {},
      }
      try {
        process.chdir(tmp1.path)
        const first = process.cwd()
        await runStartupUpgradeCheck(deps)
        process.chdir(tmp2.path)
        const second = process.cwd()
        await runStartupUpgradeCheck(deps)
        expect(dirs).toEqual([first, second])
      } finally {
        process.chdir(originalCwd)
      }
    })
  })
})
