// altimate_change start — upstream_fix (#701): the blank-variable record had no tests at all,
// which is how three separate placement mistakes reached review. These pin the contract every
// call site has to honour: substitution UNIONS into a source, and only a reset clears it.
import { describe, expect, test, beforeEach } from "bun:test"
import { ConfigVariable } from "@/config/variable"

const SOURCE = "/virtual/blanked-env-test/config.json"
const VAR = "ALTIMATE_TEST_BLANKED_VAR"
const OTHER = "ALTIMATE_TEST_BLANKED_VAR_TWO"

function namesFor(source: string): string[] {
  return ConfigVariable.blankedEnvVars().find((e) => e.source === source)?.names ?? []
}

async function substitute(text: string) {
  return ConfigVariable.substitute({ text, type: "virtual", dir: "/virtual", source: SOURCE, env: {} })
}

describe("blankedEnvVars", () => {
  beforeEach(() => {
    delete process.env[VAR]
    delete process.env[OTHER]
    ConfigVariable.resetBlankedEnvVars(SOURCE)
  })

  test("records a {env:VAR} that resolved to empty", async () => {
    await substitute(`{"token":"{env:${VAR}}"}`)
    expect(namesFor(SOURCE)).toContain(VAR)
  })

  test("unions across substitutions of one source instead of replacing", async () => {
    // A remote config substitutes its url and then each header separately, all under one
    // source. Replacing meant the later call erased what the earlier one found, so a blank
    // credential in the url was never reported.
    await substitute(`{"url":"{env:${VAR}}"}`)
    await substitute(`{"header":"{env:${OTHER}}"}`)
    expect(namesFor(SOURCE).sort()).toEqual([VAR, OTHER].sort())
  })

  test("a later clean substitution does not erase an earlier finding", async () => {
    await substitute(`{"url":"{env:${VAR}}"}`)
    await substitute(`{"header":"literal"}`)
    expect(namesFor(SOURCE)).toContain(VAR)
  })

  test("reset clears the source so a fixed variable stops being reported", async () => {
    await substitute(`{"token":"{env:${VAR}}"}`)
    expect(namesFor(SOURCE)).toContain(VAR)

    // The user sets the variable and the file is loaded again.
    process.env[VAR] = "now-set"
    try {
      ConfigVariable.resetBlankedEnvVars(SOURCE)
      await substitute(`{"token":"{env:${VAR}}"}`)
      expect(namesFor(SOURCE)).toEqual([])
    } finally {
      delete process.env[VAR]
    }
  })

  test("reset alone clears, for a source that is no longer loaded at all", async () => {
    // The case that motivated moving the reset above loadFile's empty-file return: a config
    // that is deleted or emptied must drop what it recorded, or `mcp list` keeps warning about
    // a variable that appears in no config.
    await substitute(`{"token":"{env:${VAR}}"}`)
    ConfigVariable.resetBlankedEnvVars(SOURCE)
    expect(namesFor(SOURCE)).toEqual([])
  })
})
// altimate_change end
