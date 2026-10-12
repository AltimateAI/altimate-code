// altimate_change - new file
// Run only in a subprocess so other tests cannot preload the capture module.
import { expect, test } from "bun:test"

let captureImports = 0
let captureStarts = 0
let schedulerImports = 0
let schedulerStarts = 0
Bun.plugin({
  name: "capture import probe",
  setup(builder) {
    builder.onLoad({ filter: /[/\\]learn[/\\]capture\.ts$/ }, () => {
      captureImports++
      return { loader: "object", exports: { startCapture: async () => { captureStarts++ } } }
    })
    builder.onLoad({ filter: /[/\\]learn[/\\]schedule\.ts$/ }, () => {
      schedulerImports++
      return { loader: "object", exports: { startScheduler: async () => { schedulerStarts++ } } }
    })
  },
})

test("bootstrap gates capture imports on env and already loaded config", async () => {
  const { tmpdir } = await import("../../fixture/fixture")
  const { bootstrap } = await import("../../../src/cli/bootstrap")
  delete process.env.ALTIMATE_LEARN
  process.env.ALTIMATE_LEARN_CAPTURE = "1"
  process.env.ALTIMATE_LEARN_AUTO = "1"
  const disabledConfig = { learn: { enabled: false, capture: true, auto_reflect: true } }
  await using configOff = await tmpdir({ git: true, config: disabledConfig })
  await bootstrap(configOff.path, async () => {})
  expect(captureImports).toBe(0)
  expect(captureStarts).toBe(0)
  expect(schedulerImports).toBe(0)
  expect(schedulerStarts).toBe(0)

  process.env.ALTIMATE_LEARN = "FALSE"
  const enabledConfig = { learn: { enabled: true, capture: true, auto_reflect: true } }
  await using envOff = await tmpdir({ git: true, config: enabledConfig })
  await bootstrap(envOff.path, async () => {})
  expect(captureImports).toBe(0)
  expect(captureStarts).toBe(0)
  expect(schedulerImports).toBe(0)
  expect(schedulerStarts).toBe(0)

  delete process.env.ALTIMATE_LEARN
  delete process.env.ALTIMATE_LEARN_CAPTURE
  delete process.env.ALTIMATE_LEARN_AUTO
  await using disabled = await tmpdir({ git: true, config: { learn: { capture: false } } })
  await bootstrap(disabled.path, async () => {})
  expect(captureImports).toBe(0)
  expect(captureStarts).toBe(0)
  expect(schedulerImports).toBe(0)
  expect(schedulerStarts).toBe(0)

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
  expect(schedulerImports).toBe(0)
  expect(Config.peek(initial)).toBeUndefined()

  process.env.ALTIMATE_LEARN_AUTO = "0"
  await using captureOnly = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true } } })
  await bootstrap(captureOnly.path, async () => {})
  expect(schedulerImports).toBe(0)

  delete process.env.ALTIMATE_LEARN_AUTO
  await using automatic = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true } } })
  await bootstrap(automatic.path, async () => {})
  expect(schedulerImports).toBe(1)
  expect(schedulerStarts).toBe(1)

  process.env.ALTIMATE_LEARN_CAPTURE = "false"
  await using noCapture = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true } } })
  await bootstrap(noCapture.path, async () => {})
  expect(schedulerStarts).toBe(1)
}, 20_000)
