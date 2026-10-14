// Run only in a subprocess (see startup-scan-failure.test.ts): the parent gives it a PATH without
// ripgrep, and the test preload gives this process its own data directory, so no cached ripgrep is found.
import { expect, setSystemTime, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("a startup scan that cannot get ripgrep is handled, and a search recovers after the retry cooldown", async () => {
  const { tmpdir } = await import("../../fixture/fixture")
  const { bootstrap } = await import("../../../src/cli/bootstrap")
  const { Ripgrep } = await import("../../../src/file/ripgrep")
  const { File } = await import("../../../src/file")

  // Every ripgrep download fails, as it does offline. Counting the attempts shows when a lookup is retried.
  let downloads = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes("BurntSushi/ripgrep")) return realFetch(input, init)
    downloads++
    throw new TypeError("network is unreachable")
  }) as typeof fetch
  // Moving the clock past the retry cooldown lets a failed lookup run again.
  const later = (() => {
    let now = Date.now()
    return () => setSystemTime(new Date((now += 60_000)))
  })()

  await using dir = await tmpdir({ git: true })
  await using fake = await tmpdir()
  let found: string[] = []
  try {
    await bootstrap(dir.path, async () => {
      // This call shares the startup scan's lookup, or meets its failure inside the cooldown. Either way
      // there is one download attempt. One more macrotask lets an unhandled rejection from that scan
      // surface while the test runs.
      expect(
        await Ripgrep.filepath().then(
          () => "found",
          () => "failed",
        ),
      ).toBe("failed")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(downloads).toBe(1)

      // Inside the cooldown a search fails at once, without another download.
      expect(
        await File.search({ query: "recovered" }).then(
          () => "ok",
          () => "failed",
        ),
      ).toBe("failed")
      expect(downloads).toBe(1)

      // After the cooldown the lookup runs again. The failed scan is not kept either.
      later()
      expect(
        await File.search({ query: "recovered" }).then(
          () => "ok",
          () => "failed",
        ),
      ).toBe("failed")
      expect(downloads).toBe(2)

      // Ripgrep becomes available: a stand-in that lists one file. After the next cooldown it is found.
      await fs.writeFile(path.join(fake.path, "rg"), "#!/bin/sh\necho recovered.txt\n", { mode: 0o755 })
      process.env.PATH = `${fake.path}${path.delimiter}${process.env.PATH}`
      later()
      found = await File.search({ query: "recovered", type: "file" })
    })
  } finally {
    setSystemTime()
    globalThis.fetch = realFetch
  }
  expect(found).toContain("recovered.txt")
  expect(downloads).toBe(2)
})
