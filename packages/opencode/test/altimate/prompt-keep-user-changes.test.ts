import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PromptProfiles } from "../../src/altimate/prompts/profiles"

const promptFile = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "../../src/session/prompt", `${name}.txt`), "utf8")

describe("prompts keep the user's changes", () => {
  for (const [name, text] of [
    ["builder", PromptProfiles.PROMPT_BUILDER],
    ["anthropic", promptFile("anthropic")],
    ["qwen", promptFile("qwen")],
    ["trinity", promptFile("trinity")],
    ["beast", promptFile("beast")],
  ] as const) {
    test(`${name} prompt forbids reverting user changes and says to ask when unclear`, () => {
      expect(text).toContain("unless the user explicitly asks you to")
      expect(text).toContain("never delete or weaken assertions")
      expect(text).toContain("ask before undoing it")
    })
  }
})
