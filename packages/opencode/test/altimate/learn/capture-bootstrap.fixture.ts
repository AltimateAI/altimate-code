// altimate_change - new file
// Run only in a subprocess so other tests cannot preload the capture module.
import { expect, test } from "bun:test"

let captureImports = 0
let captureStarts = 0
Bun.plugin({
  name: "capture import probe",
  setup(builder) {
    builder.onLoad({ filter: /[/\\]learn[/\\]capture\.ts$/ }, () => {
      captureImports++
      return { loader: "object", exports: { startCapture: async () => { captureStarts++ } } }
    })
  },
})

test("bootstrap gates capture imports on env and already loaded config", async () => {
  const { tmpdir } = await import("../../fixture/fixture")
  const { bootstrap } = await import("../../../src/cli/bootstrap")
  delete process.env.ALTIMATE_LEARN_CAPTURE
  await using disabled = await tmpdir({ git: true, config: { learn: { capture: false } } })
  await bootstrap(disabled.path, async () => {})
  expect(captureImports).toBe(0)
  expect(captureStarts).toBe(0)

  process.env.ALTIMATE_LEARN_CAPTURE = "0"
  await using overridden = await tmpdir({ git: true, config: { learn: { capture: true } } })
  await bootstrap(overridden.path, async () => {})
  expect(captureImports).toBe(0)
  expect(captureStarts).toBe(0)

  delete process.env.ALTIMATE_LEARN_CAPTURE
  await using enabled = await tmpdir({ git: true, config: { learn: { capture: true } } })
  const { Instance } = await import("../../../src/project/instance")
  const { Config } = await import("../../../src/config/config")
  const initial = await Instance.provide({ directory: enabled.path, fn: async () => {
    expect((await Config.get()).learn?.capture).toBe(true)
    return Instance.current
  } })
  await bootstrap(enabled.path, async () => {
    expect(Instance.current).not.toBe(initial)
    expect(Config.peek(Instance.current)?.learn?.capture).toBe(true)
  })
  expect(captureImports).toBe(1)
  expect(captureStarts).toBe(1)
  expect(Config.peek(initial)).toBeUndefined()
})
