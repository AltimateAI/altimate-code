import { LayerNode } from "@opencode-ai/core/effect/layer-node"
// altimate_change start — makeRuntime for the restored Promise wrapper (see bottom of file)
import { makeRuntime } from "@/effect/run-service"
// altimate_change end
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
// altimate_change start — upstream_fix: builtin DE-skill loading (dropped by the v1.17.9 rewrite; see make())
import matter from "gray-matter"
declare const OPENCODE_BUILTIN_SKILLS: { name: string; content: string }[] | undefined
// altimate_change end

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// altimate_change start — built-in customization skill branding
// Built-in skill that ships with Altimate Code. The model's intuition for what
// altimate-code.json should look like is often wrong, and Altimate Code
// hard-fails on invalid config, so users hit cryptic startup errors. Loading
// this skill when the model is asked to touch Altimate Code's own config files
// gives it the actual schemas instead of guesses.
// altimate_change end
const CUSTOMIZE_OPENCODE_SKILL_NAME = "customize-opencode"
// altimate_change start — built-in customization skill branding
const CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating Altimate Code's own configuration: altimate-code.json, opencode.json, opencode.jsonc, files under .altimate-code/, files under .opencode/, or files under ~/.config/altimate-code/. Also use when creating or fixing Altimate Code agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring Altimate Code itself."
// altimate_change end
const CUSTOMIZE_OPENCODE_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
  // altimate_change start — auto-load frontmatter fields (Cursor-style "Always Apply"/"Auto Attached");
  //   alwaysApply: true            — unconditional auto-load into the system prompt
  //   applyPaths:  "dbt_project.yml" | ["pyproject.toml", "schema.yml"] — glob-gated auto-load
  alwaysApply: Schema.optional(Schema.Boolean),
  applyPaths: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  // altimate_change end
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(
  data: unknown,
): data is { name: string; description?: string; alwaysApply?: boolean; applyPaths?: string | string[] } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  // altimate_change start — drop the per-instance discovery/registry caches so
  // the next read re-scans disk. Skills can appear mid-session: a workspace
  // bind, or a poll that finds new bundles, writes them under the project
  // config dir, and both caches below are otherwise populated once per instance
  // and never refreshed.
  readonly refresh: () => Effect.Effect<void>
  // altimate_change end
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
    // altimate_change start — carry auto-load frontmatter through to Info
    alwaysApply: typeof md.data.alwaysApply === "boolean" ? md.data.alwaysApply : undefined,
    applyPaths:
      typeof md.data.applyPaths === "string" || Array.isArray(md.data.applyPaths) ? md.data.applyPaths : undefined,
    // altimate_change end
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_OPENCODE_SKILL_NAME] = {
          name: CUSTOMIZE_OPENCODE_SKILL_NAME,
          description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        }
        // altimate_change start — upstream_fix: load the builtin DE skills (dbt/finops/etc.) into the
        // LIVE registry. The v1.17.9 rewrite of this module dropped the builtin loader (it survives only
        // in the now-orphaned skill.ts), so on installs without ~/.altimate/builtin/ (Homebrew, Docker,
        // npm without postinstall) the ~11 builtin skills silently vanished from <available_skills>, the
        // Skill tool, and auto-load. Restore both paths: prefer the postinstall FS copy (needed for
        // @reference resolution), else the binary-embedded blob. Registered BEFORE loadSkills so a
        // user-disk skill of the same name still overrides.
        let loadedBuiltinFromFs = false
        const builtinDir = path.join(global.home, ".altimate", "builtin")
        if (yield* fsys.isDir(builtinDir)) {
          const matches = yield* Effect.tryPromise(() =>
            Glob.scan("**/SKILL.md", { cwd: builtinDir, absolute: true, include: "file", symlink: true }),
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          if (matches.length > 0) {
            yield* Effect.forEach(matches, (m) => add(s, m, events), { discard: true })
            loadedBuiltinFromFs = true
          }
        }
        if (!loadedBuiltinFromFs && typeof OPENCODE_BUILTIN_SKILLS !== "undefined") {
          for (const entry of OPENCODE_BUILTIN_SKILLS) {
            try {
              const md = matter(entry.content)
              if (!isSkillFrontmatter(md.data)) continue
              if (s.skills[md.data.name]) continue
              s.skills[md.data.name] = {
                name: md.data.name,
                description: md.data.description,
                location: `builtin:${entry.name}/SKILL.md`,
                content: md.content,
                alwaysApply: typeof md.data.alwaysApply === "boolean" ? md.data.alwaysApply : undefined,
                applyPaths:
                  typeof md.data.applyPaths === "string" || Array.isArray(md.data.applyPaths)
                    ? md.data.applyPaths
                    : undefined,
              }
            } catch (err) {
              yield* Effect.logError("failed to parse embedded builtin skill", { skill: entry.name, error: err })
            }
          }
        }
        // altimate_change end
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    // altimate_change start — see Interface.refresh. `discovered` and `state`
    // are separate InstanceStates and `state` closes over the discovery result,
    // so invalidating only `discovered` would leave a stale registry.
    const refresh = Effect.fn("Skill.refresh")(function* () {
      yield* InstanceState.invalidate(discovered)
      yield* InstanceState.invalidate(state)
    })

    // altimate_change: `refresh` added to the upstream service surface
    return Service.of({ get, require, all, dirs, available, refresh })
    // altimate_change end
  }),
)

// altimate_change start — Layer.suspend defers facade refs past circular module-init
export const defaultLayer = Layer.suspend(() => layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
))
// altimate_change end

// altimate_change start — see the call sites inside `fmt`.
// Exported because `tool/skill.ts` builds the SAME `<available_skills>` listing
// for the Skill tool's own description, which is sent to the model on EVERY
// turn — a wider exposure than either prompt-side site. It must escape through
// this one function so the two listings cannot drift apart again. (review)
//
// `system-reminder` and `auto_loaded_skill` are in the list even though this
// function does not emit them: the harness uses both as trust boundaries
// elsewhere in the same message stream, so remote skill text must not be able
// to forge either one. (review)
export const TRUST_BOUNDARY_TAGS = [
  "available_skills",
  "skill",
  "name",
  "description",
  "location",
  "system-reminder",
  "auto_loaded_skill",
] as const

export function neutralizeListingWrapper(text: string): string {
  // Neutralise only the `<`, via a lookahead, so the rest of the text survives
  // byte-for-byte. Whitespace is permitted between `<`, `/` and the tag name
  // because the consumer is a language model, not an XML parser: a model
  // reading `</ description>` or `< system-reminder>` mid-listing may well take
  // it as a boundary, and the earlier `<(\/?)(tag)` form let both through. (review)
  return text.replace(
    new RegExp(`<(?=\\s*/?\\s*(?:${TRUST_BOUNDARY_TAGS.join("|")})\\b)`, "gi"),
    "&lt;",
  )
}

/** A built-in skill's `location` is a `builtin:` URI, not a filesystem path.
 * `pathToFileURL` would resolve it against the CWD and emit a path that does
 * not exist. Shared by every renderer so the guard cannot be applied to one
 * listing and forgotten at another — which is exactly how it was missed. */
//
// `location` appears in TRUST_BOUNDARY_TAGS but is deliberately not passed
// through the neutralizer: the value is either a `builtin:` URI we control or a
// `pathToFileURL` result, and that percent-encodes `<`/`>` to `%3C`/`%3E`
// (verified), so a `public_id` containing them cannot forge a tag here. The tag
// stays in the list so hostile text elsewhere cannot mint a `<location>`.
// (review)
export function formatSkillLocation(location: string): string {
  return location.startsWith("builtin:") ? location : pathToFileURL(location).href
}

// altimate_change end

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          // altimate_change start — neutralise the listing's own wrapper tags.
          // `name` and `description` come from bundle frontmatter, and a bound
          // workspace syncs those from a remote server, so both are attacker
          // controlled by anyone who can upload a skill. This path is the more
          // exposed of the two: an auto-loaded body needs `alwaysApply`, whereas
          // EVERY synced skill's description lands here in EVERY session. A
          // description ending `</description></skill></available_skills>` would
          // otherwise close the listing and continue as unwrapped system-prompt
          // text. Deliberately not a full XML escape — descriptions legitimately
          // contain code and angle brackets. (review)
          `    <name>${neutralizeListingWrapper(skill.name)}</name>`,
          `    <description>${neutralizeListingWrapper(skill.description ?? "")}</description>`,
          // altimate_change end
          // altimate_change start — a built-in skill's `location` is a
          // `builtin:` URI, not a filesystem path, so `pathToFileURL` resolved
          // it against the CWD and emitted a location that does not exist
          // (`file:///…/packages/opencode/builtin:my-skill/SKILL.md`). The
          // now-deleted duplicate renderer in `./skill.ts` had this guard and
          // this one never did; the divergence surfaced when its tests were
          // repointed here. (review)
          `    <location>${formatSkillLocation(skill.location)}</location>`,
          // altimate_change end
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      // altimate_change — the same untrusted metadata as the verbose branch. No
      // production caller passes `verbose: false` today, so this is latent
      // rather than live — but an unescaped second path on the same function is
      // the exact shape of the bug this release exists to close. (review)
      .map((skill) => `- **${neutralizeListingWrapper(skill.name)}**: ${neutralizeListingWrapper(skill.description ?? "")}`),
  ].join("\n")
}

// altimate_change start — thunk LayerNode deps defers facade refs past circular module-init
export const node = LayerNode.make(layer, () => [
  Discovery.node,
  Config.node,
  EventV2Bridge.node,
  FSUtil.node,
  Global.node,
  RuntimeFlags.node,
])
// altimate_change end

// altimate_change start — restore the imperative Promise wrapper upstream removed. project-scan's
// environment census calls `await Skill.all()` from plain async code; bind it through makeRuntime.
const { runPromise: runSkill } = makeRuntime(Service, defaultLayer)
export async function all() {
  return runSkill((svc) => svc.all())
}
export async function get(name: string) {
  return runSkill((svc) => svc.get(name))
}
export async function available(agent?: Agent.Info) {
  return runSkill((svc) => svc.available(agent))
}
// Imperative wrapper for the same reason as the three above: the workspace
// skill sync is plain async code running under the instance ALS, which
// `attach()` propagates into this runtime. No marker of its own — this is
// already inside the block opened above, and nesting them makes marker
// coverage harder to account for. (bot review)
export async function refresh() {
  return runSkill((svc) => svc.refresh())
}
// altimate_change end

export * as Skill from "."
