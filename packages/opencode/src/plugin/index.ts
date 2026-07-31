import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { ModalPlugin } from "./modal/modal"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
// altimate_change start — upstream_fix: restore provider auth plugin imports
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
// altimate_change end
// altimate_change start — snowflake cortex plugin import (fork's prompt-caching fix, #1009/#1020)
import { SnowflakeCortexAuthPlugin } from "../altimate/plugin/snowflake"
// altimate_change end
// altimate_change start — databricks plugin import
import { DatabricksAuthPlugin } from "../altimate/plugin/databricks"
// altimate_change end
// altimate_change start — altimate backend auth plugin
import { AltimateAuthPlugin } from "../altimate/plugin/altimate"
// altimate_change end
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { ConfigPlugin } from "@/config/plugin"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
// altimate_change start — upstream_fix: registerAdapter needs core's Project.ID brand (see marker below)
import { ProjectV2 } from "@opencode-ai/core/project"
// altimate_change end
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
// altimate_change start — makeRuntime for the restored Promise wrappers (see bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

// Built-in plugins that are directly imported (not installed from npm)
// GitlabAuthPlugin uses a different version of @opencode-ai/plugin (from npm)
// vs the workspace version, causing a type mismatch on internal HeyApiClient.
// The types are structurally compatible at runtime.
// altimate_change start — snowflake cortex, databricks, and altimate backend internal plugins
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    CodexAuthPlugin,
    CopilotAuthPlugin,
    ModalPlugin,
    GitlabAuthPlugin as unknown as PluginInstance,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    // altimate_change start — upstream_fix: restore provider auth internal plugins
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    XaiAuthPlugin,
    // altimate_change end
    SnowflakeCortexAuthPlugin,
    DatabricksAuthPlugin,
    AltimateAuthPlugin,
  ]
}
// altimate_change end

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          // altimate_change — upstream_fix: Server.Default() is the Hono app itself now
          // (createApp() return), not a wrapper with an `.app` property
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          // altimate_change start — register plugin-provided workspace adapters with the
          // control-plane registry, scoped to the current project.
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              // altimate_change — upstream_fix: registerAdapter takes core's Project.ID brand,
              // not the fork's ProjectID (identity at runtime)
              registerAdapter(ProjectV2.ID.make(ctx.project.id), type, adapter as WorkspaceAdapter)
            },
          },
          // altimate_change end
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (init._tag === "Some") hooks.push(init.value)
        }

        // altimate_change start — upstream_fix: PR #18186 — keep Anthropic bundled as a provider.
        // Upstream dropped Anthropic; the fork ships the anthropic-auth plugin by default, gated
        // by the same flags as the other default plugins. Origin (not a bare spec string) because
        // PluginLoader.loadExternal indexes items by `.spec` — a raw string here crashes
        // isDeprecatedPlugin() with `spec.includes is not a function`.
        const BUILTIN: ConfigPlugin.Origin[] = [
          { spec: "opencode-anthropic-auth@0.0.13", source: "builtin", scope: "global" },
        ]
        const plugins: ConfigPlugin.Origin[] = flags.pure
          ? []
          : [...(flags.disableDefaultPlugins ? [] : BUILTIN), ...(cfg.plugin_origins ?? [])]
        // altimate_change end
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.catch(() => {
              // TODO: make proper events for this
              // events.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        // altimate_change start — isolate plugin-hook failures so a single buggy plugin can't
        // crash the session. Without this, an unhandled throw in any hook (e.g. chat.params,
        // chat.headers) propagates to the caller (session/llm.ts), aborting the LLM call.
        // Round 3 adversarial audit (v140-merge-chaos.test.ts) found this — pre-existing
        // pre-v1.4.0 but exposure grew with the new chat.params plumbing.
        yield* Effect.tryPromise({
          try: () => fn(input, output),
          catch: errorMessage,
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("plugin hook threw; continuing with remaining hooks", { hook: name as string, error }),
          ),
          Effect.ignore,
        )
        // altimate_change end
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, init })
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)
// altimate_change end

// altimate_change start — upstream_fix: lazy deps for fork facade import cycles
export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: LayerNode.lazy(() => [EventV2Bridge.node, Config.node, RuntimeFlags.node]),
})
// altimate_change end

// altimate_change start — restore the imperative Promise wrappers upstream removed in the
// Effect-only migration. Many non-Effect call sites (session/prompt.ts, tool/registry.ts,
// pty/index.ts, etc.) call `Plugin.trigger`/`Plugin.list` as plain async functions; makeRuntime's
// attach() picks up the current Instance/Workspace context automatically (see run-service.ts).
const { runPromise: runPlugin } = makeRuntime(Service, defaultLayer)
export async function trigger<
  Name extends TriggerName,
  Input = Parameters<Required<Hooks>[Name]>[0],
  Output = Parameters<Required<Hooks>[Name]>[1],
>(name: Name, input: Input, output: Output): Promise<Output> {
  return runPlugin((svc) => svc.trigger(name, input, output))
}
export async function list() {
  return runPlugin((svc) => svc.list())
}
export async function init() {
  return runPlugin((svc) => svc.init())
}
// altimate_change end

export * as Plugin from "."
