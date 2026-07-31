import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"
import { Instance } from "../project/instance"
// altimate_change start — for auto-load skill matching against project files
import { Glob } from "../util/glob"
import { Log } from "../util/log"
// altimate_change end

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"
import PROMPT_META from "./prompt/meta.txt"
// altimate_change start — shared family→vendor classifier (see #888 J1)
import { familyVendor } from "../provider/family"
// altimate_change end

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Reference } from "@opencode-ai/core/reference"
import { MCP } from "@/mcp"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
// altimate_change start - import for env-based skill selection
import { Fingerprint } from "../altimate/fingerprint"
import { Config } from "../config/config"
import { selectSkillsWithLLM } from "../altimate/skill-selector"
// altimate_change end
// altimate_change start — makeRuntime for the restored Promise-based facade functions (bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end

export function instructions() {
  return PROMPT_CODEX.trim()
}

export function provider(model: Provider.Model) {
  if (model.api.id.includes("muse-spark")) return [PROMPT_META]
  // altimate_change start — route altimate-backend gateway models by `family`
  // before the api.id string-match fallthrough. The gateway's model.api.id is
  // the opaque alias `altimate-default` (kept stable for backward compat —
  // users persist it in model.json), which matches none of the patterns below.
  // Use the shared `familyVendor` classifier so specific family values
  // (`claude-sonnet`, `gemini-pro`, `gpt-codex`, …) map to the right vendor.
  // An exact `family === "anthropic"` check would silently fall through to
  // PROMPT_CODEX on any altimate-backend gateway path that exposes a Claude
  // model with the specific family — recreating the #887 misrouting class
  // this PR is meant to fix (see #888 J1).
  // Unknown vendors default to PROMPT_CODEX because the gateway is registered
  // as `@ai-sdk/openai-compatible`.
  if (model.providerID === "altimate-backend") {
    switch (familyVendor(model.family)) {
      case "anthropic":
        return [PROMPT_ANTHROPIC]
      case "gemini":
        return [PROMPT_GEMINI]
      default:
        return [PROMPT_CODEX]
    }
  }
  // altimate_change end
  // altimate_change start — gpt-5 responds better to the Codex-style header prompt than the
  // generic BEAST/GPT prompts below; route it to PROMPT_CODEX regardless of whether "codex"
  // literally appears in the model id (upstream's codex branch below only fires on that substring).
  if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
  // altimate_change end
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_ANTHROPIC_WITHOUT_TODO]
}

// altimate_change start — upstream_fix: date carried outside the cached system prefix.
// In practice superseded by the ambient `<env>` date line in environment() below (which reads
// as ambient context instead of a user-turn echo target), but kept intact because
// test/skill/release-v0.8.10-adversarial.test.ts (#950) calls this directly to guard the
// original regression. UNSURE: flagged in the merge report — worth a follow-up to confirm
// nothing still depends on the old trailing-user-message placement this was written for.
export function currentDate() {
  return `Today's date is ${new Date().toDateString()}.`
}
// altimate_change end

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly mcp: (agent: Agent.Info, permission?: PermissionV1.Ruleset) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

// altimate_change start — helpers for auto-load skill selection
const autoLoadLog = Log.create({ service: "system-prompt-autoload" })

/**
 * Escape special characters so a skill name is safe inside an XML attribute.
 *
 * Beyond the four standard XML metacharacters (`&`, `"`, `<`, `>`), this
 * also handles:
 *   - Control characters disallowed by XML 1.0 (anything < 0x20 except
 *     TAB/LF/CR is stripped to avoid invalid XML).
 *   - Newline (LF), carriage return (CR), TAB encoded as their numeric
 *     character refs so the attribute value renders on a single line in
 *     downstream log readers / grep / awk.
 */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;")
    // XML 1.0 forbids most control characters in any value; strip them
    // entirely. The kept-as-entity TAB/LF/CR cases above are already handled.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
}

async function collectAutoLoadedSkills(list: Skill.Info[]): Promise<Skill.Info[]> {
  const out: Skill.Info[] = []
  for (const skill of list) {
    if (skill.alwaysApply === true) {
      out.push(skill)
      continue
    }
    const globs = normalizeApplyPaths(skill.applyPaths)
    if (globs.length === 0) continue
    try {
      const matched = await anyMatchInWorktree(globs)
      if (matched) {
        out.push(skill)
        autoLoadLog.info("skill auto-loaded by applyPaths", {
          skill: skill.name,
          globs,
        })
      }
    } catch (err) {
      autoLoadLog.warn("applyPaths glob scan failed", { skill: skill.name, err })
    }
  }
  return out
}

function normalizeApplyPaths(v: Skill.Info["applyPaths"]): string[] {
  if (!v) return []
  if (typeof v === "string") return [v]
  return v.filter((s) => typeof s === "string" && s.length > 0)
}

async function anyMatchInWorktree(globs: string[]): Promise<boolean> {
  // Search from worktree root so a skill that wants `dbt_project.yml`
  // catches the file no matter how deep the user's cwd is.
  // Errors propagate to the caller's try/catch (collectAutoLoadedSkills)
  // so the warning log there actually fires.
  const root = Instance.worktree
  for (const g of globs) {
    const matches = await Glob.scan(g, {
      cwd: root,
      absolute: true,
      include: "file",
      dot: false,
      symlink: false,
    })
    if (matches.length > 0) return true
  }
  return false
}
// altimate_change end

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            // altimate_change start — keep the date in the ambient <env> block. Carrying it on
            // the trailing user message (an older approach) made models treat it as
            // user-provided and echo it back every turn ("Today's date is …" on a bare "hi").
            // In <env> it reads as ambient context the model does not repeat. Only cost: a rare
            // cache re-warm if a session crosses midnight within the prompt-cache TTL — negligible.
            `  Today's date: ${new Date().toDateString()}`,
            // altimate_change end
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      // altimate_change start — env-based skill selection + auto-load skill bodies. Auto-loaded
      // bodies go FIRST, before the lazy-loaded <available_skills> XML block: benchmark trace
      // analysis showed that when the auto-load block was placed at the END of the skills
      // section, the model treated it as background reference rather than binding directive,
      // and frequently failed to apply its guidance even when explicitly relevant. Putting it
      // first frames it as "rules of the road" for the session before listing optional
      // on-demand skills. See helper functions above for the auto-load matching logic.
      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        const cfg = yield* Effect.promise(() => Config.get())
        let filtered: Skill.Info[]
        if (cfg.experimental?.env_fingerprint_skill_selection === true) {
          filtered = yield* Effect.promise(() => selectSkillsWithLLM(list, Fingerprint.get()))
        } else {
          filtered = list
        }
        // Sort by name for stable, deterministic output across calls.
        filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name))

        const autoLoaded = yield* Effect.promise(() => collectAutoLoadedSkills(filtered))
        const parts: string[] = []
        if (autoLoaded.length > 0) {
          parts.push(
            "The following skill(s) are auto-loaded because they apply to this project.",
            "Treat their content as binding guidance for any related work — you do not need to",
            "invoke the Skill tool again to access them.",
          )
          for (const loaded of autoLoaded) {
            parts.push("")
            parts.push(`<auto_loaded_skill name="${escapeXmlAttr(loaded.name)}">`)
            parts.push(loaded.content.trim())
            parts.push(`</auto_loaded_skill>`)
          }
          parts.push("")
        }
        parts.push(
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(filtered, { verbose: true }),
        )
        return parts.join("\n")
      }),
      // altimate_change end

      mcp: Effect.fn("SystemPrompt.mcp")(function* (agent: Agent.Info, permission?: PermissionV1.Ruleset) {
        const ruleset = Permission.merge(agent.permission, permission ?? [])
        const instructions = (yield* mcp.instructions()).filter(
          (item) => item.tools.length === 0 || Permission.disabled(item.tools, ruleset).size < item.tools.length,
        )
        if (instructions.length === 0) return

        return [
          "<mcp_instructions>",
          ...instructions.flatMap((item) => [
            `  <server name="${item.name}">`,
            ...item.instructions.split("\n").map((line) => `    ${line}`),
            "  </server>",
          ]),
          "</mcp_instructions>",
        ].join("\n")
      }),
    })
  }),
)

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

// Matches upstream verbatim — the fork's original node here also had empty deps (no facade
// import-cycle risk to guard against), so no lazy-deps thunk is needed.
export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Skill.node, MCP.node, locationServiceMapNode],
})

// altimate_change start — Layer.suspend defers facade refs past circular module-init; restores
// the imperative Promise-based facade upstream removed in the Effect-only migration. The session
// prompt loop consumes SystemPrompt.environment/.skills synchronously rather than through the
// Effect Service directly.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(locationServiceMapLayer),
  ),
)

const { runPromise: runSystemPrompt } = makeRuntime(Service, defaultLayer as Layer.Layer<Service>)

export async function environment(model: Provider.Model) {
  return runSystemPrompt((s) => s.environment(model))
}
export async function skills(agent: Agent.Info) {
  return runSystemPrompt((s) => s.skills(agent))
}
export async function mcpInstructions(agent: Agent.Info, permission?: PermissionV1.Ruleset) {
  return runSystemPrompt((s) => s.mcp(agent, permission))
}
// altimate_change end

export * as SystemPrompt from "./system"
