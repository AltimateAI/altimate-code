import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
// altimate_change start — makeRuntime + AppNodeBuilder for the restored Promise wrapper (bottom of file)
import { makeRuntime } from "@/effect/run-service"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
// altimate_change end
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { Log } from "../util/log"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
// altimate_change start — configure commands for external AI CLIs
import PROMPT_DISCOVER from "./template/discover.txt"
import PROMPT_CONFIGURE_CLAUDE from "./template/configure-claude.txt"
import PROMPT_CONFIGURE_CODEX from "./template/configure-codex.txt"
import PROMPT_DISCOVER_MCPS from "./template/discover-and-add-mcps.txt"
import PROMPT_FEEDBACK from "./template/feedback.txt"
// altimate_change end

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    // altimate_change start — upstream_fix: numeric sort of multi-digit placeholders ($10 sorted before $2)
    for (const match of [...new Set(numbered)].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)))
      result.push(match)
    // altimate_change end
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  // altimate_change start — restore altimate built-in command constants after upstream command merge
  DISCOVER: "discover",
  FEEDBACK: "feedback",
  // altimate_change end
  REVIEW: "review",
  // altimate_change start — built-in commands for external AI CLI configuration + MCP discovery
  CONFIGURE_CLAUDE: "configure-claude",
  CONFIGURE_CODEX: "configure-codex",
  DISCOVER_MCPS: "discover-and-add-mcps",
  MCPS: "mcps",
  // altimate_change end
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        // altimate_change start — keep public command metadata compatible with shipped tests/docs
        description: "create/update AGENTS.md",
        // altimate_change end
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      // altimate_change start — restore /discover default command after upstream command merge
      commands[Default.DISCOVER] = {
        name: Default.DISCOVER,
        description: "scan data stack and set up connections",
        source: "command",
        get template() {
          return PROMPT_DISCOVER
        },
        hints: hints(PROMPT_DISCOVER),
      }
      // altimate_change end
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      // altimate_change start — configure commands for external AI CLIs + MCP discovery/listing
      commands[Default.CONFIGURE_CLAUDE] = {
        name: Default.CONFIGURE_CLAUDE,
        description: "configure /altimate command in Claude Code",
        source: "command",
        get template() {
          return PROMPT_CONFIGURE_CLAUDE
        },
        hints: hints(PROMPT_CONFIGURE_CLAUDE),
      }
      commands[Default.CONFIGURE_CODEX] = {
        name: Default.CONFIGURE_CODEX,
        description: "configure altimate skill in Codex CLI",
        source: "command",
        get template() {
          return PROMPT_CONFIGURE_CODEX
        },
        hints: hints(PROMPT_CONFIGURE_CODEX),
      }
      commands[Default.DISCOVER_MCPS] = {
        name: Default.DISCOVER_MCPS,
        description: "discover MCP servers from external AI tool configs and add them",
        source: "command",
        get template() {
          return PROMPT_DISCOVER_MCPS
        },
        hints: hints(PROMPT_DISCOVER_MCPS),
      }
      commands[Default.FEEDBACK] = {
        name: Default.FEEDBACK,
        description: "submit product feedback as a GitHub issue",
        source: "command",
        get template() {
          return PROMPT_FEEDBACK
        },
        hints: hints(PROMPT_FEEDBACK),
      }
      commands[Default.MCPS] = {
        name: Default.MCPS,
        description: "list added MCP servers and their connection status",
        source: "command",
        get template() {
          return "List all configured MCP servers and their current connection status."
        },
        hints: [],
      }
      // altimate_change end

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      // altimate_change start — MCP and skill loading must not prevent default commands from being served.
      // Wrap each in try/catch so init, review, and the configure/mcps commands are always available.
      // Note: MCP prompts can overwrite defaults (by name), but skills cannot
      // (the `if (commands[item.name]) continue` guard preserves defaults over skills).
      try {
        for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
          commands[name] = {
            name,
            source: "mcp",
            description: prompt.description,
            get template() {
              return bridge.promise(
                mcp
                  .getPrompt(
                    prompt.client,
                    prompt.name,
                    prompt.arguments
                      ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                      : {},
                  )
                  .pipe(
                    Effect.map(
                      (template) =>
                        template?.messages
                          .map((message) => (message.content.type === "text" ? message.content.text : ""))
                          .join("\n") || "",
                    ),
                  ),
              )
            },
            hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
          }
        }
      } catch (e) {
        Log.Default.warn("MCP prompt loading failed, continuing with defaults", {
          error: e instanceof Error ? e.message : String(e),
        })
      }

      try {
        for (const item of yield* skill.all()) {
          if (commands[item.name]) continue
          const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
          commands[item.name] = {
            name: item.name,
            description: item.description,
            source: "skill",
            get template() {
              if (!dir) return item.content
              return [
                item.content,
                "",
                `Base directory for this skill: ${dir}`,
                "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
              ].join("\n")
            },
            hints: [],
          }
        }
      } catch (e) {
        Log.Default.warn("Skill loading failed, continuing with defaults", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
      // altimate_change end

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: LayerNode.lazy(() => [Config.node, MCP.node, Skill.node]),
})

// altimate_change start — restore the imperative Promise wrapper upstream removed in the
// Effect-only migration; the HTTP server consumes Command.list() directly. defaultLayer is
// compiled from `node` since per-service `.defaultLayer` facades were dropped upstream.
export const defaultLayer = Layer.suspend(() => AppNodeBuilderV1.build(node)) as Layer.Layer<Service>
const { runPromise: runCommand } = makeRuntime(Service, defaultLayer)
export async function list() {
  return runCommand((s) => s.list())
}
export async function get(name: string) {
  return runCommand((s) => s.get(name))
}
// altimate_change end

export * as Command from "."
