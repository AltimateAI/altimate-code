import fs from "node:fs/promises"
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
    if (parse(text)?.offline === true) return true
    const config = await ConfigPaths.parseText(text, source, "empty", { track: false }).catch(() => undefined)
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
  const managed = await ConfigManaged.readManagedPreferences().catch(() => undefined)
  return managed ? optedIn(managed.text, { source: managed.source, dir: path.dirname(managed.source) }) : false
}

export async function assertStartupPolicy(directory: string) {
  if (!enabled() && (await localOptIn(directory))) {
    throw new Error(
      "This project requests offline mode. Start Altimate Code from the project to apply its offline policy.",
    )
  }
}

let networkFetch: typeof fetch | undefined

export async function start(directory: string, model?: string) {
  if (!enabled() && !(await localOptIn(directory))) return
  // Workers and core services must see the same policy before constructing
  // their layers. Once enabled, keep it for the lifetime of the process.
  process.env.ALTIMATE_OFFLINE = "1"
  // Bun consults proxy environment variables even when fetch sets proxy: "".
  // Offline traffic must go directly to the one configured endpoint.
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
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const target = new URL(input instanceof Request ? input.url : input.toString())
      if (target.origin !== endpoint.origin)
        throw new Error("Offline mode blocked a request outside the configured model endpoint.")
      return (networkFetch ?? globalThis.fetch)(input, { ...init, redirect: "error", proxy: undefined })
    },
    { preconnect: () => {} },
  )
}

// Validate the URL before any offline loopback HTTP request.
export function isLocalURL(value: string | URL) {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol)) return false
    const host = url.hostname.toLowerCase()
    return host === "localhost" || host === "localhost." || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host)
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

export async function announce(hasSnapshot: boolean) {
  if (warned) return
  warned = true
  const message = hasSnapshot
    ? "Using cached workspace skills."
    : "No usable workspace skill snapshot. To use workspace skills, run altimate-code workspace refresh while online."
  const { isHeadless } = await import("@/altimate/workspace/engine-seams")
  const { notify, printLine } = await import("@/altimate/workspace/engine-probes")
  if (isHeadless()) printLine(`Offline mode: ${message}`)
  else await notify({ title: "Offline mode", message, variant: hasSnapshot ? "info" : "warning" })
}

export * as Offline from "./offline"
