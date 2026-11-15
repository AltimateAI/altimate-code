import fs from "fs/promises"
import os from "os"
import path from "path"
import * as Auth from "@/auth"
import { Log } from "@/util/log"

const log = Log.create({ service: "provider.subscriptions" })

// Subscription logins the welcome picker can offer. `providerID` is the provider the row connects;
// `method` picks that provider's login method by label, so the row skips the method list.
export type Subscription = "claude" | "chatgpt" | "copilot" | "supergrok" | "gitlab-duo"

export interface Found {
  subscription: Subscription
  // Where the login was seen. Never holds a credential value.
  // `anthropic-login`: a Claude Pro/Max login saved by the removed Anthropic sign-in. It no longer
  // connects, so it only marks that the user has a Claude plan.
  source: "altimate" | "claude-code" | "codex" | "copilot" | "anthropic-login"
}

const STORED: Record<string, Subscription> = {
  "claude-agent": "claude",
  openai: "chatgpt",
  "github-copilot": "copilot",
  xai: "supergrok",
  gitlab: "gitlab-duo",
}

// Lists subscription logins already on this machine, expired ones included: the point is to suggest
// a login the user already has, and connecting refreshes or re-asks as needed. Only checks that a
// login exists; no token is read into the result or leaves this process.
export async function detect(): Promise<Found[]> {
  const found = new Map<Subscription, Found>()
  const add = (subscription: Subscription, source: Found["source"]) => {
    if (!found.has(subscription)) found.set(subscription, { subscription, source })
  }

  let retired = false
  const stored = await Auth.all().catch((error) => {
    log.warn("could not read saved logins", { error })
    return {} as Record<string, Auth.Info>
  })
  for (const [providerID, info] of Object.entries(stored)) {
    if (providerID === "anthropic" && info.type === "oauth") {
      retired = true
      continue
    }
    const subscription = STORED[providerID]
    if (!subscription) continue
    // Claude Agent records an `api` marker; the others save the subscription login as `oauth`.
    if (subscription === "claude" || info.type === "oauth") add(subscription, "altimate")
  }

  const [claude, codex, copilot] = await Promise.all([claudeCode(), codexCli(), copilotLogin()])
  if (claude) add("claude", "claude-code")
  if (codex) add("chatgpt", "codex")
  if (copilot) add("copilot", "copilot")
  // Last, so a working Claude Code login is what the picker reports when both are present.
  if (retired) add("claude", "anthropic-login")
  return [...found.values()]
}

// A Claude Pro/Max login saved by the removed Anthropic sign-in. Reported apart from `detect()`, which
// keeps one entry per subscription and so hides it behind a Claude Code login.
export async function retiredAnthropicLogin(): Promise<boolean> {
  const stored = await Auth.all().catch(() => ({}) as Record<string, Auth.Info>)
  return stored.anthropic?.type === "oauth"
}

const home = () => os.homedir()

async function exists(file: string) {
  return fs
    .stat(file)
    .then((stat) => stat.isFile())
    .catch(() => false)
}

async function hasKey(file: string, key: string) {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!text) return false
  try {
    const value = JSON.parse(text)?.[key]
    return value !== undefined && value !== null
  } catch {
    return false
  }
}

// Claude Code keeps its login in the macOS keychain, or in `.credentials.json` elsewhere, and records
// the signed-in account in `.claude.json`.
async function claudeCode() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude")
  if (await exists(path.join(dir, ".credentials.json"))) return true
  const config = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(home(), ".claude.json")
  if (await hasKey(config, "oauthAccount")) return true
  // With CLAUDE_CONFIG_DIR set, Claude Code names its keychain item after that folder, so only the
  // default item is checked.
  if (process.platform !== "darwin" || process.env.CLAUDE_CONFIG_DIR) return false
  // Without -w, `security` prints the item's attributes, never its secret.
  return keychainItem("Claude Code-credentials")
}

// The picker stops waiting after 300 ms, so a slow keychain only needs to be stopped, not waited for.
const KEYCHAIN_TIMEOUT_MS = 1_000

async function keychainItem(service: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", service], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    })
    timer = setTimeout(() => proc.kill(), KEYCHAIN_TIMEOUT_MS)
    timer.unref?.()
    return (await proc.exited) === 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// The Codex CLI saves a ChatGPT login as `tokens` in `auth.json`; an API key alone is not a subscription.
async function codexCli() {
  const dir = process.env.CODEX_HOME || path.join(home(), ".codex")
  return hasKey(path.join(dir, "auth.json"), "tokens")
}

// GitHub Copilot editor extensions save their GitHub login here.
async function copilotLogin() {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), "github-copilot")
  return (await exists(path.join(dir, "apps.json"))) || (await exists(path.join(dir, "hosts.json")))
}
