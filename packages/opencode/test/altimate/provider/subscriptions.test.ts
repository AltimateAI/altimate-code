import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as Auth from "@/auth"
import { scan } from "@/altimate/provider/subscriptions"

const saved = { ...process.env }
let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "subscriptions-"))
  process.env.HOME = path.join(root, "home")
  // A custom folder keeps the macOS keychain check off, so the developer's own login is never seen.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude")
  process.env.CODEX_HOME = path.join(root, "codex")
  process.env.XDG_CONFIG_HOME = path.join(root, "config")
  // Set, it replaces the saved logins (`Auth.all`), so an outer value would leak into every case.
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

const write = (file: string, value: unknown) => fs.writeFile(path.join(root, file), JSON.stringify(value))
const detect = async () => (await scan()).found
const names = async () => (await detect()).map((item) => item.subscription).sort()

describe("subscription detection", () => {
  test("finds nothing on a clean machine", async () => {
    expect(await detect()).toEqual([])
  })

  test("finds Claude Code, Codex and Copilot logins by their files", async () => {
    await write("claude/.credentials.json", { claudeAiOauth: {} })
    await write("codex/auth.json", { tokens: { id_token: "x" } })
    await fs.mkdir(path.join(root, "config/github-copilot"), { recursive: true })
    await write("config/github-copilot/apps.json", {})
    expect(await names()).toEqual(["chatgpt", "claude", "copilot"])
  })

  test("a Claude Code account record counts without a credentials file", async () => {
    await write("claude/.claude.json", { oauthAccount: { emailAddress: "a@b.c" } })
    expect(await names()).toEqual(["claude"])
  })

  test("a Codex API key alone is not a ChatGPT subscription", async () => {
    await write("codex/auth.json", { OPENAI_API_KEY: "sk-test", tokens: null })
    expect(await detect()).toEqual([])
  })

  test("saved Altimate logins count, expired or not; API keys do not", async () => {
    await Auth.set("openai", { type: "oauth", refresh: "r", access: "a", expires: 1 })
    await Auth.set("xai", { type: "oauth", refresh: "r", access: "a", expires: 1 })
    await Auth.set("github-copilot", { type: "api", key: "k" })
    await Auth.set("anthropic", { type: "api", key: "k" })
    expect(await names()).toEqual(["chatgpt", "supergrok"])
  })

  test("an old Anthropic Claude Pro/Max login marks a Claude plan, behind a Claude Code login", async () => {
    await Auth.set("anthropic", { type: "oauth", refresh: "r", access: "a", expires: 1 })
    expect(await detect()).toEqual([{ subscription: "claude", source: "anthropic-login" }])
    await write("claude/.credentials.json", { claudeAiOauth: {} })
    expect(await detect()).toEqual([{ subscription: "claude", source: "claude-code" }])
    // Still reported for the reconnect notice.
    expect((await scan()).retiredAnthropicLogin).toBe(true)
  })

  test("an Anthropic API key is not an old Claude Pro/Max login", async () => {
    await Auth.set("anthropic", { type: "api", key: "k" })
    expect((await scan()).retiredAnthropicLogin).toBe(false)
  })

  test("a saved Claude subscription connection counts as a Claude login", async () => {
    // Claude Agent saves an `api` marker, not an OAuth token.
    await Auth.set("claude-agent", { type: "api", key: "claude-code" })
    expect(await detect()).toEqual([{ subscription: "claude", source: "altimate" }])
  })

  test("the result names subscriptions and sources only", async () => {
    await write("codex/auth.json", { tokens: { access_token: "secret-token-value" } })
    const found = await detect()
    expect(found).toEqual([{ subscription: "chatgpt", source: "codex" }])
    expect(JSON.stringify(found)).not.toContain("secret-token-value")
  })

  test("unreadable or malformed files are ignored", async () => {
    await fs.writeFile(path.join(root, "codex/auth.json"), "{not json")
    await fs.writeFile(path.join(root, "claude/.claude.json"), "")
    expect(await detect()).toEqual([])
  })
})
