import { $ } from "bun"
import type { BunPlugin } from "bun"
import { createRequire } from "node:module"
import path from "node:path"

// H5 validates only this target. Do not silently publish other targets without their native closure.
export async function distributionPlugin(target: { os: string; arch: string; outdir: string }): Promise<BunPlugin> {
  if (target.os !== "darwin" || target.arch !== "arm64")
    throw new Error("Altimate artifact packaging is currently validated only for darwin-arm64")

  const driver = createRequire(path.resolve(import.meta.dirname, "../../drivers/package.json"))
  const api = driver.resolve("@duckdb/node-api/package.json")
  const bindings = createRequire(api).resolve("@duckdb/node-bindings/package.json")
  const native = createRequire(bindings).resolve("@duckdb/node-bindings-darwin-arm64/package.json")
  const root = path.join(target.outdir, "lib/altimate/drivers/node_modules/@duckdb")
  const result = await Bun.build({
    entrypoints: [driver.resolve("@duckdb/node-api")],
    target: "bun",
    format: "cjs",
    minify: true,
    external: ["@duckdb/node-bindings"],
    outdir: path.join(root, "node-api/lib"),
  })
  if (!result.success) throw new AggregateError(result.logs, "Failed to bundle DuckDB API")

  for (const [manifest, name, files] of [
    [api, "node-api", ["package.json", "LICENSE"]],
    [bindings, "node-bindings", ["package.json", "LICENSE", "duckdb.js"]],
    [native, "node-bindings-darwin-arm64", ["package.json", "LICENSE", "duckdb.node"]],
  ] as const) {
    await Promise.all(
      files.map((file) => Bun.write(path.join(root, name, file), Bun.file(path.join(path.dirname(manifest), file)))),
    )
  }
  // The npm dylib is universal; retain only the architecture this artifact ships.
  await $`lipo ${path.join(path.dirname(native), "libduckdb.dylib")} -thin arm64 -output ${path.join(root, "node-bindings-darwin-arm64/libduckdb.dylib")}`

  return {
    name: "altimate-artifact",
    setup(build) {
      build.config.define = { ...build.config.define, "globalThis.__ALTIMATE_DRIVER_ARTIFACT__": "true" }
      build.config.entrypoints = [path.resolve(import.meta.dirname, "artifact-entry.ts")]
    },
  }
}
