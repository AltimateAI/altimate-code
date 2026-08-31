import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
// altimate_change start — for auto-load skill matching against project files
import { Glob } from "../util/glob"
import { Log } from "../util/log"
// altimate_change end

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
// altimate_change start — shared family→vendor classifier (see #888 J1)
import { familyVendor } from "../provider/family"
// altimate_change end

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import { Skill } from "@/skill"
// altimate_change start - import for env-based skill selection
import { Fingerprint } from "../altimate/fingerprint"
import { Config } from "../config/config"
import { selectSkillsWithLLM } from "../altimate/skill-selector"
// altimate_change start — Effect Service facade for SystemPrompt.skills (see bottom of namespace)
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
// altimate_change end
// altimate_change end

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
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
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Workspace root folder: ${Instance.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        // altimate_change start — keep the date in the ambient <env> block. Carrying it on the
        // trailing user message (the prior approach) made models treat it as user-provided and
        // echo it back every turn ("Today's date is …" on a bare "hi"). In <env> it reads as
        // ambient context the model does not repeat. Only cost: a rare cache re-warm if a
        // session crosses midnight within the prompt-cache TTL — negligible.
        `  Today's date: ${new Date().toDateString()}`,
        // altimate_change end
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  // altimate_change start — upstream_fix: date carried outside the cached system prefix
  export function currentDate() {
    return `Today's date is ${new Date().toDateString()}.`
  }
  // altimate_change end

  export async function skills(agent: Agent.Info) {
    if (PermissionNext.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)

    // altimate_change start - apply env-based skill selection
    const cfg = await Config.get()
    let filtered: Skill.Info[]
    if (cfg.experimental?.env_fingerprint_skill_selection === true) {
      filtered = await selectSkillsWithLLM(list, Fingerprint.get())
    } else {
      filtered = list
    }
    // Sort by name for stable, deterministic output across calls.
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name))
    // altimate_change end

    // altimate_change start — auto-load skill bodies for skills marked
    // `alwaysApply: true` (unconditional) or whose `applyPaths` glob matches
    // at least one file in the worktree. This mirrors Cursor's "Always Apply"
    // and "Auto Attached" rule modes — the skill body lands in the system
    // prompt deterministically instead of waiting for the agent to invoke the
    // Skill tool (observed in benchmark traces to fire <1% of tool calls).
    //
    // Placement: auto-loaded bodies go FIRST, before the lazy-loaded
    // <available_skills> XML block. Benchmark trace analysis showed that
    // when the auto-load block was placed at the END of the skills section,
    // the model treated it as background reference rather than binding
    // directive, and frequently failed to apply its guidance even when
    // explicitly relevant. Putting it first frames it as "rules of the road"
    // for the session before listing optional on-demand skills.
    const autoLoaded = await collectAutoLoadedSkills(filtered)
    const parts: string[] = []
    if (autoLoaded.length > 0) {
      parts.push(
        "The following skill(s) are auto-loaded because they apply to this project.",
        "Treat their content as binding guidance for any related work — you do not need to",
        "invoke the Skill tool again to access them.",
      )
      for (const skill of autoLoaded) {
        parts.push("")
        parts.push(`<auto_loaded_skill name="${escapeXmlAttr(skill.name)}">`)
        // altimate_change start — neutralise the closing tag inside the body.
        // The name is escaped but the body was not, so content containing
        // `</auto_loaded_skill>` closed the wrapper and continued as unwrapped
        // system-prompt text — able to impersonate the harness's own framing,
        // directly after the prompt has told the model to treat this as binding
        // guidance. Skill bodies are now remote content (a bound workspace
        // syncs them), so this is reachable by anyone who can upload a skill.
        // Deliberately not a full XML escape: bodies legitimately contain code
        // and angle brackets, and mangling those would break working skills.
        parts.push(neutralizeSkillWrapper(skill.content.trim()))
        // altimate_change end
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
  }
  // altimate_change end

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

  // altimate_change start — see the auto-loaded skill block below.
  function neutralizeSkillWrapper(content: string): string {
    return content.replace(/<(\/?)auto_loaded_skill\b/gi, "&lt;$1auto_loaded_skill")
  }
  // altimate_change end

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
    // `Glob.exists` rather than `scan(...).length > 0`: this only needs to know whether any
    // file matches, and `scan` walks the whole tree before the caller can look. That cost is
    // paid once per `applyPaths` skill — two ship builtin — and the root is the worktree, which
    // is `/` for a directory outside any git repo. Measured from such a directory, the two
    // scans were ~45s of a ~51s startup, all of it before the first token.
    const root = Instance.worktree
    for (const g of globs) {
      if (
        await Glob.exists(g, {
          cwd: root,
          absolute: true,
          include: "file",
          dot: false,
          symlink: false,
        })
      )
        return true
    }
    return false
  }
  // altimate_change end

  // altimate_change start — Effect Service facade delegating to the namespace skills() fn
  export interface Interface {
    readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  }
  export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}
  export const layer = Layer.succeed(
    Service,
    Service.of({
      skills: (agent: Agent.Info) => Effect.promise(() => skills(agent)),
    }),
  )
  export const defaultLayer = layer
  export const node = LayerNode.make(layer, [])
  // altimate_change end
}
