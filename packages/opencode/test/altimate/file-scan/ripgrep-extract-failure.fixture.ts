// Run only in a subprocess (see startup-scan-failure.test.ts): the parent gives it a PATH without
// ripgrep, and the test preload gives this process its own data directory, so ripgrep is installed there.
import { $ } from "bun"
import { expect, setSystemTime, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

test("a ripgrep extraction that fails partway leaves nothing behind, and the retry installs a working rg", async () => {
  const { tmpdir } = await import("../../fixture/fixture")
  const { Global } = await import("../../../src/global")
  const { Ripgrep } = await import("../../../src/file/ripgrep")

  // Two release-shaped archives: one cut off halfway through a 1 MiB `rg`, so tar writes part of it before
  // failing, and a whole one whose `rg` is a script.
  await using work = await tmpdir()
  const release = path.join(work.path, "ripgrep-release")
  await fs.mkdir(release)
  await fs.writeFile(path.join(release, "rg"), randomBytes(1 << 20))
  await $`tar -czf cut.tar.gz ripgrep-release`.cwd(work.path).quiet()
  const whole = await Bun.file(path.join(work.path, "cut.tar.gz")).arrayBuffer()
  const cut = whole.slice(0, whole.byteLength / 2)
  await fs.writeFile(path.join(release, "rg"), "#!/bin/sh\necho installed\n")
  await $`tar -czf good.tar.gz ripgrep-release`.cwd(work.path).quiet()
  const good = await Bun.file(path.join(work.path, "good.tar.gz")).arrayBuffer()

  let archive = cut
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(archive.slice(0))) as unknown as typeof fetch
  try {
    const failure = await Ripgrep.filepath().catch((error: unknown) => error)
    expect(Ripgrep.ExtractionFailedError.isInstance(failure)).toBe(true)
    // No partial `rg`, archive or staging directory is left for a later lookup to pick up.
    expect(await fs.readdir(Global.Path.bin)).toEqual([])

    archive = good
    setSystemTime(new Date(Date.now() + 60_000))
    const rg = await Ripgrep.filepath()
    expect(rg).toBe(path.join(Global.Path.bin, "rg"))
    expect((await $`${rg}`.text()).trim()).toBe("installed")
    expect(await fs.readdir(Global.Path.bin)).toEqual(["rg"])
  } finally {
    setSystemTime()
    globalThis.fetch = realFetch
  }
})
