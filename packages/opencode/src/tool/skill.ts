import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { PermissionNext } from "../permission/next"
import { Ripgrep } from "../file/ripgrep"
import { iife } from "@/util/iife"
// altimate_change start - import fingerprint for environment-aware skill filtering
import { Fingerprint } from "../altimate/fingerprint"
import { MessageContext } from "../altimate/context/message-context"
import { Config } from "../config/config"

const MAX_DISPLAY_SKILLS = 50
// altimate_change end

export const SkillTool = Tool.define("skill", async (ctx) => {
  const skills = await Skill.all()

  // Filter skills by agent permissions if agent provided
  const agent = ctx?.agent
  const accessibleSkills = agent
    ? skills.filter((skill) => {
        const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
        return rule.action !== "deny"
      })
    : skills

  // altimate_change start - filter skills by environment fingerprint tags with message rescue
  const cfg = await Config.get()
  let allAllowed: Skill.Info[]
  if (cfg.experimental?.dynamic_skills) {
    const fingerprint = Fingerprint.get()
    const { included, excluded } = partitionByFingerprint(accessibleSkills, fingerprint)
    const rescued = rescueByMessage(excluded, MessageContext.get())
    allAllowed = [...included, ...rescued]
  } else {
    allAllowed = accessibleSkills
  }
  const displaySkills = allAllowed.slice(0, MAX_DISPLAY_SKILLS)
  const hasMore = allAllowed.length > displaySkills.length
  // altimate_change end

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
          "<available_skills>",
          ...displaySkills.flatMap((skill) => [
            `  <skill>`,
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            `    <location>${pathToFileURL(skill.location).href}</location>`,
            `  </skill>`,
          ]),
          "</available_skills>",
          // altimate_change start - add hint when skills are truncated
          ...(hasMore
            ? [
                "",
                `Note: Showing ${displaySkills.length} of ${allAllowed.length} available skills.`,
              ]
            : []),
          // altimate_change end
        ].join("\n")

  const examples = displaySkills
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z.object({
    name: z.string().describe(`The name of the skill from available_skills${hint}`),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
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

      const dir = path.dirname(skill.location)
      const base = pathToFileURL(dir).href

      const limit = 10
      const files = await iife(async () => {
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
      }).then((f) => f.map((file) => `<file>${file}</file>`).join("\n"))

      return {
        title: `Loaded skill: ${skill.name}`,
        output: [
          `<skill_content name="${skill.name}">`,
          `# Skill: ${skill.name}`,
          "",
          skill.content.trim(),
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          files,
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
        metadata: {
          name: skill.name,
          dir,
        },
      }
    },
  }
})

// altimate_change start - partition skills by fingerprint + rescue by message
/**
 * Partition skills into included/excluded based on environment fingerprint tags.
 * Skills without tags always go to included (backward compatible).
 * Skills with tags that match the fingerprint go to included; others to excluded.
 */
export function partitionByFingerprint(
  skills: Skill.Info[],
  fingerprint: Fingerprint.Result | undefined,
): { included: Skill.Info[]; excluded: Skill.Info[] } {
  if (!fingerprint || fingerprint.tags.length === 0) {
    return { included: skills, excluded: [] }
  }
  const envTags = new Set(fingerprint.tags.map((t) => t.toLowerCase()))
  const included: Skill.Info[] = []
  const excluded: Skill.Info[] = []
  for (const skill of skills) {
    if (!skill.tags || skill.tags.length === 0) {
      included.push(skill)
    } else if (skill.tags.some((tag) => envTags.has(tag.toLowerCase()))) {
      included.push(skill)
    } else {
      excluded.push(skill)
    }
  }
  return { included, excluded }
}

/**
 * Rescue excluded skills whose tags appear as words in the user's message.
 * Uses set intersection: build word set from message, build tag→skills map,
 * then find tags present in both.
 */
export function rescueByMessage(
  excluded: Skill.Info[],
  messageText: string | undefined,
): Skill.Info[] {
  if (!messageText || excluded.length === 0) return []

  // Strip punctuation (preserve hyphens), lowercase, split into words, skip <3 chars
  const cleaned = messageText.toLowerCase().replace(/[^\w\s-]/g, " ")
  const words = new Set(cleaned.split(/\s+/).filter((w) => w.length > 2))

  // Build tag → skills map from excluded pool
  const tagToSkills = new Map<string, Skill.Info[]>()
  for (const skill of excluded) {
    for (const tag of skill.tags ?? []) {
      const key = tag.toLowerCase()
      const arr = tagToSkills.get(key) ?? []
      arr.push(skill)
      tagToSkills.set(key, arr)
    }
  }

  // Set intersection: find tags that appear in both sets
  const rescued = new Set<Skill.Info>()
  for (const tag of tagToSkills.keys()) {
    if (words.has(tag)) {
      for (const skill of tagToSkills.get(tag)!) {
        rescued.add(skill)
      }
    }
  }

  return [...rescued]
}
// altimate_change end
