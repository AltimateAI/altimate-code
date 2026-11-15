/**
 * Adversarial coverage for the v0.12.11 payload (v0.12.10..HEAD, 17 PRs), on top of the suites each PR
 * shipped with. The largest change is #1706 "Claude subscription support through a Claude Agent
 * provider"; its suites (`test/altimate/provider/claude-agent/`, `test/altimate/provider/subscriptions.test.ts`,
 * `test/server/altimate-subscriptions-route.test.ts`) replay real Claude sessions and cover detection,
 * the route and the deleted-chat cleanup. The workspace review PRs (#1685, #1707, #1708, #1716) and the
 * column answer (#1710) carry their own suites.
 *
 * This file adds the boundary classes those suites do not reach:
 *
 *   - Subscription detection against hostile or malformed login files: a prototype-pollution key, JSON
 *     that is not an object, an empty or huge file, a directory where a file is expected, and a symlink to
 *     a file outside the folder. Detection must report names and sources only, never throw, and never
 *     report a login from a key that is not the file's own.
 *   - The removed Claude Pro/Max sign-in: only a saved Anthropic OAuth login is flagged, whatever else is
 *     saved beside it, and the flag survives a Claude Code login that hides it from `found`.
 *   - The "Model not found" hint added for that removal, as a truth table over provider ids and
 *     suggestions.
 *   - The Claude Agent storage key guard against traversal, absolute paths and separators.
 *   - Source guards that keep the removed sign-in removed and the subscription route behind the
 *     cross-site guard, so a later upstream merge cannot quietly restore them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as Auth from "@/auth"
import { scan } from "@/altimate/provider/subscriptions"
import { modelNotFoundHint } from "@/altimate/provider/model-hint"
import { ClaudeAgentStorage } from "@/altimate/provider/claude-agent/storage"

const src = path.join(import.meta.dir, "../../src")
const read = (file: string) => fs.readFile(path.join(src, file), "utf8")

describe("v0.12.11: subscription detection against hostile login files", () => {
  const saved = { ...process.env }
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "release-v0.12.11-"))
    process.env.HOME = path.join(root, "home")
    // A custom folder keeps the macOS keychain check off, so the developer's own login is never seen.
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude")
    process.env.CODEX_HOME = path.join(root, "codex")
    process.env.XDG_CONFIG_HOME = path.join(root, "config")
    delete process.env.OPENCODE_AUTH_CONTENT
    for (const dir of ["home", "claude", "codex", "config"]) await fs.mkdir(path.join(root, dir), { recursive: true })
    for (const key of Object.keys(await Auth.all())) await Auth.remove(key)
  })

  afterEach(async () => {
    for (const key of Object.keys(await Auth.all())) await Auth.remove(key)
    for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "OPENCODE_AUTH_CONTENT"]) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text)

  test("a `tokens` key only in __proto__ is not a ChatGPT login", async () => {
    await write("codex/auth.json", '{"__proto__":{"tokens":{"id_token":"x"}}}')
    await write("claude/.claude.json", '{"__proto__":{"oauthAccount":{}}}')
    expect((await scan()).found).toEqual([])
    // Parsing the file must not pollute Object.prototype either.
    expect(({} as Record<string, unknown>).tokens).toBeUndefined()
  })

  test("JSON that is not an object, or is empty, is not a login", async () => {
    for (const text of ["[]", '"tokens"', "42", "null", "true", "", "   ", "{", '{"tokens":'])
      await write("codex/auth.json", text).then(async () => expect((await scan()).found).toEqual([]))
  })

  test("`tokens: null` and a Codex API key alone are not a ChatGPT subscription", async () => {
    await write("codex/auth.json", JSON.stringify({ tokens: null, OPENAI_API_KEY: "sk-not-a-subscription" }))
    expect((await scan()).found).toEqual([])
  })

  test("a directory where a login file is expected is not a login, and does not throw", async () => {
    await fs.mkdir(path.join(root, "claude/.credentials.json"), { recursive: true })
    await fs.mkdir(path.join(root, "codex/auth.json"), { recursive: true })
    await fs.mkdir(path.join(root, "config/github-copilot/apps.json"), { recursive: true })
    expect((await scan()).found).toEqual([])
  })

  test("a large login file is read without reporting its contents", async () => {
    const token = "secret-" + "x".repeat(2_000_000)
    await write("codex/auth.json", JSON.stringify({ tokens: { access_token: token } }))
    const result = await scan()
    expect(result.found).toEqual([{ subscription: "chatgpt", source: "codex" }])
    expect(JSON.stringify(result)).not.toContain("secret-")
  })

  test("a symlinked credentials file counts, and its target's contents never appear", async () => {
    const outside = path.join(root, "outside.json")
    await fs.writeFile(outside, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-leak" } }))
    await fs.symlink(outside, path.join(root, "claude/.credentials.json"))
    const result = await scan()
    expect(result.found).toEqual([{ subscription: "claude", source: "claude-code" }])
    expect(JSON.stringify(result)).not.toContain("sk-ant-oat-leak")
  })

  test("only a saved Anthropic OAuth login is flagged as the removed sign-in", async () => {
    await Auth.set("anthropic", { type: "api", key: "sk-ant-api-not-oauth" })
    await Auth.set("openai", { type: "oauth", refresh: "r", access: "a", expires: 1 })
    expect((await scan()).retiredAnthropicLogin).toBe(false)

    await Auth.set("anthropic", { type: "oauth", refresh: "r", access: "a", expires: 1 })
    const result = await scan()
    expect(result.retiredAnthropicLogin).toBe(true)
    // It marks a Claude plan in `found`, and never claims to be a working connection.
    expect(result.found).toContainEqual({ subscription: "claude", source: "anthropic-login" })
  })

  test("a Claude Code login hides the removed sign-in from `found`, but the flag stays", async () => {
    await Auth.set("anthropic", { type: "oauth", refresh: "r", access: "a", expires: 1 })
    await write("claude/.credentials.json", "{}")
    const result = await scan()
    expect(result.found).toEqual([{ subscription: "claude", source: "claude-code" }])
    expect(result.retiredAnthropicLogin).toBe(true)
  })
})

describe("v0.12.11: the Model not found hint for a missing Anthropic provider", () => {
  test("shows only for the anthropic provider with nothing to suggest", () => {
    expect(modelNotFoundHint("anthropic")).toContain("/connect and pick Claude subscription")
    expect(modelNotFoundHint("anthropic", [])).toContain("Claude subscription")
  })

  test("a likely model typo (suggestions present) gets no hint", () => {
    expect(modelNotFoundHint("anthropic", ["claude-sonnet-4-6"])).toBeUndefined()
  })

  test("other or malformed provider ids get no hint", () => {
    for (const id of [undefined, "", "Anthropic", " anthropic", "anthropic ", "claude-agent", "openai", "anthropic/claude"])
      expect(modelNotFoundHint(id, [])).toBeUndefined()
  })
})

describe("v0.12.11: Claude Agent storage keys stay inside their folder", () => {
  test("traversal, absolute paths and escapes through the root are refused", async () => {
    for (const key of ["../outside", "sessions/../../outside", "/etc/passwd", "sessions/../../../x"]) {
      const refused = await ClaudeAgentStorage.read(key).then(
        () => `${key}: read`,
        (error: Error) => error.message,
      )
      expect(refused).toBe(`Invalid Claude Agent storage key: ${key}`)
    }
  })

  test('a key of ".." stays inside the folder, as the file "...json"', async () => {
    expect(await ClaudeAgentStorage.read("..")).toBeUndefined()
  })

  test("a missing key reads as nothing, and remove of a missing key is not an error", async () => {
    expect(await ClaudeAgentStorage.read("sessions/release-v0.12.11-missing")).toBeUndefined()
    await ClaudeAgentStorage.remove("sessions/release-v0.12.11-missing")
  })
})

describe("v0.12.11: source guards", () => {
  test("the direct Claude Pro/Max sign-in and the Claude Code beta flag stay removed", async () => {
    const plugins = await read("plugin/index.ts")
    expect(plugins).not.toMatch(/["'`]opencode-anthropic-auth/)
    expect(await read("provider/provider.ts")).not.toContain("claude-code-20250219")
  })

  test("the subscription route keeps its cross-site guard and returns names only", async () => {
    const server = await read("server/server.ts")
    const route = server.slice(server.indexOf('"/altimate/provider/subscriptions"'))
    expect(route.slice(0, 1200)).toContain("browserOriginRefusal(")
    const detection = await read("altimate/provider/subscriptions.ts")
    // Detection checks that a login exists; it never returns a file's contents.
    expect(detection).not.toMatch(/return\s+JSON\.parse/)
    expect(detection).toContain('"find-generic-password", "-s"')
    expect(detection).not.toMatch(/find-generic-password[^\n]*"-w"/)
  })

  test("removing a workspace request asks again, opening on No", async () => {
    const rules = await read("plugin/tui/altimate/rules.tsx")
    const confirm = rules.slice(rules.indexOf("function confirmRemove"), rules.indexOf("async function runRequestAction"))
    expect(confirm).toContain('current="no"')
    expect(confirm).toContain('runRequestAction(api, request, what, "remove")')
  })
})
