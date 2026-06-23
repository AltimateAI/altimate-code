import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, statSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const vscodeImages = ["button-dark.svg", "button-light.svg", "icon.png"]

describe("release archive assets", () => {
  test("VS Code images are self-contained regular files", () => {
    for (const name of vscodeImages) {
      const asset = path.join(root, "sdks/vscode/images", name)
      expect(existsSync(asset)).toBe(true)
      expect(lstatSync(asset).isSymbolicLink()).toBe(false)
      expect(statSync(asset).size).toBeGreaterThan(0)
    }
  })
})
