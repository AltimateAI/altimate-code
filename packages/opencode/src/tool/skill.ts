import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { Ripgrep } from "../file/ripgrep"
import { iife } from "@/util/iife"
// altimate_change start — import follow-up suggestions for conversational engagement
import { SkillFollowups } from "../skill/followups"
// altimate_change end
// altimate_change start - import for LLM-based dynamic skill selection
import { Fingerprint } from "../altimate/fingerprint"
import { Config } from "../config/config"
import { selectSkillsWithLLM } from "../altimate/skill-selector"
import { Telemetry } from "../altimate/telemetry"
import os from "os"

const MAX_DISPLAY_SKILLS = 50

// altimate_change start — classifySkillSource helper for skill telemetry + source badge
export function classifySkillSource(location: string): "builtin" | "global" | "project" {
  // Normalize separators so `.altimate/builtin` / homedir prefix match on Windows too.
  const normalized = location.replace(/\\/g, "/")
  // Embedded skills load with a `builtin:<name>/SKILL.md` location and Altimate's
  // bundled skills land under `~/.altimate/builtin/` — both are Altimate-shipped.
  // The node_modules match is scoped to Altimate-owned packages (`@altimateai/*` and
  // the `altimate-code` package) so a third-party skill installed under some other
  // `node_modules/<pkg>` isn't tagged as Altimate.
  if (
    normalized.startsWith("builtin:") ||
    // altimate_change — `<built-in>` is the sentinel used by the embedded
    // customization skill. Missing it here made `isBuiltin` false, so
    // `path.dirname("<built-in>")` resolved to "." and the file scan ran over
    // the user's entire project. (review)
    normalized === "<built-in>" ||
    /\/node_modules\/(@altimateai\/|altimate-code\/)/.test(normalized) ||
    normalized.includes(".altimate/builtin")
  )
    return "builtin"
  if (normalized.startsWith(os.homedir().replace(/\\/g, "/"))) return "global"
  return "project"
}
// altimate_change end
// altimate_change end

// altimate_change start — the `<available_skills>` block the Skill TOOL sends
// to the model on every turn, extracted so it can be tested directly. Testing
// the escaping helpers alone did not pin this: reverting these interpolations
// to raw `${skill.name}` left every test passing, which is how the missing
// `builtin:` guard survived here after being fixed in the prompt-side listing.
// Both renderers now share `neutralizeListingWrapper` and `formatSkillLocation`,
// so the escaping cannot diverge again; consolidating the two into one renderer
// outright is the remaining follow-up. (review)
// altimate_change start — the `<skill_content>` block, extracted so the BODY
// render site can be tested directly. Testing `neutralizeBodyWrapper` alone did
// not pin this: the regression being defended against is this site forgetting to
// call it, and the helper-only tests passed with the call removed. Same reason
// `renderAvailableSkills` exists. (bot review)
// altimate_change start — extracted so the CALL SITES are testable, not just the
// predicates they use. A test asserting `hasNoSkillDirectory("<built-in>")` stays
// true even if this site stops calling it — which is exactly how the previous
// regression here went unpinned. (review)
export function resolveSkillBase(location: string): { isBuiltin: boolean; dir: string; base: string } {
  const isBuiltin = Skill.hasNoSkillDirectory(location)
  const dir = isBuiltin ? "" : path.dirname(location)
  return { isBuiltin, dir, base: isBuiltin ? location : pathToFileURL(dir).href }
}

export function renderSkillFileEntry(file: string): string {
  return `<file>${Skill.neutralizeFilePathEntry(file)}</file>`
}
// altimate_change end

export function renderSkillContent(skill: Skill.Info, base: string, files: string): string[] {
  return [
    `<skill_content name="${Skill.escapeSkillAttr(skill.name)}">`,
    // The heading interpolates the same attacker-influenced frontmatter one line
    // below the attribute that was escaped for it — and it sits INSIDE
    // `<skill_content>`, so it needs the BODY tag set, not the listing one:
    // `neutralizeListingWrapper`'s `skill\b` does not match `skill_content`, so
    // a name ending `</skill_content>` broke out of the block entirely. Caught
    // by the render-site test added alongside this. (bot review)
    `# Skill: ${Skill.neutralizeSkillNameText(skill.name)}`,
    "",
    // The SKILL.md body is remote content for a synced bundle, and this
    // on-demand path is WIDER than the auto-load path that was already escaped.
    // Left raw it could close `</skill_content>` or forge a `<system-reminder>`.
    Skill.neutralizeBodyWrapper(skill.content.trim()),
    "",
    `Base directory for this skill: ${base}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    files,
    "</skill_files>",
    "</skill_content>",
  ]
}
// altimate_change end

export function renderAvailableSkills(skills: Skill.Info[]): string[] {
  return [
    "<available_skills>",
    ...skills.flatMap((skill) => [
      `  <skill>`,
      `    <name>${Skill.neutralizeListingWrapper(skill.name)}</name>`,
      `    <description>${Skill.neutralizeListingWrapper(skill.description ?? "")}</description>`,
      `    <location>${Skill.formatSkillLocation(skill.location)}</location>`,
      `  </skill>`,
    ]),
    "</available_skills>",
  ]
}
// altimate_change end

export const SkillTool = Tool.define("skill", async (ctx) => {
  const list = await Skill.available(ctx?.agent)

  // altimate_change start - LLM-based dynamic skill selection
  const cfg = await Config.get()
  let allAllowed: Skill.Info[]
  if (cfg.experimental?.env_fingerprint_skill_selection === true) {
    allAllowed = await selectSkillsWithLLM(
      list,
      Fingerprint.get(),
    )
  } else {
    allAllowed = list
  }
  const displaySkills = allAllowed.slice(0, MAX_DISPLAY_SKILLS)
  const hasMore = allAllowed.length > displaySkills.length
  // altimate_change end

  // altimate_change start - use displaySkills (filtered) instead of list
  const description =
    displaySkills.length === 0
      ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
      : [
          "Load a specialized skill that provides domain-specific instructions and workflows.",
          "",
          "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
          "",
          "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
          "",
          'Tool output includes a `<skill_content name="...">` block with the loaded content.',
          "",
          "The following skills provide specialized sets of instructions for particular tasks",
          "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
          "",
          ...renderAvailableSkills(displaySkills),
          // altimate_change start - add hint when skills are truncated
          ...(hasMore
            ? [
                "",
                `Note: Showing ${displaySkills.length} of ${allAllowed.length} available skills.`,
              ]
            : []),
          // altimate_change end
        ].join("\n")
  // altimate_change end

  // altimate_change start - use displaySkills for examples
  const examples = displaySkills
    // altimate_change — this hint is copied verbatim by the model as the `name`
    // argument, so whatever it advertises must match the real skill on lookup.
    // That rules out both escaping it (`&lt;name>` matches nothing) and
    // stripping brackets (`foo <bar>` -> `foobar`, breaking every legitimately
    // bracketed name — `isSkillFrontmatter` only requires a string, so names
    // CAN contain `<`/`>`). Instead, advertise only names the neutralizer would
    // leave untouched: those are exactly the ones that are both copyable and
    // free of trust-tag text. The authoritative listing above still carries
    // every skill, escaped. (bot review)
    .filter((skill) => Skill.neutralizeListingWrapper(skill.name) === skill.name)
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""
  // altimate_change end

  const parameters = z.object({
    name: z.string().describe(`The name of the skill from available_skills${hint}`),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      // altimate_change start — telemetry: startTime for skill_used duration
      const startTime = Date.now()
      // altimate_change end
      // altimate_change start - use upstream Skill.get() for exact name lookup
      const skill = await Skill.get(params.name)

      if (!skill) {
        const available = await Skill.all().then((s) => s.map((x) => x.name).join(", "))
        throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
      }
      // altimate_change end

      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })

      // altimate_change start — handle builtin: skills that have no filesystem directory
      // altimate_change — one predicate for "has no filesystem directory", covering
  // BOTH sentinels so a new one cannot be handled at one site and missed at
  // another. Deliberately NOT `classifySkillSource`: that answers "who shipped
  // this" and returns "builtin" for real directories too (`~/.altimate/builtin`,
  // Altimate-owned `node_modules`), whose bundled files must still be listed.
  // Using it here suppressed their resource directories. (bot review)
      const { isBuiltin, dir, base } = resolveSkillBase(skill.location)

      const limit = 10
      const files = isBuiltin
        ? ""
        : await iife(async () => {
            const arr = []
            for await (const file of Ripgrep.files({
              cwd: dir,
              follow: false,
              hidden: true,
              signal: ctx.abort,
            })) {
              if (file.includes("SKILL.md")) {
                continue
              }
              arr.push(path.resolve(dir, file))
              if (arr.length >= limit) {
                break
              }
            }
            return arr
          }).then((f) =>
            f
              // altimate_change — bundle file paths are remote too:
              // `safeRelativePath` rejects `..`, absolute paths and NUL, but
              // permits `<` and `>`. (review)
              .map((file) => renderSkillFileEntry(file))
              .join("\n"),
          )
      // altimate_change end

      // altimate_change start — append follow-up suggestions after skill content
      const followups = SkillFollowups.format(skill.name)
      // altimate_change end

      // altimate_change start — classify origin once, reused for telemetry and the source badge
      const skillOrigin = classifySkillSource(skill.location)
      // altimate_change end

      // altimate_change start — telemetry instrumentation for skill loading with trigger classification
      try {
        Telemetry.track({
          type: "skill_used",
          timestamp: Date.now(),
          session_id: ctx.sessionID,
          message_id: ctx.messageID,
          skill_name: skill.name,
          skill_source: skillOrigin,
          duration_ms: Date.now() - startTime,
          trigger: Telemetry.classifySkillTrigger(ctx.extra),
          has_followups: followups.length > 0,
          followup_count: SkillFollowups.get(skill.name).length,
        })
      } catch {
        // Telemetry must never break skill loading
      }
      // altimate_change end

      // altimate_change start — custom return with follow-ups, file listing, and base directory
      return {
        title: `Loaded skill: ${skill.name}`,
        output: [
          ...(followups ? [followups, ""] : []),
          // altimate_change — the name is frontmatter, so for a synced skill it is
          // attacker-influenced: a `"` breaks out of the attribute. Escaped like
          // the listing above. (review)
          ...renderSkillContent(skill, base, files),
        ].join("\n"),
        metadata: {
          name: skill.name,
          dir,
          // altimate_change start — origin drives the source badge (see altimate/tool-source.ts skillToolSource)
          skillOrigin,
          // altimate_change end
        },
      }
      // altimate_change end
    },
  }
})
