// Run only in a subprocess (see startup-scan-failure.test.ts): the parent gives it a PATH without
// ripgrep and a proxy that refuses connections, so ripgrep can be neither found nor downloaded.
// The test preload gives this process its own data directory, so no cached ripgrep is found there.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("a startup scan that cannot get ripgrep is handled, and a later search recovers", async () => {
  const { tmpdir } = await import("../../fixture/fixture")
  const { bootstrap } = await import("../../../src/cli/bootstrap")
  const { Ripgrep } = await import("../../../src/file/ripgrep")
  const { File } = await import("../../../src/file")
  await using dir = await tmpdir({ git: true })
  await using fake = await tmpdir()
  let found: string[] = []
  await bootstrap(dir.path, async () => {
    // The scan bootstrap started shares this lookup, so it has failed too by the time this settles.
    // One more macrotask lets an unhandled rejection from that scan surface while the test runs.
    expect(await Ripgrep.filepath().then(() => "found", () => "failed")).toBe("failed")
    await new Promise((resolve) => setTimeout(resolve, 0))

    // While ripgrep is still unavailable a search fails, and that failure must not stick.
    expect(await File.search({ query: "recovered" }).then(() => "ok", () => "failed")).toBe("failed")

    // Ripgrep becomes available: a stand-in that lists one file.
    await fs.writeFile(path.join(fake.path, "rg"), "#!/bin/sh\necho recovered.txt\n", { mode: 0o755 })
    process.env.PATH = `${fake.path}${path.delimiter}${process.env.PATH}`
    found = await File.search({ query: "recovered", type: "file" })
  })
  expect(found).toContain("recovered.txt")
})
