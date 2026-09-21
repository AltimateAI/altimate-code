import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import * as ServerAuth from "../../src/server/auth"

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

// The gate skill discovery really reads is `RuntimeFlags.disableExternalSkills`, an Effect
// `Config` resolved through the ambient ConfigProvider — not `Flag.*`. The first cut of this
// fix aliased only `Flag.*`, so the documented name still did nothing where it mattered.
// (cubic, #1341)
describe("the Effect Config-backed flags read the documented names too", () => {
  const runtimeFlags = (env: Record<string, string>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* RuntimeFlags.Service
      }).pipe(
        Effect.provide(
          RuntimeFlags.Service.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
        ),
      ),
    )
  const serverAuth = (env: Record<string, string>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* ServerAuth.Config
      }).pipe(
        Effect.provide(
          ServerAuth.Config.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
        ),
      ),
    )

  test("ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS alone reaches RuntimeFlags.disableExternalSkills", async () => {
    expect((await runtimeFlags({ ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS: "true" })).disableExternalSkills).toBe(true)
    expect((await runtimeFlags({ ALTIMATE_CLI_DISABLE_CLAUDE_CODE: "true" })).disableExternalSkills).toBe(true)
    expect((await runtimeFlags({})).disableExternalSkills).toBe(false)
  })

  test("the documented value wins outright, and an empty documented value is unset", async () => {
    const both = await runtimeFlags({ ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS: "false", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" })
    expect(both.disableExternalSkills).toBe(false)
    const empty = await runtimeFlags({ ALTIMATE_CLI_CLIENT: "", OPENCODE_CLIENT: "vscode" })
    expect(empty.client).toBe("vscode")
  })

  test("a numeric flag and a non-OPENCODE path are unaffected", async () => {
    expect((await runtimeFlags({ ALTIMATE_CLI_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "4321" })).outputTokenMax).toBe(4321)
    expect((await runtimeFlags({ OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "1234" })).outputTokenMax).toBe(1234)
  })

  test("server auth reads ALTIMATE_CLI_SERVER_PASSWORD / _USERNAME", async () => {
    const config = await serverAuth({ ALTIMATE_CLI_SERVER_PASSWORD: "s3cret", ALTIMATE_CLI_SERVER_USERNAME: "kit" })
    expect(Option.getOrUndefined(config.password)).toBe("s3cret")
    expect(config.username).toBe("kit")
  })
})

// `packages/core`'s `Flag` object is the other import-time reader (31 files in this package,
// `config/config.ts` among them), and the two Effect `Config` flags it carries resolve
// through the ambient provider. Same rule, same subprocess harness.
describe("the core Flag object reads the documented names", () => {
  async function coreFlag(name: string, env: Record<string, string>): Promise<unknown> {
    const script =
      `import { Flag } from "@opencode-ai/core/flag/flag"; import { Effect } from "effect";` +
      `const v = Flag.${name}; Promise.resolve(Effect.isEffect(v) ? Effect.runPromise(Effect.gen(function* () { return yield* v })) : v)` +
      `.then((x) => console.log(JSON.stringify(x ?? null)))`
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

  test("ALTIMATE_CLI_CONFIG reaches the Flag config.ts reads", async () => {
    expect(await coreFlag("OPENCODE_CONFIG", { ALTIMATE_CLI_CONFIG: "/documented.json" })).toBe("/documented.json")
    expect(await coreFlag("OPENCODE_CONFIG", { ALTIMATE_CLI_CONFIG: "", OPENCODE_CONFIG: "/fallback.json" })).toBe("/fallback.json")
    expect(await coreFlag("OPENCODE_CONFIG_DIR", { ALTIMATE_CLI_CONFIG_DIR: "/documented" })).toBe("/documented")
    expect(await coreFlag("OPENCODE_CONFIG_CONTENT", { ALTIMATE_CLI_CONFIG_CONTENT: "{}" })).toBe("{}")
  })

  test("a documented false is not overridden by a fallback true", async () => {
    expect(await coreFlag("OPENCODE_DISABLE_AUTOUPDATE", { ALTIMATE_CLI_DISABLE_AUTOUPDATE: "false", OPENCODE_DISABLE_AUTOUPDATE: "true" })).toBe(false)
    expect(await coreFlag("ALTIMATE_CALM_MODE", { ALTIMATE_CALM_MODE: "false", OPENCODE_CALM_MODE: "true" })).toBe(false)
    expect(await flag("OPENCODE_DISABLE_AUTOUPDATE", { ALTIMATE_CLI_DISABLE_AUTOUPDATE: "false", OPENCODE_DISABLE_AUTOUPDATE: "true" })).toBe(false)
  })

  test("the Effect Config flag it carries resolves the documented name", async () => {
    expect(await coreFlag("OPENCODE_EXPERIMENTAL_FILEWATCHER", { ALTIMATE_CLI_EXPERIMENTAL_FILEWATCHER: "true" })).toBe(true)
    expect(await coreFlag("OPENCODE_EXPERIMENTAL_FILEWATCHER", { OPENCODE_EXPERIMENTAL_FILEWATCHER: "true" })).toBe(true)
    expect(await coreFlag("OPENCODE_EXPERIMENTAL_FILEWATCHER", {})).toBe(false)
  })
})

// coderabbit on #1341: the copy-on-select default is chosen by whether the variable is
// set at all, so a documented `false` must count as set or Windows keeps its default.
test("a documented explicit false overrides the platform default for copy-on-select", async () => {
  expect(
    await flag("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT", { ALTIMATE_CLI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: "false" }),
  ).toBe(false)
  expect(
    await flag("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT", { ALTIMATE_CLI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: "true" }),
  ).toBe(true)
})
