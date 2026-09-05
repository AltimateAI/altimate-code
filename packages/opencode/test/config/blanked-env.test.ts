// altimate_change start — upstream_fix (#701/#1211): the blank-variable record had no tests at
// all, which is how three placement mistakes reached review. These pin two things: substitution
// UNIONS into a source and only a reset clears it, and a source is attributed to the project that
// declared it rather than guessed from its path.
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import os from "os"
import path from "path"
import { ConfigVariable } from "@/config/variable"

// Deliberately under $HOME. An earlier version of this fix inferred ownership from the path and
// treated everything under $HOME as shared; tests using /virtual/... paths passed anyway and hid
// it. Real projects live under $HOME, so the fixtures do too.
const PROJECT = path.join(os.homedir(), "code", "blanked-env-project-a")
const OTHER = path.join(os.homedir(), "code", "blanked-env-project-b")
const SOURCE = path.join(PROJECT, "altimate-code.json")
const OTHER_SOURCE = path.join(OTHER, "altimate-code.json")
const VAR = "ALTIMATE_TEST_BLANKED_VAR"
const OTHER_VAR = "ALTIMATE_TEST_BLANKED_VAR_TWO"

function namesFor(source: string): string[] {
  return ConfigVariable.blankedEnvVars(PROJECT).find((e) => e.source === source)?.names ?? []
}

async function substitute(text: string, source = SOURCE) {
  return ConfigVariable.substitute({ text, type: "virtual", dir: path.dirname(source), source, env: {} })
}

let priorVar: string | undefined
let priorOther: string | undefined

describe("blankedEnvVars", () => {
  beforeEach(() => {
    // Save and restore: these are process-wide, and a parallel `bun test` must not observe a
    // variable this file removed or left behind.
    priorVar = process.env[VAR]
    priorOther = process.env[OTHER_VAR]
    delete process.env[VAR]
    delete process.env[OTHER_VAR]
    ConfigVariable.resetAllBlankedEnvVars()
    ConfigVariable.resetBlankedEnvVars(SOURCE, PROJECT)
  })

  afterEach(() => {
    if (priorVar === undefined) delete process.env[VAR]
    else process.env[VAR] = priorVar
    if (priorOther === undefined) delete process.env[OTHER_VAR]
    else process.env[OTHER_VAR] = priorOther
    ConfigVariable.resetAllBlankedEnvVars()
  })

  test("records a {env:VAR} that resolved to empty", async () => {
    await substitute(`{"token":"{env:${VAR}}"}`)
    expect(namesFor(SOURCE)).toContain(VAR)
  })

  test("unions across substitutions of one source instead of replacing", async () => {
    // A remote config substitutes its url and then each header separately, all under one source.
    // Replacing meant the later call erased what the earlier one found.
    await substitute(`{"url":"{env:${VAR}}"}`)
    await substitute(`{"header":"{env:${OTHER_VAR}}"}`)
    expect(namesFor(SOURCE).sort()).toEqual([VAR, OTHER_VAR].sort())
  })

  test("a later clean substitution does not erase an earlier finding", async () => {
    await substitute(`{"url":"{env:${VAR}}"}`)
    await substitute(`{"header":"literal"}`)
    expect(namesFor(SOURCE)).toContain(VAR)
  })

  test("reset clears the source so a fixed variable stops being reported", async () => {
    await substitute(`{"token":"{env:${VAR}}"}`)
    expect(namesFor(SOURCE)).toContain(VAR)

    process.env[VAR] = "now-set"
    ConfigVariable.resetBlankedEnvVars(SOURCE, PROJECT)
    await substitute(`{"token":"{env:${VAR}}"}`)
    expect(namesFor(SOURCE)).toEqual([])
  })

  test("reset alone clears, for a source that is no longer loaded at all", async () => {
    // The case behind moving the reset above loadFile's empty-file return: a config that is
    // deleted or emptied must drop what it recorded.
    await substitute(`{"token":"{env:${VAR}}"}`)
    ConfigVariable.resetBlankedEnvVars(SOURCE, PROJECT)
    expect(namesFor(SOURCE)).toEqual([])
  })
})

describe("blankedEnvVars ownership", () => {
  beforeEach(() => {
    priorVar = process.env[VAR]
    delete process.env[VAR]
    ConfigVariable.resetAllBlankedEnvVars()
  })

  afterEach(() => {
    if (priorVar === undefined) delete process.env[VAR]
    else process.env[VAR] = priorVar
    ConfigVariable.resetAllBlankedEnvVars()
  })

  test("another project's config is not reported here, even under $HOME", async () => {
    // The bug this replaces: both projects live under $HOME, so a path-based rule called B's
    // config "shared" and handed it to A.
    ConfigVariable.resetBlankedEnvVars(OTHER_SOURCE, OTHER)
    await substitute(`{"token":"{env:${VAR}}"}`, OTHER_SOURCE)

    expect(ConfigVariable.blankedEnvVars(PROJECT).map((e) => e.source)).not.toContain(OTHER_SOURCE)
    expect(ConfigVariable.blankedEnvVars(OTHER).map((e) => e.source)).toContain(OTHER_SOURCE)
  })

  test("a shared config is reported to every project", async () => {
    // Global config, OPENCODE_CONFIG and managed preferences are loaded by every instance, so
    // suppressing them per project would lose a real diagnostic.
    const shared = path.join(os.homedir(), ".config", "altimate-code", "altimate-code.json")
    ConfigVariable.resetBlankedEnvVars(shared, ConfigVariable.SHARED_CONFIG)
    await substitute(`{"token":"{env:${VAR}}"}`, shared)

    expect(ConfigVariable.blankedEnvVars(PROJECT).map((e) => e.source)).toContain(shared)
    expect(ConfigVariable.blankedEnvVars(OTHER).map((e) => e.source)).toContain(shared)
  })

  test("a source nobody declared is not attributed to a guess", async () => {
    await substitute(`{"token":"{env:${VAR}}"}`, path.join(os.homedir(), "stray", "config.json"))
    expect(ConfigVariable.blankedEnvVars(PROJECT)).toEqual([])
    expect(ConfigVariable.blankedEnvVars(OTHER)).toEqual([])
  })
})
// altimate_change end
