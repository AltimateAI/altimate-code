import z from "zod"
import path from "path"
import os from "os"
import matter from "gray-matter"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { Discovery } from "./discovery"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"
import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"

// Builtin skills embedded at build time — available in ALL distribution channels
// (npm, Homebrew, AUR, Docker) without relying on postinstall filesystem copies.
// Falls back to filesystem scan in dev mode when the global is undefined.
declare const OPENCODE_BUILTIN_SKILLS:
  | { name: string; content: string }[]
  | undefined

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  // External skill directories to search for (project-level and global)
  // These follow the directory layout used by Claude Code and other agents.
  const EXTERNAL_DIRS = [".claude", ".agents"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"

  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}
    const dirs = new Set<string>()

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      // Warn on duplicate skill names
      if (skills[parsed.data.name]) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: skills[parsed.data.name].location,
          duplicate: match,
        })
      }

      dirs.add(path.dirname(match))

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
      }
    }

    const scanExternal = async (root: string, scope: "global" | "project") => {
      return Glob.scan(EXTERNAL_SKILL_PATTERN, {
        cwd: root,
        absolute: true,
        include: "file",
        dot: true,
        symlink: true,
      })
        .then((matches) => Promise.all(matches.map(addSkill)))
        .catch((error) => {
          log.error(`failed to scan ${scope} skills`, { dir: root, error })
        })
    }

    // Load builtin skills — prefer filesystem (supports @references), fall back
    // to binary-embedded data (works without postinstall for Homebrew/AUR/Docker).
    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      let loadedFromFs = false

      // Try filesystem first — postinstall copies skills (including references/) to
      // ~/.altimate/builtin/. Filesystem paths are required for @references resolution.
      const builtinDir = path.join(Global.Path.home, ".altimate", "builtin")
      if (await Filesystem.isDir(builtinDir)) {
        const matches = await Glob.scan(SKILL_PATTERN, {
          cwd: builtinDir,
          absolute: true,
          include: "file",
          symlink: true,
        })
        if (matches.length > 0) {
          await Promise.all(matches.map(addSkill))
          loadedFromFs = true
        }
      }

      // Fallback: load from binary-embedded data when filesystem is unavailable
      // (e.g. Homebrew, AUR, Docker installs that skip npm postinstall).
      // Note: @references won't resolve for embedded skills, but core functionality works.
      if (!loadedFromFs && typeof OPENCODE_BUILTIN_SKILLS !== "undefined") {
        for (const entry of OPENCODE_BUILTIN_SKILLS) {
          try {
            const md = matter(entry.content)
            const meta = Info.pick({ name: true, description: true }).safeParse(md.data)
            if (!meta.success) continue
            skills[meta.data.name] = {
              name: meta.data.name,
              description: meta.data.description,
              location: `builtin:${entry.name}/SKILL.md`,
              content: md.content,
            }
          } catch (err) {
            log.error("failed to parse embedded skill", { skill: entry.name, err })
          }
        }
        log.info("loaded embedded builtin skills", { count: OPENCODE_BUILTIN_SKILLS.length })
      }
    }

    // Scan external skill directories (.claude/skills/, .agents/skills/, etc.)
    // Load global (home) first, then project-level (so project-level overwrites)
    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (!(await Filesystem.isDir(root))) continue
        await scanExternal(root, "global")
      }

      for await (const root of Filesystem.up({
        targets: EXTERNAL_DIRS,
        start: Instance.directory,
        stop: Instance.worktree,
      })) {
        await scanExternal(root, "project")
      }
    }

    // Scan .opencode/skill/ directories
    for (const dir of await Config.directories()) {
      const matches = await Glob.scan(OPENCODE_SKILL_PATTERN, {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    // Scan additional skill paths from config
    const config = await Config.get()
    for (const skillPath of config.skills?.paths ?? []) {
      const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath
      const resolved = path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded)
      if (!(await Filesystem.isDir(resolved))) {
        log.warn("skill path not found", { path: resolved })
        continue
      }
      const matches = await Glob.scan(SKILL_PATTERN, {
        cwd: resolved,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    // Download and load skills from URLs
    for (const url of config.skills?.urls ?? []) {
      const list = await Discovery.pull(url)
      for (const dir of list) {
        dirs.add(dir)
        const matches = await Glob.scan(SKILL_PATTERN, {
          cwd: dir,
          absolute: true,
          include: "file",
          symlink: true,
        })
        for (const match of matches) {
          await addSkill(match)
        }
      }
    }

    return {
      skills,
      dirs: Array.from(dirs),
    }
  })

  export async function get(name: string) {
    return state().then((x) => x.skills[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x.skills))
  }

  export async function dirs() {
    return state().then((x) => x.dirs)
  }

  export async function available(agent?: Agent.Info) {
    const list = await all()
    if (!agent) return list
    return list.filter((skill) => PermissionNext.evaluate("skill", skill.name, agent.permission).action !== "deny")
  }

  export function fmt(list: Info[], opts: { verbose: boolean }) {
    if (list.length === 0) {
      return "No skills are currently available."
    }
    if (opts.verbose) {
      return [
        "<available_skills>",
        ...list.flatMap((skill) => [
          `  <skill>`,
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${skill.location.startsWith("builtin:") ? skill.location : pathToFileURL(skill.location).href}</location>`,
          `  </skill>`,
        ]),
        "</available_skills>",
      ].join("\n")
    }
    return ["## Available Skills", ...list.flatMap((skill) => `- **${skill.name}**: ${skill.description}`)].join("\n")
  }
}
