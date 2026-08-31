import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
// altimate_change - use fork-branded global paths so config loads from ~/.config/altimate-code
import { Global } from "../global"
import fsNode from "fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
// altimate_change start — upstream_fix: invalidate Config's per-instance cache after writes
import { ScopedCache } from "effect"
// altimate_change end
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { RemoteAuthError } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { Npm } from "@opencode-ai/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"
// altimate_change start — makeRuntime for the restored Promise wrappers (see bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

// altimate_change start — shared normalization for external MCP config formats
/**
 * Normalize a raw config object to handle common misconfigurations:
 * 1. Top-level "mcpServers" key → "mcp" (used by Claude Code, Cursor, etc.)
 * 2. Individual server entries in external format (string command + args + env)
 *    → altimate-code format (command array + environment)
 *
 * Returns a new object with normalized config, leaving the original unchanged.
 * This prevents disk mutation when configs are written back via updateGlobal().
 */
function normalizeMcpConfig(data: Record<string, unknown>, source: string): Record<string, unknown> {
  const result = { ...data }
  // Normalize top-level key — always delete mcpServers to prevent strict schema rejection
  if ("mcpServers" in result) {
    if (!("mcp" in result)) {
      result.mcp = result.mcpServers
    }
    delete result.mcpServers
  }
  // Normalize individual MCP server entries from external formats
  if (result.mcp && typeof result.mcp === "object" && !Array.isArray(result.mcp)) {
    const servers = { ...(result.mcp as Record<string, any>) }
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== "object") {
        delete servers[name]
        continue
      }
      // Build a normalized entry — handles both untyped and typed entries with external fields
      if (entry.command || entry.args) {
        const cmd = Array.isArray(entry.command)
          ? entry.command.map(String)
          : [
              String(entry.command),
              ...(Array.isArray(entry.args)
                ? entry.args.map(String)
                : typeof entry.args === "string"
                  ? [entry.args]
                  : []),
            ]
        const transformed: Record<string, any> = { type: "local", command: cmd }
        if (entry.env && typeof entry.env === "object") transformed.environment = entry.env
        if (entry.environment && typeof entry.environment === "object") transformed.environment = entry.environment
        if (typeof entry.timeout === "number") transformed.timeout = entry.timeout
        if (typeof entry.enabled === "boolean") transformed.enabled = entry.enabled
        // Preserve updatedAt — the datamate sync change-signal field; the
        // McpLocal/McpRemote schemas accept it and dropping it on normalize
        // would discard the reconnect timestamp on this load path.
        if (typeof entry.updatedAt === "string") transformed.updatedAt = entry.updatedAt
        servers[name] = transformed
      } else if (entry.url && typeof entry.url === "string") {
        const transformed: Record<string, any> = { type: "remote", url: entry.url }
        // Copy `headers` / `headersCommand` through as-is — including malformed
        // array shapes. The downstream schema validation rejects an array with an
        // actionable error; stripping arrays here would instead drop the field
        // silently and connect a header-less server with no feedback. See #791 / #792.
        if (entry.headers && typeof entry.headers === "object") transformed.headers = entry.headers
        // altimate_change start — preserve bearer-auth fields the original normalizer
        // dropped silently. Without these passes, a user-supplied `oauth: false` or
        // `headersCommand` would be reconstructed-away, leaving the runtime believing
        // the config was bare. See #791 / #792.
        if (entry.headersCommand && typeof entry.headersCommand === "object") {
          transformed.headersCommand = entry.headersCommand
        }
        if (entry.oauth !== undefined) transformed.oauth = entry.oauth
        // altimate_change end
        if (typeof entry.timeout === "number") transformed.timeout = entry.timeout
        if (typeof entry.enabled === "boolean") transformed.enabled = entry.enabled
        if (typeof entry.updatedAt === "string") transformed.updatedAt = entry.updatedAt
        servers[name] = transformed
      }
    }
    result.mcp = servers
  }
  return result
}
// altimate_change end

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (hadLegacy) {
    delete copy.theme
    delete copy.keybinds
    delete copy.tui
  }
  // altimate_change start — normalize mcpServers to mcp (common key used by other AI tools)
  return normalizeMcpConfig(copy, "config")
  // altimate_change end
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  // altimate_change start — upstream_fix (#701): the url and every header below publish under
  // this same source, so clear once here and let those calls union into one record.
  ConfigVariable.resetBlankedEnvVars(input.source)
  // altimate_change end
  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
    // altimate_change start — upstream_fix: restore raw remote-config string interpolation
    format: "raw",
    // altimate_change end
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
                // altimate_change start — upstream_fix: restore raw remote-config string interpolation
                format: "raw",
                // altimate_change end
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  // altimate_change start - support altimate-code.json/.jsonc config filenames
  // altimate-code.json stays first so it remains the default target when no config exists yet;
  // altimate-code.jsonc is still discovered when it already exists.
  const candidates = ["altimate-code.json", "altimate-code.jsonc", "opencode.jsonc", "opencode.json", "config.json"].map(
    (file) =>
    path.join(Global.Path.config, file),
  )
  // altimate_change end
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      // altimate_change start — upstream_fix (#701): clear before the load, union during it.
      ConfigVariable.resetBlankedEnvVars(source)
      // altimate_change end
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema) {
        // altimate_change start — altimate config schema URL
        data.$schema = "https://altimate.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://altimate.ai/config.json",')
        // altimate_change end
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.OPENCODE_CONFIG && !Flag.OPENCODE_CONFIG_DIR && !Flag.OPENCODE_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            // altimate_change start — altimate config schema URL
            .writeWithDirs(file, JSON.stringify({ $schema: "https://altimate.ai/config.json" }, null, 2))
            // altimate_change end
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.jsonc"), env))
      // altimate_change start - support altimate-code.json/.jsonc config filenames
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "altimate-code.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "altimate-code.jsonc"), env))
      // altimate_change end

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              // altimate_change start — altimate config schema URL
              result["$schema"] = "https://altimate.ai/config.json"
              // altimate_change end
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/opencode`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            // altimate_change start — altimate config schema URL
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://altimate.ai/config.json"
            // altimate_change end
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.OPENCODE_CONFIG) {
          yield* merge(Flag.OPENCODE_CONFIG, yield* loadFile(Flag.OPENCODE_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.OPENCODE_CONFIG })
        }

        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.OPENCODE_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from OPENCODE_CONFIG_DIR", { path: Flag.OPENCODE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          // altimate_change start - support both .altimate-code and .opencode config dirs
          if (dir.endsWith(".altimate-code") || dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
            // altimate_change end
            // altimate_change start - support altimate-code.json config filename
            for (const file of [
              "altimate-code.json",
              // altimate_change start — upstream_fix: load plugin-created altimate-code.jsonc config files
              "altimate-code.jsonc",
              // altimate_change end
              "opencode.json",
              "opencode.jsonc",
            ]) {
              // altimate_change end
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          // altimate_change start — upstream_fix: skip the background @opencode-ai/plugin install in
          // PURE mode. The compiled CLI in an isolated HOME (subprocess tests / OPENCODE_PURE) has no
          // workspace or package cache, so this install fails+retries against the sandbox network and
          // waitForDependencies() (Fiber.join) then HANGS the process on exit — every subprocess test
          // that runs a prompt times out. PURE already means "no external plugin discovery + install".
          if (!Flag.OPENCODE_PURE) {
            const dep = yield* npmSvc
              .install(dir, {
                add: [
                  {
                    name: "@opencode-ai/plugin",
                    version: InstallationLocal ? undefined : InstallationVersion,
                  },
                ],
              })
              .pipe(
                Effect.exit,
                Effect.tap((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                    : Effect.void,
                ),
                Effect.asVoid,
                Effect.forkDetach,
              )
            deps.push(dep)
          }
          // altimate_change end

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.opencode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.OPENCODE_CONFIG_CONTENT) {
          const source = "OPENCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.OPENCODE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from OPENCODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          // altimate_change start - support altimate-code.json config filename
          for (const file of [
            "altimate-code.json",
            // altimate_change start — upstream_fix: load managed altimate-code.jsonc config files
            "altimate-code.jsonc",
            // altimate_change end
            "opencode.json",
            "opencode.jsonc",
          ]) {
            // altimate_change end
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.OPENCODE_PERMISSION) {
          // altimate_change start — upstream_fix: fail closed on malformed OPENCODE_PERMISSION
          result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
          // altimate_change end
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.OPENCODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        // altimate_change start — auto-discover MCP servers from external AI tool configs
        // experimental.auto_mcp_discovery defaults on; access defensively since the key
        // may not yet be declared in the ConfigV1 experimental schema.
        const autoMcpDiscovery = (result.experimental as { auto_mcp_discovery?: boolean } | undefined)
          ?.auto_mcp_discovery
        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG && autoMcpDiscovery !== false) {
          const { discoverExternalMcp, setDiscoveryResult } = yield* Effect.promise(() => import("../mcp/discover"))
          const { servers: externalMcp, sources } = yield* Effect.promise(() => discoverExternalMcp(ctx.directory))
          if (Object.keys(externalMcp).length > 0) {
            result.mcp ??= {}
            const added: string[] = []
            for (const [name, server] of Object.entries(externalMcp)) {
              if (!(name in result.mcp)) {
                ;(result.mcp as Record<string, any>)[name] = server
                added.push(name)
              }
            }
            setDiscoveryResult(added, sources)
          }
        }
        // altimate_change end

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    // altimate_change start — upstream_fix: invalidate Config's per-instance cache after writes
    const invalidateCurrent = Effect.fn("Config.invalidateCurrent")(function* () {
      yield* InstanceState.invalidate(state)
    })

    const invalidateAllInstances = Effect.fn("Config.invalidateAllInstances")(function* () {
      yield* ScopedCache.invalidateAll(state.cache)
    })
    // altimate_change end

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
      // altimate_change start — upstream_fix: make subsequent Config.get() reload after local config writes
      yield* invalidateCurrent()
      // altimate_change end
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
      // altimate_change start — upstream_fix: clear merged Config.get() caches too
      yield* invalidateAllInstances()
      // altimate_change end
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(Npm.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
))
// altimate_change end

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient])
// altimate_change end

// altimate_change start — restore the imperative Promise wrappers upstream removed in the
// Effect-only migration. Our altimate consumers (and several upstream-shared callers) still
// call `await Config.get()` etc. The makeRuntime bridge's `attach()` reads WorkspaceContext +
// the current fiber's InstanceRef, so these reads stay bound to the active workspace/instance.
const { runPromise: runConfig } = makeRuntime(Service, defaultLayer)
export async function get() {
  return runConfig((svc) => svc.get())
}
export async function getGlobal() {
  return runConfig((svc) => svc.getGlobal())
}
export async function getConsoleState() {
  return runConfig((svc) => svc.getConsoleState())
}
export async function update(config: Info) {
  return runConfig((svc) => svc.update(config))
}
export async function updateGlobal(config: Info) {
  return runConfig((svc) => svc.updateGlobal(config))
}
export async function invalidate() {
  return runConfig((svc) => svc.invalidate())
}
export async function directories() {
  return runConfig((svc) => svc.directories())
}
export async function waitForDependencies() {
  return runConfig((svc) => svc.waitForDependencies())
}
// altimate_change end

export * as Config from "./config"
