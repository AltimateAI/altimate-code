import { describe, test, expect } from "bun:test"
import { FileIgnore } from "../../src/file/ignore"

test("match nested and non-nested", () => {
  expect(FileIgnore.match("node_modules/index.js")).toBe(true)
  expect(FileIgnore.match("node_modules")).toBe(true)
  expect(FileIgnore.match("node_modules/")).toBe(true)
  expect(FileIgnore.match("node_modules/bar")).toBe(true)
  expect(FileIgnore.match("node_modules/bar/")).toBe(true)
})

describe("FileIgnore.match: directory and file patterns", () => {
  test("matches registered directory patterns beyond node_modules", () => {
    expect(FileIgnore.match("dist/bundle.js")).toBe(true)
    expect(FileIgnore.match("build/output.css")).toBe(true)
    expect(FileIgnore.match(".git/config")).toBe(true)
    expect(FileIgnore.match("__pycache__/module.pyc")).toBe(true)
    expect(FileIgnore.match(".next/server/pages")).toBe(true)
    expect(FileIgnore.match("out/index.html")).toBe(true)
    expect(FileIgnore.match("bin/cli")).toBe(true)
    // "desktop" is in FOLDERS — broad match, verify it works as specified
    expect(FileIgnore.match("desktop/app.js")).toBe(true)
  })

  test("matches file glob patterns", () => {
    expect(FileIgnore.match("src/editor.swp")).toBe(true)
    expect(FileIgnore.match("deep/nested/file.swp")).toBe(true)
    expect(FileIgnore.match("src/.DS_Store")).toBe(true)
    expect(FileIgnore.match("cache.pyc")).toBe(true)
    expect(FileIgnore.match("logs/app.log")).toBe(true)
    expect(FileIgnore.match("tmp/upload.bin")).toBe(true)
  })

  test("does not match normal source files", () => {
    expect(FileIgnore.match("src/index.ts")).toBe(false)
    expect(FileIgnore.match("README.md")).toBe(false)
    expect(FileIgnore.match("package.json")).toBe(false)
    expect(FileIgnore.match("lib/utils.js")).toBe(false)
  })

  test("whitelist overrides directory match", () => {
    expect(FileIgnore.match("node_modules/my-package/index.js", { whitelist: ["node_modules/**"] })).toBe(false)
  })

  test("extra patterns extend matching", () => {
    expect(FileIgnore.match("config/.env")).toBe(false)
    expect(FileIgnore.match("config/.env", { extra: ["**/.env"] })).toBe(true)
  })

  test("handles Windows-style path separators", () => {
    expect(FileIgnore.match("node_modules\\package\\index.js")).toBe(true)
    expect(FileIgnore.match("src\\.git\\config")).toBe(true)
  })
})
