import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { Ripgrep } from "../file/ripgrep"
import { iife } from "@/util/iife"
// altimate_change start - import for LLM-based dynamic skill selection
import { Fingerprint } from "../altimate/fingerprint"
import { Config } from "../config/config"
import { selectSkillsWithLLM } from "../altimate/skill-selector"

const MAX_DISPLAY_SKILLS = 50
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
  // altimate_change end

  // altimate_change start - use displaySkills for examples
  const examples = displaySkills
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

// altimate_change end - old partitionByFingerprint + rescueByMessage removed, replaced by selectSkillsWithLLM
