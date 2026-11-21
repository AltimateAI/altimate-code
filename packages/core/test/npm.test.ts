import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { tmpdir } from "./fixture/tmpdir"

const win = process.platform === "win32"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

const npmLayer = (cache: string) =>
  Npm.layer.pipe(
    Layer.provide(EffectFlock.layer),
    Layer.provide(FSUtil.layer),
    Layer.provide(Global.layerWith({ cache, state: path.join(cache, "state") })),
    Layer.provide(NodeFileSystem.layer),
  )

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@opencode/acme")).toBe("@opencode/acme")
    expect(Npm.sanitize("@opencode/acme@1.0.0")).toBe("@opencode/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/opencode/acme.git"
    const expected = win ? "acme@git+https_//github.com/opencode/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.add", () => {
  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      main: "index.js",
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    await fs.mkdir(path.join(tmp.path, "cache", "packages", Npm.sanitize(spec)), { recursive: true })

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(Option.isSome(entry.entrypoint)).toBe(true)
  })
})

test("offline npm uses the cache and skips installation", async () => {
  await using tmp = await tmpdir()
  const cache = path.join(tmp.path, "cache")
  const dir = path.join(cache, "packages", "fixture", "node_modules", "fixture")
  await writePackage(dir, { name: "fixture", main: "index.js" })
  await Bun.write(path.join(dir, "index.js"), "export const fixture = true\n")
  const binary = path.join(path.dirname(dir), ".bin", "fixture")
  await Bun.write(binary, "fixture")
  const lock = path.join(cache, "packages", "not-in-cache", "package-lock.json")
  await Bun.write(lock, "{}")
  const before = process.env.ALTIMATE_OFFLINE
  process.env.ALTIMATE_OFFLINE = "1"
  try {
    await Effect.gen(function* () {
      const npm = yield* Npm.Service
      expect(Option.isSome((yield* npm.add("fixture")).entrypoint)).toBe(true)
      expect(yield* npm.which("fixture")).toEqual(Option.some(binary))
      expect(yield* npm.which("not-in-cache")).toEqual(Option.none())
      expect(yield* Effect.promise(() => Bun.file(lock).exists())).toBe(true)
      const missing = yield* Effect.flip(npm.add("not-in-cache"))
      expect(missing.cause).toEqual(new Error("Install not-in-cache while online."))
      yield* npm.install(tmp.path, { add: [{ name: "not-in-cache" }] })
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
    await expect(fs.stat(path.join(tmp.path, "node_modules"))).rejects.toThrow()
  } finally {
    if (before === undefined) delete process.env.ALTIMATE_OFFLINE
    else process.env.ALTIMATE_OFFLINE = before
  }
})

describe("Npm.install", () => {
  test("respects omit from project .npmrc", async () => {
    await using tmp = await tmpdir()

    await writePackage(tmp.path, {
      name: "fixture",
      dependencies: {
        "prod-pkg": "file:./prod-pkg",
      },
      devDependencies: {
        "dev-pkg": "file:./dev-pkg",
      },
    })
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit=dev\n")
    await fs.mkdir(path.join(tmp.path, "prod-pkg"))
    await fs.mkdir(path.join(tmp.path, "dev-pkg"))
    await writePackage(path.join(tmp.path, "prod-pkg"), { name: "prod-pkg" })
    await writePackage(path.join(tmp.path, "dev-pkg"), { name: "dev-pkg" })

    await Npm.install(tmp.path)

    await expect(fs.stat(path.join(tmp.path, "node_modules", "prod-pkg"))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "dev-pkg"))).rejects.toThrow()
  })
})
