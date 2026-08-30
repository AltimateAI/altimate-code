import z from "zod"
import { Filesystem } from "../util/filesystem"
import path from "path"
import { and, Database, eq } from "../storage/db"
// altimate_change start — upstream_fix: preserve session recency during project migration.
import { sql } from "../storage/db"
// altimate_change end
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
// altimate_change start — core SQL tables brand project ids as "Project.ID"; the fork uses
// the "ProjectID" brand. ProjectV2.ID.make re-brands fork->core for column reads/writes
// (identity at runtime). ProjectID.make re-brands core->fork.
import { ProjectV2 } from "@opencode-ai/core/project"
// core ProjectTable brands worktree/sandboxes columns as AbsolutePath; AbsolutePath.make
// re-brands plain strings (identity at runtime).
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database as EffectDatabase } from "@opencode-ai/core/database/database"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
// altimate_change end
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { fn } from "@/util/fn"
import { BusEvent } from "@/bus/bus-event"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { existsSync } from "fs"
import { git } from "../util/git"
import { Glob } from "../util/glob"
import { which } from "../util/which"
import { ProjectID } from "./schema"
// altimate_change start — Effect Context.Service facade so upstream consumers that do
// `yield* Project.Service` / `Project.defaultLayer` / `Project.node` compile. Delegates each
// method to the existing namespace functions below (behavior preserved). Imperative callers
// keep using the namespace API directly.
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
// altimate_change end

export namespace Project {
  const log = Log.create({ service: "project" })

  function gitpath(cwd: string, name: string) {
    if (!name) return cwd
    // git output includes trailing newlines; keep path whitespace intact.
    name = name.replace(/[\r\n]+$/, "")
    if (!name) return cwd

    name = Filesystem.windowsPath(name)

    if (path.isAbsolute(name)) return path.normalize(name)
    return path.resolve(cwd, name)
  }

  export const Info = z
    .object({
      id: ProjectID.zod,
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  // altimate_change start — effect Schema mirror of the zod `Info` above, for the experimental
  // HttpApi project group/handler (effect HttpApi requires effect Schemas). Field shape is
  // kept in lockstep with the zod `Info`; `.fields.icon`/`.fields.commands` back the group's
  // UpdatePayload. Runtime data is produced by the zod path (fromRow); both validate the same shape.
  export const InfoSchema = Schema.Struct({
    id: ProjectV2.ID,
    worktree: Schema.String,
    vcs: Schema.optional(Schema.Literal("git")),
    name: Schema.optional(Schema.String),
    icon: Schema.optional(
      Schema.Struct({
        url: Schema.optional(Schema.String),
        override: Schema.optional(Schema.String),
        color: Schema.optional(Schema.String),
      }),
    ),
    commands: Schema.optional(
      Schema.Struct({
        start: Schema.optional(Schema.String),
      }),
    ),
    time: Schema.Struct({
      created: Schema.Number,
      updated: Schema.Number,
      initialized: Schema.optional(Schema.Number),
    }),
    sandboxes: Schema.Array(Schema.String),
  }).annotate({ identifier: "Project" })
  // altimate_change end

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  type Row = typeof ProjectTable.$inferSelect

  export function fromRow(row: Row): Info {
    // altimate_change start — include icon override when decoding core project rows.
    const icon =
      row.icon_url || row.icon_url_override || row.icon_color
        ? { url: row.icon_url ?? undefined, override: row.icon_url_override ?? undefined, color: row.icon_color ?? undefined }
        : undefined
    // altimate_change end
    return {
      id: ProjectID.make(row.id),
      worktree: row.worktree,
      vcs: row.vcs ? Info.shape.vcs.parse(row.vcs) : undefined,
      name: row.name ?? undefined,
      icon,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        initialized: row.time_initialized ?? undefined,
      },
      sandboxes: row.sandboxes,
      commands: row.commands ?? undefined,
    }
  }

  // altimate_change start — support legacy .git/altimate-code project ID cache
  function readCachedId(dir: string) {
    return Filesystem.readText(path.join(dir, "opencode"))
      .then((x) => x.trim())
      .then(ProjectID.make)
      .catch(() =>
        Filesystem.readText(path.join(dir, "altimate-code"))
          .then((x) => x.trim())
          .then(ProjectID.make)
          .catch(() => undefined),
      )
  }
  // altimate_change end

  // altimate_change start — upstream_fix: honor legacy .git/altimate-code cache
  // on the Effect Project.fromDirectory path. The core resolver only reads
  // .git/opencode, so preserve the fork's old cache before falling back to a
  // root-commit id; when a remote id is available, pass the legacy id through as
  // `previous` so the DB migration below can move sessions/workspaces forward.
  function readLegacyCachedId(dir: string) {
    return Filesystem.readText(path.join(dir, "altimate-code"))
      .then((x) => x.trim())
      .then(ProjectID.make)
      .catch(() => undefined)
  }

  const hasOriginRemote = Effect.fnUntraced(function* (directory: string) {
    return yield* Effect.promise(() =>
      git(["remote", "get-url", "origin"], { cwd: directory }).then((result) => result.exitCode === 0),
    )
  })
  // altimate_change end

  export async function fromDirectory(directory: string) {
    log.info("fromDirectory", { directory })

    const data = await iife(async () => {
      const matches = Filesystem.up({ targets: [".git"], start: directory })
      const dotgit = await matches.next().then((x) => x.value)
      await matches.return()
      if (dotgit) {
        let sandbox = path.dirname(dotgit)

        const gitBinary = which("git")

        // cached id calculation
        let id = await readCachedId(dotgit)

        if (!gitBinary) {
          return {
            id: id ?? ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        const worktree = await git(["rev-parse", "--git-common-dir"], {
          cwd: sandbox,
        })
          .then(async (result) => {
            const common = gitpath(sandbox, await result.text())
            // Avoid going to parent of sandbox when git-common-dir is empty.
            return common === sandbox ? sandbox : path.dirname(common)
          })
          .catch(() => undefined)

        if (!worktree) {
          return {
            id: id ?? ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        // In the case of a git worktree, it can't cache the id
        // because `.git` is not a folder, but it always needs the
        // same project id as the common dir, so we resolve it now
        if (id == null) {
          id = await readCachedId(path.join(worktree, ".git"))
        }

        // generate id from root commit
        if (!id) {
          const roots = await git(["rev-list", "--max-parents=0", "--all"], {
            cwd: sandbox,
          })
            .then(async (result) =>
              (await result.text())
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
            .catch(() => undefined)

          if (!roots) {
            return {
              id: ProjectID.global,
              worktree: sandbox,
              sandbox,
              vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
            }
          }

          id = roots[0] ? ProjectID.make(roots[0]) : undefined
          if (id) {
            await Filesystem.write(path.join(dotgit, "opencode"), id).catch(() => undefined)
          }
        }

        if (!id) {
          return {
            id: ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: "git",
          }
        }

        const top = await git(["rev-parse", "--show-toplevel"], {
          cwd: sandbox,
        })
          .then(async (result) => gitpath(sandbox, await result.text()))
          .catch(() => undefined)

        if (!top) {
          return {
            id,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        sandbox = top

        return {
          id,
          sandbox,
          worktree,
          vcs: "git",
        }
      }

      return {
        id: ProjectID.global,
        worktree: "/",
        sandbox: "/",
        vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
      }
    })

    const row = Database.use((db) =>
      db.select().from(ProjectTable).where(eq(ProjectTable.id, ProjectV2.ID.make(data.id))).get(),
    )
    const existing = row
      ? fromRow(row)
      : {
          id: data.id,
          worktree: data.worktree,
          vcs: data.vcs as Info["vcs"],
          sandboxes: [] as string[],
          time: {
            created: Date.now(),
            updated: Date.now(),
          },
        }

    if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY) discover(existing)

    const result: Info = {
      ...existing,
      worktree: data.worktree,
      vcs: data.vcs as Info["vcs"],
      time: {
        ...existing.time,
        updated: Date.now(),
      },
    }
    if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
      result.sandboxes.push(data.sandbox)
    result.sandboxes = result.sandboxes.filter((x) => existsSync(x))
    const insert = {
      id: ProjectV2.ID.make(result.id),
      worktree: AbsolutePath.make(result.worktree),
      vcs: result.vcs ?? null,
      name: result.name,
      icon_url: result.icon?.url,
      icon_color: result.icon?.color,
      time_created: result.time.created,
      time_updated: result.time.updated,
      time_initialized: result.time.initialized,
      sandboxes: result.sandboxes.map((x) => AbsolutePath.make(x)),
      commands: result.commands,
    }
    const updateSet = {
      worktree: AbsolutePath.make(result.worktree),
      vcs: result.vcs ?? null,
      name: result.name,
      icon_url: result.icon?.url,
      icon_color: result.icon?.color,
      time_updated: result.time.updated,
      time_initialized: result.time.initialized,
      sandboxes: result.sandboxes.map((x) => AbsolutePath.make(x)),
      commands: result.commands,
    }
    Database.use((db) =>
      db.insert(ProjectTable).values(insert).onConflictDoUpdate({ target: ProjectTable.id, set: updateSet }).run(),
    )
    // Runs after upsert so the target project row exists (FK constraint).
    // Runs on every startup because sessions created before git init
    // accumulate under "global" and need migrating whenever they appear.
    if (data.id !== ProjectID.global) {
      Database.use((db) =>
        db
          .update(SessionTable)
          // altimate_change start — upstream_fix: preserve session recency during project migration.
          .set({
            project_id: ProjectV2.ID.make(data.id),
            time_updated: sql`${SessionTable.time_updated}`,
          })
          // altimate_change end
          .where(
            and(
              eq(SessionTable.project_id, ProjectV2.ID.make(ProjectID.global)),
              eq(SessionTable.directory, data.worktree),
            ),
          )
          .run(),
      )
    }
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return { project: result, sandbox: data.sandbox }
  }

  export async function discover(input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.override) return
    if (input.icon?.url) return
    const matches = await Glob.scan("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
      cwd: input.worktree,
      absolute: true,
      include: "file",
      // altimate_change start — prune dependency stores while preserving icons
      // intentionally committed or generated under build/, dist/, out/, etc.
      ignore: [...Glob.DEPENDENCY_IGNORE],
      // altimate_change end
    })
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const buffer = await Filesystem.readBytes(shortest)
    const base64 = buffer.toString("base64")
    const mime = Filesystem.mimeType(shortest) || "image/png"
    const url = `data:${mime};base64,${base64}`
    await update({
      projectID: input.id,
      icon: {
        url,
      },
    })
    return
  }

  export function setInitialized(id: ProjectID) {
    Database.use((db) =>
      db
        .update(ProjectTable)
        .set({
          time_initialized: Date.now(),
        })
        .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
        .run(),
    )
  }

  export function list() {
    return Database.use((db) =>
      db
        .select()
        .from(ProjectTable)
        .all()
        .map((row) => fromRow(row)),
    )
  }

  export function get(id: ProjectID): Info | undefined {
    const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, ProjectV2.ID.make(id))).get())
    if (!row) return undefined
    return fromRow(row)
  }

  export async function initGit(input: { directory: string; project: Info }) {
    if (input.project.vcs === "git") return input.project
    if (!which("git")) throw new Error("Git is not installed")

    const result = await git(["init", "--quiet"], {
      cwd: input.directory,
    })
    if (result.exitCode !== 0) {
      const text = result.stderr.toString().trim() || result.text().trim()
      throw new Error(text || "Failed to initialize git repository")
    }

    return (await fromDirectory(input.directory)).project
  }

  export const update = fn(
    z.object({
      projectID: ProjectID.zod,
      name: z.string().optional(),
      icon: Info.shape.icon.optional(),
      commands: Info.shape.commands.optional(),
    }),
    async (input) => {
      const id = ProjectID.make(input.projectID)
      const result = Database.use((db) =>
        db
          .update(ProjectTable)
          .set({
            name: input.name,
            icon_url: input.icon?.url,
            icon_color: input.icon?.color,
            commands: input.commands,
            time_updated: Date.now(),
          })
          .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
          .returning()
          .get(),
      )
      if (!result) throw new Error(`Project not found: ${input.projectID}`)
      const data = fromRow(result)
      GlobalBus.emit("event", {
        payload: {
          type: Event.Updated.type,
          properties: data,
        },
      })
      return data
    },
  )

  export async function sandboxes(id: ProjectID) {
    const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, ProjectV2.ID.make(id))).get())
    if (!row) return []
    const data = fromRow(row)
    const valid: string[] = []
    for (const dir of data.sandboxes) {
      const s = Filesystem.stat(AbsolutePath.make(dir))
      if (s?.isDirectory()) valid.push(dir)
    }
    return valid
  }

  export async function addSandbox(id: ProjectID, directory: string) {
    const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, ProjectV2.ID.make(id))).get())
    if (!row) throw new Error(`Project not found: ${id}`)
    const sandboxes = [...row.sandboxes]
    const sandbox = AbsolutePath.make(directory)
    if (!sandboxes.includes(sandbox)) sandboxes.push(sandbox)
    const result = Database.use((db) =>
      db
        .update(ProjectTable)
        .set({ sandboxes, time_updated: Date.now() })
        .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
        .returning()
        .get(),
    )
    if (!result) throw new Error(`Project not found: ${id}`)
    const data = fromRow(result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: data,
      },
    })
    return data
  }

  export async function removeSandbox(id: ProjectID, directory: string) {
    const row = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, ProjectV2.ID.make(id))).get())
    if (!row) throw new Error(`Project not found: ${id}`)
    const sandboxes = row.sandboxes.filter((s) => s !== directory)
    const result = Database.use((db) =>
      db
        .update(ProjectTable)
        .set({ sandboxes, time_updated: Date.now() })
        .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
        .returning()
        .get(),
    )
    if (!result) throw new Error(`Project not found: ${id}`)
    const data = fromRow(result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: data,
      },
    })
    return data
  }

  // altimate_change start — Effect Context.Service facade (see import note above).
  // Re-brand helper: core (`Project.ID`) and fork (`ProjectID`) ids are identity at runtime;
  // accept either brand and re-brand to the fork brand before delegating.
  type AnyProjectID = ProjectID | ProjectV2.ID

  export type UpdateInput = {
    projectID: AnyProjectID
    name?: string
    icon?: Info["icon"]
    commands?: Info["commands"]
  }

  export type UpdatePayload = Omit<UpdateInput, "projectID">

  // Tagged error consumers catch via `Effect.catchTag("Project.NotFoundError", ...)`.
  export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Project.NotFoundError", {
    projectID: Schema.String,
  }) {}

  export interface Interface {
    readonly fromDirectory: (directory: string) => Effect.Effect<{ project: Info; sandbox: string }>
    readonly discover: (input: Info) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Info[]>
    readonly get: (id: AnyProjectID) => Effect.Effect<Info | undefined>
    readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError>
    readonly initGit: (input: { directory: string; project: Info }) => Effect.Effect<Info>
    readonly setInitialized: (id: AnyProjectID) => Effect.Effect<void>
    readonly sandboxes: (id: AnyProjectID) => Effect.Effect<string[]>
    readonly addSandbox: (id: AnyProjectID, directory: string) => Effect.Effect<void>
    readonly removeSandbox: (id: AnyProjectID, directory: string) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Project") {}

  // altimate_change start — implement the Effect facade against the core Effect DB.
  // The old namespace API above still writes through the legacy DB singleton, but Effect
  // session/workspace projectors enforce FKs in core Database.Service and need the
  // parent project row in that same database before they project child rows.
  function toEffectRow(info: Info): typeof ProjectTable.$inferInsert {
    return {
      id: ProjectV2.ID.make(info.id),
      worktree: AbsolutePath.make(info.worktree),
      vcs: info.vcs ?? null,
      name: info.name,
      icon_url: info.icon?.url,
      icon_url_override: info.icon?.override,
      icon_color: info.icon?.color,
      time_created: info.time.created,
      time_updated: info.time.updated,
      time_initialized: info.time.initialized,
      sandboxes: info.sandboxes.map((item) => AbsolutePath.make(item)),
      commands: info.commands,
    }
  }

  export const layer: Layer.Layer<
    Service,
    never,
    EffectDatabase.Service | ProjectV2.Service | ProjectDirectories.Service | RuntimeFlags.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* EffectDatabase.Service
      const resolver = yield* ProjectV2.Service
      const directories = yield* ProjectDirectories.Service
      const flags = yield* RuntimeFlags.Service

      const emitUpdated = (info: Info) =>
        Effect.sync(() =>
          GlobalBus.emit("event", {
            payload: {
              type: Event.Updated.type,
              properties: info,
            },
          }),
        )

      const getEffect = Effect.fn("Project.get")(function* (id: AnyProjectID) {
        const row = yield* db
          .select()
          .from(ProjectTable)
          .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
          .get()
          .pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      })

      const listEffect = Effect.fn("Project.list")(function* () {
        const rows = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)
        return rows.map((row) => fromRow(row))
      })

      const updateEffect = Effect.fn("Project.update")(function* (input: UpdateInput) {
        const row = yield* db
          .update(ProjectTable)
          .set({
            name: input.name,
            icon_url: input.icon?.url,
            icon_url_override: input.icon?.override,
            icon_color: input.icon?.color,
            commands: input.commands,
            time_updated: Date.now(),
          })
          .where(eq(ProjectTable.id, ProjectV2.ID.make(input.projectID)))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ projectID: ProjectID.make(input.projectID) })
        const info = fromRow(row)
        yield* emitUpdated(info)
        return info
      })

      const discoverEffect = Effect.fn("Project.discover")(function* (input: Info) {
        if (input.vcs !== "git") return
        if (input.icon?.override) return
        if (input.icon?.url) return
        const matches = yield* Effect.promise(() =>
          Glob.scan("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
            cwd: input.worktree,
            absolute: true,
            include: "file",
            // altimate_change start — prune dependency stores; see Project.discover above.
            ignore: [...Glob.DEPENDENCY_IGNORE],
            // altimate_change end
          }),
        )
        const shortest = matches.sort((a, b) => a.length - b.length)[0]
        if (!shortest) return
        const buffer = yield* Effect.promise(() => Filesystem.readBytes(shortest))
        const base64 = buffer.toString("base64")
        const mime = Filesystem.mimeType(shortest) || "image/png"
        yield* updateEffect({
          projectID: input.id,
          icon: {
            url: `data:${mime};base64,${base64}`,
          },
        }).pipe(Effect.ignore)
      })

      const fromDirectoryEffect = Effect.fn("Project.fromDirectory")(function* (directory: string) {
        const resolved = yield* resolver.resolve(AbsolutePath.make(path.resolve(directory)))
        let id = ProjectID.make(resolved.id)
        let previous = resolved.previous ? ProjectID.make(resolved.previous) : undefined
        // altimate_change start — upstream_fix: carry legacy .git/altimate-code through Effect resolver
        const vcs = resolved.vcs
        if (vcs && !previous) {
          const legacy = yield* Effect.promise(() => readLegacyCachedId(vcs.store))
          if (legacy) {
            if (id === ProjectID.global || !(yield* hasOriginRemote(resolved.directory))) id = legacy
            else previous = legacy
          }
        }
        // altimate_change end
        const previousCore = previous ? ProjectV2.ID.make(previous) : undefined
        const projectCore = ProjectV2.ID.make(id)
        const activeDirectory = AbsolutePath.make(resolved.directory)
        const now = Date.now()

        const existingRow =
          id === ProjectID.global
            ? undefined
            : yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectCore)).get().pipe(Effect.orDie)
        const previousRow =
          previousCore && previous !== id && previous !== ProjectID.global
            ? yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, previousCore)).get().pipe(Effect.orDie)
            : undefined

        const existing = existingRow ? fromRow(existingRow) : previousRow ? fromRow(previousRow) : undefined
        const sandboxes = existing?.sandboxes.filter((item) => existsSync(item)) ?? []
        const worktree = existing?.worktree ?? activeDirectory
        if (activeDirectory !== worktree && !sandboxes.includes(activeDirectory)) sandboxes.push(activeDirectory)

        const result: Info = {
          id,
          worktree,
          vcs: resolved.vcs ? "git" : undefined,
          name: existing?.name,
          icon: existing?.icon,
          commands: existing?.commands,
          time: {
            created: existing?.time.created ?? now,
            updated: now,
            initialized: existing?.time.initialized,
          },
          sandboxes,
        }

        const row = toEffectRow(result)
        const updateSet = {
          worktree: row.worktree,
          vcs: row.vcs,
          name: row.name,
          icon_url: row.icon_url,
          icon_url_override: row.icon_url_override,
          icon_color: row.icon_color,
          time_updated: row.time_updated,
          time_initialized: row.time_initialized,
          sandboxes: row.sandboxes,
          commands: row.commands,
        }

        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(ProjectTable)
                .values(row)
                .onConflictDoUpdate({ target: ProjectTable.id, set: updateSet })
                .run()
              if (previousCore && previous !== id && previous !== ProjectID.global) {
                yield* tx
                  .update(SessionTable)
                  // altimate_change start — upstream_fix: preserve session recency during project migration.
                  .set({
                    project_id: projectCore,
                    time_updated: sql`${SessionTable.time_updated}`,
                  })
                  // altimate_change end
                  .where(eq(SessionTable.project_id, previousCore))
                  .run()
                yield* tx
                  .update(WorkspaceTable)
                  .set({ project_id: projectCore })
                  .where(eq(WorkspaceTable.project_id, previousCore))
                  .run()
                yield* tx.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, previousCore)).run()
                yield* tx.delete(ProjectTable).where(eq(ProjectTable.id, previousCore)).run()
              }
              if (id !== ProjectID.global) {
                yield* tx
                  .update(SessionTable)
                  // altimate_change start — upstream_fix: preserve session recency during project migration.
                  .set({
                    project_id: projectCore,
                    time_updated: sql`${SessionTable.time_updated}`,
                  })
                  // altimate_change end
                  .where(
                    and(
                      eq(SessionTable.project_id, ProjectV2.ID.make(ProjectID.global)),
                      eq(SessionTable.directory, activeDirectory),
                    ),
                  )
                  .run()
              }
              yield* tx
                .insert(ProjectDirectoryTable)
                .values({ project_id: projectCore, directory: activeDirectory })
                .onConflictDoNothing()
                .run()
            }),
          )
          .pipe(Effect.orDie)

        if (resolved.vcs && id !== ProjectID.global) yield* resolver.commit({ store: resolved.vcs.store, id: ProjectV2.ID.make(id) })
        yield* emitUpdated(result)
        if (flags.experimentalIconDiscovery) yield* discoverEffect(result)
        return { project: result, sandbox: activeDirectory }
      })

      const setInitializedEffect = Effect.fn("Project.setInitialized")(function* (id: AnyProjectID) {
        yield* db
          .update(ProjectTable)
          .set({
            time_initialized: Date.now(),
          })
          .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie)
      })

      const sandboxesEffect = Effect.fn("Project.sandboxes")(function* (id: AnyProjectID) {
        const row = yield* db
          .select()
          .from(ProjectTable)
          .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
          .get()
          .pipe(Effect.orDie)
        if (!row) return []
        return row.sandboxes.filter((item) => Filesystem.stat(item)?.isDirectory())
      })

      const addSandboxEffect = Effect.fn("Project.addSandbox")(function* (id: AnyProjectID, directory: string) {
        const info = yield* getEffect(id)
        if (!info) return
        const sandboxes = info.sandboxes.includes(directory) ? info.sandboxes : [...info.sandboxes, directory]
        const row = yield* db
          .update(ProjectTable)
          .set({ sandboxes: sandboxes.map((item) => AbsolutePath.make(item)), time_updated: Date.now() })
          .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row) yield* emitUpdated(fromRow(row))
      })

      const removeSandboxEffect = Effect.fn("Project.removeSandbox")(function* (id: AnyProjectID, directory: string) {
        const info = yield* getEffect(id)
        if (!info) return
        const row = yield* db
          .update(ProjectTable)
          .set({
            sandboxes: info.sandboxes.filter((item) => item !== directory).map((item) => AbsolutePath.make(item)),
            time_updated: Date.now(),
          })
          .where(eq(ProjectTable.id, ProjectV2.ID.make(id)))
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row) yield* emitUpdated(fromRow(row))
      })

      return Service.of({
        fromDirectory: fromDirectoryEffect,
        discover: discoverEffect,
        list: listEffect,
        get: getEffect,
        update: updateEffect,
        initGit: (input) => Effect.promise(() => initGit(input)),
        setInitialized: setInitializedEffect,
        sandboxes: sandboxesEffect,
        addSandbox: addSandboxEffect,
        removeSandbox: removeSandboxEffect,
      })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(EffectDatabase.defaultLayer),
      Layer.provide(ProjectV2.defaultLayer),
      Layer.provide(ProjectDirectories.defaultLayer),
      Layer.provide(RuntimeFlags.defaultLayer),
    ),
  )
  // altimate_change end

  // altimate_change start — `use` accessor mirrors Session.use so tests/consumers can call
  // Project.use.get(...) etc. without the explicit Service.use((p) => p.get(...)) wrapper.
  export const use = serviceUse(Service)
  // altimate_change end

  export const node = LayerNode.make(layer, [EffectDatabase.node, ProjectV2.node, ProjectDirectories.node, RuntimeFlags.node])
  // altimate_change end
}

// altimate_change start — instance-store.ts does `import * as Project from "./project"` and
// references the Effect facade at module scope (Project.Service / Project.Info /
// Project.defaultLayer / Project.node). Re-export the namespace members at module scope so that
// flat-import style resolves, without disturbing the `import { Project }` namespace consumers.
export type Info = Project.Info
export type Interface = Project.Interface
export const Service = Project.Service
export type Service = Project.Service
export const NotFoundError = Project.NotFoundError
export type NotFoundError = Project.NotFoundError
export type UpdateInput = Project.UpdateInput
export type UpdatePayload = Project.UpdatePayload
export const layer = Project.layer
export const defaultLayer = Project.defaultLayer
export const node = Project.node
// altimate_change end
