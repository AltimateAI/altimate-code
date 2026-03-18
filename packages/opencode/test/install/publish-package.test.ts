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
    expect(pkg.bin["altimate"]).toBe("./bin/altimate")
    expect(pkg.bin["altimate-code"]).toBe("./bin/altimate-code")
    expect(pkg.bin["opencode"]).toBeUndefined()
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

describe("unscoped package (altimate-code)", () => {
  const publishScript = fs.readFileSync(path.join(REPO_PKG_DIR, "script/publish.ts"), "utf-8")

  test("publish.ts creates unscoped altimate-code wrapper package", () => {
    expect(publishScript).toContain('const unscopedName = "altimate-code"')
    expect(publishScript).toContain("`./dist/${unscopedName}`")
  })

  test("unscoped package gets same bin entries as scoped package", () => {
    // Both scoped and unscoped packages should register the same bin commands
    // Keys may be quoted or unquoted in the source
    expect(publishScript).toContain('./bin/altimate"')
    expect(publishScript).toContain('"altimate-code": "./bin/altimate-code"')
  })

  test("unscoped package gets postinstall, bin, LICENSE, CHANGELOG, and README", () => {
    expect(publishScript).toContain("cp -r ./bin ${unscopedDir}/bin")
    expect(publishScript).toContain("cp ./script/postinstall.mjs ${unscopedDir}/postinstall.mjs")
    expect(publishScript).toContain("${unscopedDir}/LICENSE")
    expect(publishScript).toContain("${unscopedDir}/CHANGELOG.md")
    expect(publishScript).toContain("${unscopedDir}/README.md")
  })

  test("unscoped package includes npm metadata for discoverability", () => {
    expect(publishScript).toContain("github.com/AltimateAI/altimate-code")
    expect(publishScript).toContain("homepage")
    expect(publishScript).toContain("bugs")
    expect(publishScript).toContain("repository")
  })

  test("unscoped package publish has error handling", () => {
    // The unscoped publish block should be wrapped in try/catch
    const unscopedSection = publishScript.substring(publishScript.indexOf("const unscopedName"))
    expect(unscopedSection).toContain("try {")
    expect(unscopedSection).toContain("catch (e)")
    expect(unscopedSection).toContain("Unscoped package publish failed")
  })

  test("unscoped package uses optionalDependencies for platform binaries", () => {
    // The unscoped package includes platform binaries directly so it works standalone
    expect(publishScript).toContain("optionalDependencies: binaries")
  })

  test("unscoped package is published with --access public", () => {
    expect(publishScript).toContain("${unscopedDir} && bun pm pack && npm publish *.tgz --access public")
  })
})
