// altimate_change - new file
//
// Offline mode: Altimate Code sends network requests only to the configured model endpoint.
// It is on when ALTIMATE_OFFLINE is set or a config file has `"offline": true`. Startup requests (the model
// catalog, workspace and registration checks) run before the configuration loads, so the CLI checks config files
// for the setting first (`optedIn`). Without either, `start()` never runs and nothing changes.
export * as Offline from "./offline"

import fs from "node:fs/promises"
import { isIP } from "node:net"
import path from "node:path"
import { Effect } from "effect"
import { Flag, env, offlineModeEnabled as enabled } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Global } from "@/global"
import { ConfigManaged } from "./managed"
import { ConfigPaths } from "./paths"

export { enabled }

const CONFIG_NAMES = ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"]

/**
 * Whether a config file the instance will load sets `"offline": true`. Only text that mentions the key, or could
 * produce it by substitution, is parsed. Config loaded only after this probe cannot activate offline mode.
 */
export async function optedIn(directory: string): Promise<boolean> {
  if (process.argv.includes("--get-yargs-completions")) return false
  // Let the instance report config errors and reject any offline opt-in missed here.
  return findOptIn(directory).catch(() => false)
}

async function findOptIn(directory: string): Promise<boolean> {
  const sets = async (text: string | undefined, source: string | { source: string; dir: string }) => {
    // A JSON escape (off\u006cine) or a substitution can produce the key without spelling it.
    if (!text || (!text.includes("offline") && !/\{env:|\$\{|\{file:|\\u/.test(text))) return false
    const config = await ConfigPaths.parseText(text, source, "empty", { track: false }).catch(() => undefined)
    return config?.offline === true
  }
  if (await sets(env("OPENCODE_CONFIG_CONTENT"), { source: "OPENCODE_CONFIG_CONTENT", dir: directory })) return true
  // Project config stops at the repository root, as the instance's does.
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
          ]).pipe(Effect.map((found) => found.flat())),
      ConfigPaths.directories(directory, worktree),
    ]).pipe(Effect.provide(FSUtil.defaultLayer)),
  )
  const files = [
    ...projectFiles,
    ...dirs.flatMap((dir) => CONFIG_NAMES.map((name) => path.join(dir, name))),
    path.join(Global.Path.config, "config.json"),
    Flag.OPENCODE_CONFIG,
    ...CONFIG_NAMES.map((name) => path.join(ConfigManaged.managedConfigDir(), name)),
  ]
  for (const file of files) {
    if (file && (await sets(await fs.readFile(file, "utf8").catch(() => undefined), file))) return true
  }
  return false
}

/** Hosts the fetch guard accepts as this machine. Bun matches only these exact names in NO_PROXY. */
const LOCAL_FETCH_HOSTS = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]
const MAX_LOCAL_REDIRECTS = 5

let networkFetch: typeof fetch | undefined

/**
 * Turn offline mode on for the rest of this process and the workers and programs it starts.
 * Installs a fetch guard that allows only loopback requests; model requests use `modelFetch`.
 */
export function start() {
  // Workers and child processes inherit the switch. Shell commands see it too, so a nested
  // altimate-code is offline as well.
  process.env.ALTIMATE_OFFLINE = "1"
  if (networkFetch) return
  // Bun sends even loopback requests through HTTP(S)_PROXY. Exclude only the loopback hosts so a
  // local request cannot leave the machine through a proxy; model requests still use the proxy.
  // Both spellings get the same list, so programs that read either one keep the user's own exclusions.
  const lists = [process.env.NO_PROXY, process.env.no_proxy]
  if (lists.includes("*")) {
    process.env.NO_PROXY = process.env.no_proxy = "*"
  } else {
    const entries = [...new Set(lists.flatMap((list) => (list ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)))]
    process.env.NO_PROXY = process.env.no_proxy = [...entries, ...LOCAL_FETCH_HOSTS.filter((host) => !entries.includes(host))].join(",")
  }
  networkFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      let url = input instanceof Request ? input.url : input.toString()
      if (!isLocalURL(url)) throw new Error("Offline mode allows network requests only to the configured model endpoint.")
      const wanted = init?.redirect ?? (input instanceof Request ? input.redirect : "follow")
      // A Request carries its own method and body, and a caller may ask not to follow: never follow for them.
      if (wanted !== "follow" || input instanceof Request)
        return networkFetch!(input, { ...init, redirect: wanted === "manual" ? "manual" : "error" })
      // Otherwise follow redirects only while they stay on this machine, as fetch would.
      let request: RequestInit = { ...init, redirect: "manual" }
      let response = await networkFetch!(input, request)
      for (let hop = 0; [301, 302, 303, 307, 308].includes(response.status); hop++) {
        const location = response.headers.get("location")
        if (!location) return response
        if (hop === MAX_LOCAL_REDIRECTS) throw new Error("Offline mode stopped after too many local redirects.")
        const next = new URL(location, url)
        if (!isLocalURL(next)) throw new Error("Offline mode blocked a redirect away from this machine.")
        // Like fetch, do not send credentials on to a different origin.
        if (next.origin !== new URL(url).origin) {
          const headers = new Headers(request.headers)
          for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name)
          request = { ...request, headers }
        }
        url = next.href
        const method = (request.method ?? "GET").toUpperCase()
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          const headers = new Headers(request.headers)
          for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name)
          request = { ...request, method: method === "HEAD" ? "HEAD" : "GET", body: undefined, headers }
        }
        response = await networkFetch!(url, request)
      }
      return response
    },
    { preconnect: () => {} },
  )
}

type ModelConfig = Pick<ConfigV1.Info, "provider" | "enabled_providers" | "disabled_providers">

/** The provider's explicitly configured base URL: the only model endpoint offline mode uses. */
export function endpoint(config: ModelConfig, providerID: string) {
  if (config.enabled_providers && !config.enabled_providers.includes(providerID)) return undefined
  if (config.disabled_providers?.includes(providerID)) return undefined
  const url = config.provider?.[providerID]?.options?.baseURL
  return typeof url === "string" && url.trim() ? url : undefined
}

const httpSDKs = new Set(["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic"])

export function supportsSDK(npm: string) {
  return httpSDKs.has(npm)
}

/** Fetch for model requests: only below the configured base URL, never redirected, through the user's proxy. */
export function modelFetch(baseURL: string | undefined): typeof fetch {
  if (!baseURL) throw new Error("Offline mode requires a model provider with an explicit baseURL.")
  const base = new URL(baseURL)
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("Offline mode requires an HTTP(S) model endpoint.")
  const basePath = base.pathname.replace(/\/+$/, "")
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const target = new URL(input instanceof Request ? input.url : input.toString())
      if (target.origin !== base.origin || (target.pathname !== basePath && !target.pathname.startsWith(basePath + "/")))
        throw new Error("Offline mode blocked a request outside the configured model endpoint.")
      return (networkFetch ?? globalThis.fetch)(input, { ...init, redirect: "error" })
    },
    { preconnect: () => {} },
  )
}

/** Literal loopback addresses only: no DNS lookups or hostname suffix matching. */
export function isLoopbackHost(value: unknown): boolean {
  if (typeof value !== "string") return false
  const host = value.toLowerCase().replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."))
}

/** An HTTP(S) URL the fetch guard sends directly to this machine. */
export function isLocalURL(value: string | URL) {
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && LOCAL_FETCH_HOSTS.includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function assertLocalMcp(config: { type: string; url?: string }) {
  if (enabled() && config.type === "remote" && !isLocalURL(config.url ?? ""))
    throw new Error("Offline mode allows only stdio MCP servers or ones on this machine (localhost, 127.0.0.1, [::1] or 0.0.0.0).")
}
