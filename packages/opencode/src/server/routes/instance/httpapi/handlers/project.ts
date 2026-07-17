import * as InstanceState from "@/effect/instance-state"
import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"
import { markInstanceForReload } from "../lifecycle"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service

    // altimate_change start — re-brand fork Project.Info (id: "ProjectID") to the core
    // "Project.ID" brand the HttpApi success schema (Project.InfoSchema) expects. Identity
    // at runtime; only the nominal brand differs.
    const toApiInfo = (info: Project.Info) => ({ ...info, id: ProjectV2.ID.make(info.id) })
    // altimate_change end

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return (yield* svc.list()).map(toApiInfo)
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return toApiInfo((yield* InstanceState.context).project)
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return toApiInfo(next)
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return toApiInfo(next)
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
        Effect.map(toApiInfo),
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )
    })

    const directories = Effect.fn("ProjectHttpApi.directories")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      project.directories({ projectID: ctx.params.projectID }),
    )

    return handlers
      .handle("list", list)
      .handle("current", current)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("directories", directories)
  }),
)
