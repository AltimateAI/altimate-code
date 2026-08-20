/**
 * The set of optional warehouse SDKs is declared in four places that must agree.
 * They had already drifted: `mongodb` was in the drivers workspace and had a
 * driver module, but was missing from the binary's externals (so it would be
 * bundled instead of installed on demand) and from the published package's
 * optional peer dependencies (so `npm ls` never mentioned it).
 *
 * DRIVER_PACKAGES in packages/drivers/src/resolve.ts is the source of truth;
 * this test holds the other three to it.
 */
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { DRIVER_PACKAGES } from "@altimateai/drivers/resolve"
import { driverForWarehouseType } from "../../src/altimate/tools/warehouse-install-driver"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const driversPkgPath = path.join(repoRoot, "packages/drivers/package.json")
const buildScriptPath = path.join(repoRoot, "packages/opencode/script/build.ts")
const publishScriptPath = path.join(repoRoot, "packages/opencode/script/publish.ts")

/** Every npm package any driver needs, deduplicated (postgres and redshift share `pg`). */
const expectedPackages = [...new Set(Object.values(DRIVER_PACKAGES).flat())].sort()

/** Optional infra externals that are not warehouse drivers. */
const NON_DRIVER_EXTERNALS = new Set(["keytar", "ssh2", "dockerode", "@azure/identity"])

/** Names inside a `const X = [ "a", "b" ] as const` literal. */
function readLiteralList(source: string, marker: string): string[] {
  const start = source.indexOf(marker)
  expect(start, `${marker} not found`).toBeGreaterThan(-1)
  const end = source.indexOf("]", start)
  return [...source.slice(start + marker.length, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

function readBlock(file: string, startMarker: string, endMarker: string): string {
  const source = fs.readFileSync(file, "utf8")
  const start = source.indexOf(startMarker)
  expect(start, `${startMarker} not found in ${path.basename(file)}`).toBeGreaterThan(-1)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(-1)
  return source.slice(start + startMarker.length, end)
}

describe("driver catalogue consistency", () => {
  test("the drivers workspace declares every driver package as an optional dependency", () => {
    const manifest = JSON.parse(fs.readFileSync(driversPkgPath, "utf8"))
    const declared = Object.keys(manifest.optionalDependencies ?? {}).sort()

    expect(declared).toEqual(expectedPackages)
  })

  test("the binary build marks every driver package external", () => {
    // A driver package missing from `external` is bundled into the binary, which
    // freezes it at the release's version and bypasses on-demand install.
    const block = readBlock(buildScriptPath, "const optionalExternals = [", "]")
    const listed = [...block.matchAll(/"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((name) => !NON_DRIVER_EXTERNALS.has(name))
      .sort()

    expect(listed).toEqual(expectedPackages)
  })

  test("the published package lists every driver package as an optional peer dependency", () => {
    const block = readBlock(
      publishScriptPath,
      "const driverPeerDependencies: Record<string, string> = {",
      "\n}",
    )
    const listed = [...block.matchAll(/^\s*"?([@\w\-/.]+)"?\s*:/gm)].map((m) => m[1]!).sort()

    expect(listed).toEqual(expectedPackages)
  })

  test("every driver package resolves to at least one driver module", () => {
    for (const driver of Object.keys(DRIVER_PACKAGES)) {
      const modulePath = path.join(repoRoot, "packages/drivers/src", `${driver}.ts`)
      expect(fs.existsSync(modulePath), `packages/drivers/src/${driver}.ts is missing`).toBe(true)
    }
  })

  test("every driver module that loads an optional SDK is in the catalogue", () => {
    // Guards the other direction: a new driver file that imports an SDK but is
    // never registered would silently have no install path.
    const dir = path.join(repoRoot, "packages/drivers/src")
    const registered = new Set(Object.keys(DRIVER_PACKAGES))
    const skip = new Set(["index", "types", "normalize", "resolve", "sqlite"])

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue
      const name = file.slice(0, -3)
      if (skip.has(name)) continue
      const source = fs.readFileSync(path.join(dir, file), "utf8")
      if (!source.includes("loadOptionalDriver")) continue
      expect(registered.has(name), `${file} loads an optional SDK but is not in DRIVER_PACKAGES`).toBe(true)
    }
  })

  test("the install tool's DRIVER_NAMES matches DRIVER_PACKAGES", () => {
    // The tool declares its zod enum literally so the parameter type is a
    // concrete union. Nothing pinned it to the catalogue until now, so a new
    // driver could be installable by the resolver but unreachable by the tool.
    const toolSource = fs.readFileSync(
      path.join(repoRoot, "packages/opencode/src/altimate/tools/warehouse-install-driver.ts"),
      "utf8",
    )
    const names = [...readLiteralList(toolSource, "const DRIVER_NAMES = [")].sort()

    expect(names).toEqual(Object.keys(DRIVER_PACKAGES).sort())
  })

  test("every registry warehouse type maps to a driver the tool can install", () => {
    // DRIVER_MAP accepts aliases (postgresql, mariadb, mssql, fabric, mongo).
    // Each must resolve through driverForWarehouseType or a connection added
    // under that alias silently skips the readiness check added for #61.
    const registry = fs.readFileSync(
      path.join(repoRoot, "packages/opencode/src/altimate/native/connections/registry.ts"),
      "utf8",
    )
    const mapBlock = registry.slice(
      registry.indexOf("const DRIVER_MAP: Record<string, string> = {"),
      registry.indexOf("}", registry.indexOf("const DRIVER_MAP: Record<string, string> = {")),
    )
    const types = [...mapBlock.matchAll(/^\s*([a-z0-9]+)\s*:/gm)].map((m) => m[1]!)

    expect(types.length).toBeGreaterThan(12)
    for (const type of types) {
      // sqlite is bundled with the runtime and needs no optional SDK.
      if (type === "sqlite") continue
      expect(driverForWarehouseType(type), `registry type "${type}" has no installable driver`).toBeDefined()
    }
  })
})
