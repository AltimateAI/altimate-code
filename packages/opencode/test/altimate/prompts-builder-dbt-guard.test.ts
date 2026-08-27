import { describe, expect, test } from "bun:test"
import path from "path"
import { readFileSync } from "fs"

// builder.txt itself says "Never call raw `dbt` directly (except `dbt deps`)" —
// a prior revision of the Finish Protocol section told agents to run `dbt build`
// as its own example, directly contradicting that rule and risking the agent
// literally running the prohibited raw command. Guard against that regression.
const BUILDER_PROMPT_PATH = path.join(import.meta.dir, "../../src/altimate/prompts/builder.txt")

describe("altimate/prompts/builder.txt", () => {
  test("never instructs a raw `dbt` subcommand other than `dbt deps`", () => {
    const text = readFileSync(BUILDER_PROMPT_PATH, "utf-8")
    const rawDbtCommand = /`dbt (?!deps\b)[a-z-]+/g
    const matches = text.match(rawDbtCommand) ?? []
    expect(matches).toEqual([])
  })
})
