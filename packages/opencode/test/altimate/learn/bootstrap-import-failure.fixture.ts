// Run only in a subprocess so the failed import cannot affect other tests.
import { expect, test } from "bun:test"

const failing = process.env.LEARN_FAIL_IMPORT
let attempted = false
Bun.plugin({
  name: "learning startup import failure",
  setup(builder) {
    builder.onLoad({ filter: /[/\\]learn[/\\](capture|schedule)\.ts$/ }, (args) => {
      if (args.path.endsWith(`${failing}.ts`)) {
        attempted = true
        throw new Error(`Cannot import ${failing}`)
      }
      return { loader: "object", exports: { startCapture: async () => {}, startScheduler: async () => {} } }
    })
  },
})

test(`instance bootstrap survives a failed ${failing} import`, async () => {
  const { tmpdir } = await import("../../fixture/fixture")
  const { bootstrap } = await import("../../../src/cli/bootstrap")
  process.env.ALTIMATE_LEARN_CAPTURE = "1"
  process.env.ALTIMATE_LEARN_AUTO = "1"
  await using dir = await tmpdir({ git: true })
  let started = false
  await bootstrap(dir.path, async () => { started = true })
  expect(attempted).toBe(true)
  expect(started).toBe(true)
})
