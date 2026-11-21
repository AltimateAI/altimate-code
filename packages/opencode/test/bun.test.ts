import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "./fixture/fixture"

describe("BunProc registry configuration", () => {
  test("should not contain hardcoded registry parameters", async () => {
    // Read the bun/index.ts file
    const bunIndexPath = path.join(__dirname, "../src/bun/index.ts")
    const content = await fs.readFile(bunIndexPath, "utf-8")

    // Verify that no hardcoded registry is present
    expect(content).not.toContain("--registry=")
    expect(content).not.toContain("hasNpmRcConfig")
    expect(content).not.toContain("NpmRc")
  })

  test("should use Bun's default registry resolution", async () => {
    // Read the bun/index.ts file
    const bunIndexPath = path.join(__dirname, "../src/bun/index.ts")
    const content = await fs.readFile(bunIndexPath, "utf-8")

    // Verify that it uses Bun's default resolution
    expect(content).toContain("Bun's default registry resolution")
    expect(content).toContain("Bun will use them automatically")
    expect(content).toContain("No need to pass --registry flag")
  })

  test("should have correct command structure without registry", async () => {
    // Read the bun/index.ts file
    const bunIndexPath = path.join(__dirname, "../src/bun/index.ts")
    const content = await fs.readFile(bunIndexPath, "utf-8")

    // Extract the install function
    const installFunctionMatch = content.match(/export async function install[\s\S]*?^  }/m)
    expect(installFunctionMatch).toBeTruthy()

    if (installFunctionMatch) {
      const installFunction = installFunctionMatch[0]

      // Verify expected arguments are present
      expect(installFunction).toContain('"add"')
      expect(installFunction).toContain('"--force"')
      expect(installFunction).toContain('"--exact"')
      expect(installFunction).toContain('"--cwd"')
      expect(installFunction).toContain("Global.Path.cache")
      expect(installFunction).toContain('pkg + "@" + version')

      // Verify no registry argument is added
      expect(installFunction).not.toContain('"--registry"')
      expect(installFunction).not.toContain('args.push("--registry')
    }
  })
})

describe("BunProc offline cache", () => {
  test("accepts latest and matching cached versions, rejects misses, and preserves malformed metadata", async () => {
    const { BunProc } = await import("../src/bun")
    const { Global } = await import("../src/global")
    const { spyOn } = await import("bun:test")
    const prior = process.env.ALTIMATE_OFFLINE
    const originalCache = Global.Path.cache
    await using tmp = await tmpdir()
    const cache = tmp.path
    Global.Path.cache = cache
    process.env.ALTIMATE_OFFLINE = "1"
    const run = spyOn(BunProc, "run").mockImplementation(async () => {
      throw new Error("must not install")
    })
    try {
      const pkg = "@test/cached"
      const mod = path.join(cache, "node_modules", pkg)
      const metadata = path.join(cache, "package.json")
      await fs.mkdir(mod, { recursive: true })
      await fs.writeFile(metadata, JSON.stringify({ dependencies: { [pkg]: "1.2.3" } }))
      expect(await BunProc.install(pkg)).toBe(mod)
      expect(await BunProc.install(pkg, "1.2.3")).toBe(mod)
      await expect(BunProc.install(pkg, "2.0.0")).rejects.toThrow(`Install ${pkg} while online.`)
      await expect(BunProc.install("missing")).rejects.toThrow("Install missing while online.")
      await fs.rm(mod, { recursive: true })
      await expect(BunProc.install(pkg)).rejects.toThrow(`Install ${pkg} while online.`)
      for (const content of [undefined, "{invalid json"]) {
        if (content === undefined) await fs.rm(metadata)
        else await fs.writeFile(metadata, content)
        await expect(BunProc.install(pkg)).rejects.toThrow(`Install ${pkg} while online.`)
        expect(await fs.readFile(metadata, "utf8").catch(() => undefined)).toBe(content)
      }
      expect(run).not.toHaveBeenCalled()
    } finally {
      run.mockRestore()
      Global.Path.cache = originalCache
      if (prior === undefined) delete process.env.ALTIMATE_OFFLINE
      else process.env.ALTIMATE_OFFLINE = prior
    }
  })
})
