import fs from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import * as Effect from "effect/Effect"
import { Flag, env } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Global } from "@/global"
import { ConfigManaged } from "./managed"
import { ConfigPaths } from "./paths"

const configNames = ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"]

export function offline() {
  return process.env.ALTIMATE_OFFLINE === "1"
}

async function localOptIn(directory: string) {
  // The switch is an opt-in from any local config source. Read just this
  // key so remote credentials and unrelated substitutions cannot affect it.
  const enabled = (text: string | undefined) => text !== undefined && parse(text)?.offline === true
  if (enabled(env("OPENCODE_CONFIG_CONTENT"))) return true
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
    if (file && enabled(await fs.readFile(file, "utf8").catch(() => undefined))) return true
  }
  return enabled((await ConfigManaged.readManagedPreferences().catch(() => undefined))?.text)
}

let networkFetch: typeof fetch | undefined

export async function startOfflineMode(directory: string, model?: string) {
  if (!offline() && !(await localOptIn(directory))) return
  // Workers and core services must see the same policy before constructing
  // their layers. Once enabled, keep it for the lifetime of the process.
  process.env.ALTIMATE_OFFLINE = "1"
  process.env.GIT_NO_LAZY_FETCH = "1"
  // Bun consults proxy environment variables even when fetch sets proxy: "".
  // Offline traffic must go directly to the one configured endpoint.
  process.env.NO_PROXY = "*"
  process.env.no_proxy = "*"
  if (model) process.env.ALTIMATE_OFFLINE_MODEL = model
  if (networkFetch) return
  networkFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Offline mode allows network requests only to the configured model endpoint.")
    },
    { preconnect: () => {} },
  )
}

export function offlineProvider(
  config: Pick<ConfigV1.Info, "model" | "provider" | "enabled_providers" | "disabled_providers">,
) {
  const model = process.env.ALTIMATE_OFFLINE_MODEL ?? config.model
  if (model) return model.split("/")[0]
  const candidates = Object.entries(config.provider ?? {}).filter(
    ([id, provider]) =>
      typeof provider.options?.baseURL === "string" &&
      (!config.enabled_providers || config.enabled_providers.includes(id)) &&
      !config.disabled_providers?.includes(id),
  )
  return candidates.length === 1 ? candidates[0][0] : undefined
}

export function offlineModelFetch(baseURL: string | undefined): typeof fetch {
  if (!baseURL) throw new Error("Offline mode requires a model provider with an explicit baseURL.")
  const endpoint = new URL(baseURL)
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw new Error("Offline mode requires an HTTP(S) model endpoint.")
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const target = new URL(input instanceof Request ? input.url : input.toString())
      if (target.origin !== endpoint.origin)
        throw new Error("Offline mode blocked a request outside the configured model endpoint.")
      return (networkFetch ?? globalThis.fetch)(input, { ...init, redirect: "error" })
    },
    { preconnect: () => {} },
  )
}

let warned = false

export async function warnOffline(hasSnapshot: boolean) {
  if (warned) return
  warned = true
  const message = hasSnapshot
    ? "Using cached workspace skills."
    : "No usable workspace skill snapshot. Run altimate-code workspace refresh while online."
  const { isHeadless } = await import("@/altimate/workspace/engine-seams")
  const { notify, printLine } = await import("@/altimate/workspace/engine-probes")
  if (isHeadless()) printLine(`Offline mode: ${message}`)
  else await notify({ title: "Offline mode", message, variant: hasSnapshot ? "info" : "warning" })
}
