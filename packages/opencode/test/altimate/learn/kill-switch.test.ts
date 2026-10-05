// altimate_change - new file
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Bus } from "../../../src/bus"
import { Config } from "../../../src/config/config"
import { Instance } from "../../../src/project/instance"
import * as Capture from "../../../src/altimate/learn/capture"
import { autoReflectSession } from "../../../src/altimate/learn/auto"
import { startScheduler } from "../../../src/altimate/learn/schedule"
import * as SessionReflect from "../../../src/altimate/learn/session-reflect"
import * as Signals from "../../../src/altimate/learn/signals"
import { tmpdir } from "../../fixture/fixture"

const keys = ["ALTIMATE_LEARN", "ALTIMATE_LEARN_CAPTURE", "ALTIMATE_LEARN_AUTO"]
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.ALTIMATE_LEARN_CAPTURE = "1"
  process.env.ALTIMATE_LEARN_AUTO = "1"
})
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

for (const source of ["config", "env"] as const) {
  describe(`learning disabled via ${source}`, () => {
    const config = { learn: { enabled: source !== "config", capture: true, auto_reflect: true } }

    beforeEach(() => {
      if (source === "env") process.env.ALTIMATE_LEARN = "false"
    })

    test("capture does not subscribe or create a signal store even with capture opted in", async () => {
      await using dir = await tmpdir({ git: true, config })
      await Instance.provide({ directory: dir.path, fn: async () => {
        await Config.get()
        const subscribe = spyOn(Bus, "subscribe")
        try {
          await Capture.startCapture(Instance.current)
          expect(subscribe).not.toHaveBeenCalled()
          expect(await fs.stat(path.join(dir.path, ".altimate-code", "learn")).catch(() => undefined)).toBeUndefined()
        } finally {
          subscribe.mockRestore()
        }
      } })
    })

    test("scheduler skips startup recovery and bus subscriptions even with auto-reflect opted in", async () => {
      await using dir = await tmpdir({ git: true, config })
      await Instance.provide({ directory: dir.path, fn: async () => {
        await Config.get()
        const signals = spyOn(Signals, "listSignals")
        const subscribe = spyOn(Bus, "subscribeAll")
        try {
          await startScheduler(Instance.current)
          expect(signals).not.toHaveBeenCalled()
          expect(subscribe).not.toHaveBeenCalled()
        } finally {
          signals.mockRestore()
          subscribe.mockRestore()
        }
      } })
    })

    test("run-end auto-reflection skips capture draining and reflection", async () => {
      await using dir = await tmpdir({ git: true, config })
      await Instance.provide({ directory: dir.path, fn: async () => {
        await Config.get()
        const flush = spyOn(Capture, "flushCapture")
        const reflect = spyOn(SessionReflect, "reflectSessionSignals").mockResolvedValue({ status: "none" })
        try {
          expect(await autoReflectSession("disabled-session", { waitForScheduled: true })).toBeUndefined()
          expect(flush).not.toHaveBeenCalled()
          expect(reflect).not.toHaveBeenCalled()
        } finally {
          flush.mockRestore()
          reflect.mockRestore()
        }
      } })
    })
  })
}
