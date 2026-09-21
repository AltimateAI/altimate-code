import { describe, expect, test } from "bun:test"
import path from "node:path"

// The flag module reads the environment at import time, so each case loads it in a fresh
// subprocess with exactly the variables under test. Regression for #1329: the documented
// ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS did nothing because only the OPENCODE_ spelling was
// read — and a cross-check found most of the documented table in the same state, so the
// second describe walks the table itself.
async function flag(name: string, env: Record<string, string>): Promise<unknown> {
  const script = `import { Flag } from "./src/flag/flag"; console.log(JSON.stringify(Flag.${name} ?? null))`
  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_OPTIONS: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(await new Response(proc.stderr).text())
  return JSON.parse(out.trim())
}

describe("external-skills flags read the documented ALTIMATE_CLI_ names (#1329)", () => {
  test("ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS alone disables external skills", async () => {
    expect(await flag("OPENCODE_DISABLE_EXTERNAL_SKILLS", { ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS: "true" })).toBe(true)
  })

  test("the OPENCODE_ spelling still works", async () => {
    expect(await flag("OPENCODE_DISABLE_EXTERNAL_SKILLS", { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" })).toBe(true)
  })

  test("unset is off; an explicit false is off; the documented name wins over the fallback", async () => {
    expect(await flag("OPENCODE_DISABLE_EXTERNAL_SKILLS", {})).toBe(false)
    expect(await flag("OPENCODE_DISABLE_EXTERNAL_SKILLS", { ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS: "false" })).toBe(false)
    expect(
      await flag("OPENCODE_CONFIG", { ALTIMATE_CLI_CONFIG: "/documented.json", OPENCODE_CONFIG: "/fallback.json" }),
    ).toBe("/documented.json")
  })

  test("the CLAUDE_CODE family accepts the ALTIMATE_CLI_ names too, and the parent implies the children", async () => {
    expect(await flag("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", { ALTIMATE_CLI_DISABLE_CLAUDE_CODE_SKILLS: "true" })).toBe(true)
    expect(await flag("OPENCODE_DISABLE_EXTERNAL_SKILLS", { ALTIMATE_CLI_DISABLE_CLAUDE_CODE: "true" })).toBe(true)
    expect(await flag("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", { ALTIMATE_CLI_DISABLE_CLAUDE_CODE_PROMPT: "true" })).toBe(true)
  })
})

describe("every ALTIMATE_CLI_ variable the CLI docs table lists reaches its flag", () => {
  // Names in docs/docs/usage/cli.md. A row here without a reading flag is a docs bug or a
  // flag bug; either way the documented variable would silently do nothing.
  const numeric = new Set(["ALTIMATE_CLI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS", "ALTIMATE_CLI_EXPERIMENTAL_OUTPUT_TOKEN_MAX"])
  const strings = new Set([
    "ALTIMATE_CLI_CONFIG",
    "ALTIMATE_CLI_CONFIG_CONTENT",
    "ALTIMATE_CLI_CONFIG_DIR",
    "ALTIMATE_CLI_GIT_BASH_PATH",
    "ALTIMATE_CLI_PERMISSION",
    "ALTIMATE_CLI_SERVER_PASSWORD",
    "ALTIMATE_CLI_SERVER_USERNAME",
  ])
  // Flags whose export is not simply OPENCODE_<rest>.
  const exportFor = (name: string) => (name === "ALTIMATE_CLI_YOLO" ? "ALTIMATE_CLI_YOLO" : "OPENCODE_" + name.slice("ALTIMATE_CLI_".length))

  test("table-driven", async () => {
    const docs = await Bun.file(path.resolve(import.meta.dir, "../../../../docs/docs/usage/cli.md")).text()
    const names = [...new Set(docs.match(/ALTIMATE_CLI_[A-Z_]+/g) ?? [])].filter((n) => n !== "ALTIMATE_CLI_CLIENT")
    expect(names.length).toBeGreaterThan(15)
    const missing: string[] = []
    for (const name of names) {
      const value = numeric.has(name) ? "4321" : strings.has(name) ? "documented-value" : "true"
      const expected = numeric.has(name) ? 4321 : strings.has(name) ? "documented-value" : true
      const got = await flag(exportFor(name), { [name]: value })
      if (got !== expected) missing.push(`${name} -> Flag.${exportFor(name)} = ${JSON.stringify(got)}`)
    }
    expect(missing).toEqual([])
  })
})
