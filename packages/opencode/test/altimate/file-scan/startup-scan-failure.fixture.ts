// Run only in a subprocess (see startup-scan-failure.test.ts): the parent gives it a PATH without
// ripgrep and a proxy that refuses connections, so ripgrep can be neither found nor downloaded.
import { expect, test } from "bun:test"

test("instance startup survives a file scan that cannot get ripgrep", async () => {
  const { tmpdir } = await import("../../fixture/fixture")
  const { bootstrap } = await import("../../../src/cli/bootstrap")
  const { Ripgrep } = await import("../../../src/file/ripgrep")
  await using dir = await tmpdir({ git: true })
  let started = false
  await bootstrap(dir.path, async () => {
    started = true
  })
  expect(started).toBe(true)
  // The scan bootstrap started shares this lookup, so it has failed too by the time this settles.
  // One more macrotask lets an unhandled rejection from that scan surface before the test ends.
  expect(await Ripgrep.filepath().then(() => "found", () => "failed")).toBe("failed")
  await new Promise((resolve) => setTimeout(resolve, 0))
})
