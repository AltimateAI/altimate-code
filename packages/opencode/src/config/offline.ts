import fs from "node:fs/promises"
import { isIP } from "node:net"
import path from "node:path"
import { parse } from "jsonc-parser"
import * as Effect from "effect/Effect"
import { Flag, env, offlineModeEnabled as enabled } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Global } from "@/global"
import { ConfigManaged } from "./managed"
import { ConfigPaths } from "./paths"

const configNames = ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"]

export { enabled }

async function localOptIn(directory: string) {
  // The switch is an opt-in from any local config source. Read just this
  // key so remote credentials and unrelated substitutions cannot affect it.
  const optedIn = async (text: string | undefined, source: string | { source: string; dir: string }) => {
    if (!text) return false
    // Skip the substitution pass for text that can neither name nor produce the key.
    if (!text.includes("offline") && !/\{env:|\$\{|\{file:|\\u/.test(text)) return false
    if (parse(text)?.offline === true) return true
    const config = await ConfigPaths.parseText(text, source, "empty", { track: false, expandFiles: false }).catch(() => undefined)
    return config?.offline === true
  }
  if (await optedIn(env("OPENCODE_CONFIG_CONTENT"), { source: "OPENCODE_CONFIG_CONTENT", dir: directory })) return true
  let worktree = path.resolve(directory)
  while (!(await fs.stat(path.join(worktree, ".git")).catch(() => undefined))) {
    const parent = path.dirname(worktree)
    if (parent === worktree) break
    worktree = parent
  }
  const [projectFiles, dirs] = await Effect.runPromise(
    Effect.all([
      Flag.OPENCODE_DISABLE_PROJECT_CONFIG
        ? Effect.succeed([] as string[])
        : Effect.all([
            ConfigPaths.files("opencode", directory, worktree),
            ConfigPaths.files("altimate-code", directory, worktree),
          ]).pipe(Effect.map((sources) => sources.flat())),
      ConfigPaths.directories(directory, worktree),
    ]).pipe(Effect.provide(FSUtil.defaultLayer)),
  )
  const files = [
    ...projectFiles,
    ...[...dirs, ConfigManaged.managedConfigDir()].flatMap((dir) => configNames.map((name) => path.join(dir, name))),
    path.join(Global.Path.config, "config.json"),
    Flag.OPENCODE_CONFIG,
  ]
  for (const file of files) {
    if (file && (await optedIn(await fs.readFile(file, "utf8").catch(() => undefined), file))) return true
  }
  // The legacy global TOML file is converted to config.json only after startup, so read it here too.
  const legacy = await fs.readFile(path.join(Global.Path.config, "config"), "utf8").catch(() => undefined)
  if (legacy !== undefined) {
    try {
      if ((Bun.TOML.parse(legacy) as { offline?: unknown }).offline === true) return true
    } catch {
      // An unparseable file still counts when it plainly requests offline mode.
      if (/^\s*offline\s*=\s*true\b/m.test(legacy)) return true
    }
  }
  const managed = await ConfigManaged.readManagedPreferences().catch(() => undefined)
  return managed ? optedIn(managed.text, { source: managed.source, dir: path.dirname(managed.source) }) : false
}

/**
 * Environment for an app-owned helper program whose only network use is optional (for example dbt's
 * version lookup): every proxy points at a closed loopback port, so its requests fail on this machine.
 */
export const CLOSED_PROXY_ENV: Record<string, string> = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  all_proxy: "http://127.0.0.1:9",
  NO_PROXY: "",
  no_proxy: "",
}

export const SHARE_REFUSAL = "Sharing sessions requires an online run."
export const UNSHARE_REFUSAL = "Offline mode cannot revoke a share. Run unshare while online."

/** A refusal by the offline policy. Servers report it to the client as a 400 with this message. */
export class OfflinePolicyError extends Error {
  override name = "OfflinePolicyError"
}

/** The policy refusal behind an error, following `cause` links that runtimes add when they wrap it. */
export function policyError(error: unknown): OfflinePolicyError | undefined {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    if (current instanceof OfflinePolicyError) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

export async function assertStartupPolicy(directory: string) {
  if (!enabled() && (await localOptIn(directory))) {
    throw new OfflinePolicyError(
      "This project requests offline mode. Start Altimate Code from the project to apply its offline policy.",
    )
  }
}

let networkFetch: typeof fetch | undefined

const USER_PROXY = "ALTIMATE_OFFLINE_USER_PROXY"

/**
 * Environment for programs the user runs or configures (shell commands, language servers,
 * stdio MCP servers). Offline mode does not police their network access, so they get the
 * user's original proxy exclusions back instead of the process-wide bypass.
 */
export function userEnv<T extends Record<string, string | undefined>>(env: T): T {
  const saved = env[USER_PROXY] ?? process.env[USER_PROXY]
  if (saved === undefined) return env
  delete env[USER_PROXY]
  try {
    const original = JSON.parse(saved) as Record<string, unknown>
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
      // Only the inherited bypass is replaced; a value the program's own config set stays. An absent key is
      // treated as inherited too, since a copied environment may not carry it.
      if (env[key] !== undefined && env[key] !== process.env[key]) continue
      const value = original[key]
      if (typeof value === "string") (env as Record<string, string | undefined>)[key] = value
      else delete env[key]
    }
  } catch {}
  return env
}

export async function start(directory: string, model?: string) {
  if (!enabled() && !(await localOptIn(directory))) return
  // Workers and core services must see the same policy before constructing
  // their layers. Once enabled, keep it for the lifetime of the process.
  process.env.ALTIMATE_OFFLINE = "1"
  // Bun consults proxy environment variables even when fetch sets proxy: "".
  // Offline traffic must go directly to the one configured endpoint. The user's own
  // values are kept (and inherited by workers) so their programs get them back: see userEnv.
  if (process.env[USER_PROXY] === undefined)
    process.env[USER_PROXY] = JSON.stringify({ NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy })
  process.env.NO_PROXY = "*"
  process.env.no_proxy = "*"
  if (model) process.env.ALTIMATE_OFFLINE_MODEL = model
  if (networkFetch) return
  networkFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const [input] = args
      if (isLocalURL(input instanceof Request ? input.url : input.toString())) return localFetch()(...args)
      throw new Error("Offline mode allows network requests only to the configured model endpoint or loopback services.")
    },
    { preconnect: () => {} },
  )
}

type ModelConfig = Pick<ConfigV1.Info, "model" | "provider" | "enabled_providers" | "disabled_providers">

function configuredBaseURL(config: ModelConfig, providerID: string) {
  const url = config.provider?.[providerID]?.options?.baseURL
  return typeof url === "string" && url.trim() ? url : undefined
}

function provider(config: ModelConfig) {
  const model = process.env.ALTIMATE_OFFLINE_MODEL ?? config.model
  if (model) return model.split("/")[0]
  const candidates = Object.keys(config.provider ?? {}).filter(
    (id) =>
      configuredBaseURL(config, id) !== undefined &&
      (!config.enabled_providers || config.enabled_providers.includes(id)) &&
      !config.disabled_providers?.includes(id),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

export function endpoint(config: ModelConfig, providerID: string) {
  return provider(config) === providerID ? configuredBaseURL(config, providerID) : undefined
}

const httpSDKs = new Set(["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"])

export function supportsSDK(npm: string) {
  return httpSDKs.has(npm)
}

export function modelFetch(baseURL: string | undefined): typeof fetch {
  if (!baseURL) throw new Error("Offline mode requires a model provider with an explicit baseURL.")
  const endpoint = new URL(baseURL)
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw new Error("Offline mode requires an HTTP(S) model endpoint.")
  const basePath = endpoint.pathname.replace(/\/+$/, "")
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const target = new URL(input instanceof Request ? input.url : input.toString())
      if (
        target.origin !== endpoint.origin ||
        (target.pathname !== basePath && !target.pathname.startsWith(basePath + "/"))
      )
        throw new Error("Offline mode blocked a request outside the configured model endpoint.")
      return (networkFetch ?? globalThis.fetch)(input, { ...init, redirect: "error", proxy: undefined })
    },
    { preconnect: () => {} },
  )
}

/** Literal loopback addresses only: no DNS lookups or hostname suffix matching. */
export function isLoopbackHost(value: unknown): boolean {
  if (typeof value !== "string") return false
  const host = value.toLowerCase().replace(/^\[|\]$/g, "")
  // Wildcard bind addresses (0.0.0.0, ::) are reached on this machine when used as a destination.
  return host === "localhost" || host === "localhost." || host === "::1" || host === "::" || host === "0.0.0.0" ||
    (isIP(host) === 4 && host.startsWith("127."))
}

// Validate the URL before any offline loopback HTTP request.
export function isLocalURL(value: string | URL) {
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

export function assertLocalMcp(config: { type: string; url?: string }) {
  if (enabled() && config.type === "remote" && !isLocalURL(config.url ?? ""))
    throw new Error("Offline mode allows only stdio or localhost/loopback HTTP(S) MCP servers.")
}

export function localFetch(): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const target = input instanceof Request ? input.url : input.toString()
      if (!isLocalURL(target)) throw new Error("Offline mode blocked a non-local request.")
      // Never follow redirects: a local endpoint must not grant access to a remote host.
      return (networkFetch ?? globalThis.fetch)(input, { ...init, redirect: "error", proxy: undefined })
    },
    { preconnect: () => {} },
  )
}

let warned = false

export async function announce(hasSnapshot: boolean, knownEmpty = false) {
  if (warned) return
  warned = true
  let delivered = false
  try {
    const message = hasSnapshot
      ? "Using cached workspace skills."
      : knownEmpty
        ? "This workspace has no custom skills."
        : "No usable workspace skill snapshot. To use workspace skills, run altimate-code workspace refresh while online."
    const { isHeadless } = await import("@/altimate/workspace/engine-seams")
    const { notify, printLine } = await import("@/altimate/workspace/engine-probes")
    if (isHeadless()) {
      printLine(`Offline mode: ${message}`)
      delivered = true
    } else {
      delivered = await notify({ title: "Offline mode", message, variant: hasSnapshot || knownEmpty ? "info" : "warning" })
    }
  } finally {
    if (!delivered) warned = false
  }
}

export * as Offline from "./offline"
