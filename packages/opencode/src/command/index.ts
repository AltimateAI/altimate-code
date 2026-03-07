import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_DISCOVER from "./template/discover.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_FEEDBACK from "./template/feedback.txt"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { Log } from "../util/log"

export namespace Command {
  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      source: z.enum(["command", "mcp", "skill"]).optional(),
      // workaround for zod not supporting async functions natively so we use getters
      // https://zod.dev/v4/changelog?id=zfunction
      template: z.promise(z.string()).or(z.string()),
      subtask: z.boolean().optional(),
      hints: z.array(z.string()),
    })
    .meta({
      ref: "Command",
    })

  // for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
  export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

  export function hints(template: string): string[] {
    const result: string[] = []
    const numbered = template.match(/\$\d+/g)
    if (numbered) {
      for (const match of [...new Set(numbered)].sort()) result.push(match)
    }
    if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
    return result
  }

  export const Default = {
    INIT: "init",
    DISCOVER: "discover",
    REVIEW: "review",
    FEEDBACK: "feedback",
  } as const

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", Instance.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      },
      [Default.DISCOVER]: {
        name: Default.DISCOVER,
        description: "scan data stack and set up connections",
        source: "command",
        get template() {
          return PROMPT_DISCOVER
        },
        hints: hints(PROMPT_DISCOVER),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", Instance.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      },
      [Default.FEEDBACK]: {
        name: Default.FEEDBACK,
        description: "submit product feedback as a GitHub issue",
        source: "command",
        get template() {
          return PROMPT_FEEDBACK
        },
        hints: hints(PROMPT_FEEDBACK),
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
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
    // MCP and skill loading must not prevent default commands from being served.
    // Wrap each in try/catch so init, discover, review are always available.
    // Note: MCP prompts can overwrite defaults (by name), but skills cannot
    // (the `if (result[skill.name]) continue` guard preserves defaults over skills).
    try {
      for (const [name, prompt] of Object.entries(await MCP.prompts())) {
        result[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return MCP.getPrompt(
              prompt.client,
              prompt.name,
              prompt.arguments
                ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                : {},
            ).then((template) => {
              if (!template) throw new Error(`Failed to load MCP prompt: ${prompt.name}`)
              return template.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n")
            })
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }
    } catch (e) {
      Log.Default.warn("MCP prompt loading failed, continuing with defaults", {
        error: e instanceof Error ? e.message : String(e),
      })
    }

    // Add skills as invokable commands
    try {
      for (const skill of await Skill.all()) {
        // Skip if a command with this name already exists
        if (result[skill.name]) continue
        result[skill.name] = {
          name: skill.name,
          description: skill.description,
          source: "skill",
          get template() {
            return skill.content
          },
          hints: [],
        }
      }
    } catch (e) {
      Log.Default.warn("Skill loading failed, continuing with defaults", {
        error: e instanceof Error ? e.message : String(e),
      })
    }

    return result
  })

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }
}
