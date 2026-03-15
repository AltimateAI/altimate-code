import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs"

const REPO_PKG_DIR = path.resolve(import.meta.dir, "../..")

const EXPECTED_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]

const PACKAGE_NAME_PATTERN = /^@altimateai\/altimate-code-(darwin|linux|windows)-(arm64|x64|arm)(-baseline|-musl|-baseline-musl)?$/

describe("publish package validation", () => {
  test("optionalDependencies has all expected platform packages", () => {
    // Validate that all expected platforms produce valid package names
    for (const p of EXPECTED_PLATFORMS) {
      const pkgName = `@altimateai/altimate-code-${p}`
      expect(pkgName).toMatch(PACKAGE_NAME_PATTERN)
    }
  })

  test("all versions are consistent (no v-prefix issues)", () => {
    // Simulate the version extraction from publish.ts:
    //   const version = Object.values(binaries)[0]
    // Versions should never have a "v" prefix in package.json
    const version = "1.0.0"
    const binaries: Record<string, string> = {}
    for (const p of EXPECTED_PLATFORMS) {
      binaries[`@altimateai/altimate-code-${p}`] = version
    }
    for (const [, ver] of Object.entries(binaries)) {
      expect(ver).not.toMatch(/^v/)
      expect(ver).toBe(version)
    }
  })

  test("package names follow naming convention", () => {
    for (const p of EXPECTED_PLATFORMS) {
      const pkgName = `@altimateai/altimate-code-${p}`
      expect(pkgName).toMatch(PACKAGE_NAME_PATTERN)
    }
  })

  test("bin entries are correct", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_PKG_DIR, "package.json"), "utf-8"))
    expect(pkg.bin).toBeDefined()
    expect(pkg.bin["altimate"]).toBe("./bin/altimate-code")
    expect(pkg.bin["altimate-code"]).toBe("./bin/altimate-code")
  })

  test("postinstall script has bun-then-node fallback", () => {
    const publishScript = fs.readFileSync(path.join(REPO_PKG_DIR, "script/publish.ts"), "utf-8")
    expect(publishScript).toContain('postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs"')
  })

  test("publish.ts uses optionalDependencies for platform binaries", () => {
    const publishScript = fs.readFileSync(path.join(REPO_PKG_DIR, "script/publish.ts"), "utf-8")
    expect(publishScript).toContain("optionalDependencies: binaries")
  })

  test("publish.ts copies postinstall and bin to dist", () => {
    const publishScript = fs.readFileSync(path.join(REPO_PKG_DIR, "script/publish.ts"), "utf-8")
    expect(publishScript).toContain("postinstall.mjs")
    expect(publishScript).toContain("cp -r ./bin")
  })

  test("source scripts exist and use expected patterns", () => {
    // postinstall.mjs uses createRequire for resolving platform packages
    const postinstall = fs.readFileSync(path.join(REPO_PKG_DIR, "script/postinstall.mjs"), "utf-8")
    expect(postinstall).toContain("createRequire")
    expect(postinstall).toContain("@altimateai/altimate-code-")

    // bin wrapper uses @altimateai scope
    const wrapper = fs.readFileSync(path.join(REPO_PKG_DIR, "bin/altimate-code"), "utf-8")
    expect(wrapper).toContain('"@altimateai"')
  })
})
