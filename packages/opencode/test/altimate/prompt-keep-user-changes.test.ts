import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PromptProfiles } from "../../src/altimate/prompts/profiles"

const anthropic = fs.readFileSync(path.join(import.meta.dir, "../../src/session/prompt/anthropic.txt"), "utf8")

describe("prompts keep the user's changes", () => {
  for (const [name, text] of [
    ["builder", PromptProfiles.PROMPT_BUILDER],
    ["anthropic", anthropic],
  ] as const) {
    test(`${name} prompt forbids reverting user changes and says to ask when unclear`, () => {
      expect(text).toContain("never revert the user's change")
      expect(text).toContain("fix the test or the callers, or ask")
      expect(text).toContain("ask before undoing it")
    })
  }
})
