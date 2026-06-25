import { Project } from "@/project/project"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project"
// altimate_change start — upstream_fix: export Project update payload and use InfoSchema fields
export const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(Project.InfoSchema.fields.icon),
  commands: Schema.optional(Project.InfoSchema.fields.commands),
})
// altimate_change end

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          // altimate_change start — upstream_fix: project routes describe InfoSchema responses
          success: described(Schema.Array(Project.InfoSchema), "List of projects"),
          // altimate_change end
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            // altimate_change start — OpenAPI description uses Altimate Code brand
            description: "Get a list of projects that have been opened with Altimate Code.",
            // altimate_change end
          }),
        ),
        HttpApiEndpoint.get("current", `${root}/current`, {
          query: WorkspaceRoutingQuery,
          // altimate_change start — upstream_fix: project routes describe InfoSchema responses
          success: described(Project.InfoSchema, "Current project information"),
          // altimate_change end
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            // altimate_change start — OpenAPI description uses Altimate Code brand
            description: "Retrieve the currently active project that Altimate Code is working with.",
            // altimate_change end
          }),
        ),
        HttpApiEndpoint.post("initGit", `${root}/git/init`, {
          query: WorkspaceRoutingQuery,
          // altimate_change start — upstream_fix: project routes describe InfoSchema responses
          success: described(Project.InfoSchema, "Project information after git initialization"),
          // altimate_change end
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "Initialize git repository",
            description: "Create a git repository for the current project and return the refreshed project info.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:projectID`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          // altimate_change start — upstream_fix: project routes describe InfoSchema responses
          success: described(Project.InfoSchema, "Updated project information"),
          // altimate_change end
          error: [HttpApiError.BadRequest, ProjectNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Update project",
            description: "Update project properties such as name, icon, and commands.",
          }),
        ),
        HttpApiEndpoint.get("directories", `${root}/:projectID/directories`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(ProjectV2.Directories, "Project directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directories",
            summary: "List project directories",
            description: "List known local absolute directories for a project.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "Experimental HttpApi project routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
