// altimate_change — WorkspaceLink feature (docs/workspace-plan/CONTRACT.md §3, Path B).
//
// A NEW, separate httpapi group — deliberately not added to groups/workspace.ts, which owns
// the unrelated local git-worktree `Workspace`/`WorkspaceTable` feature
// (packages/core/src/control-plane/workspace.sql.ts, gated by OPENCODE_EXPERIMENTAL_WORKSPACES).
//
// Why this exists at all: packages/tui depends on packages/core, not packages/opencode
// (flag.ts:8-10) — the TUI cannot import WorkspaceLinkApi (altimate/workspace-link/api-client.ts)
// directly, so the actual HTTP calls to the (mock, for now) WorkspaceLink backend must happen at
// this opencode layer, reached from the TUI's new Y/N dialog through the SDK the same way
// dialog-provider.tsx's AutoMethod already reaches `provider.oauth.callback`. A dedicated route
// group (rather than reusing provider.oauth.callback) avoids polluting the provider/model list
// with a fake "workspace-link" provider credential — provider.oauth.callback's whole purpose is
// persisting an LLM-provider credential on success, which a workspace-link approval is not.
//
// Only exposes Path B (the unauthenticated device flow) — Path A's session-link creation
// happens entirely server-side in the plugin callback (altimate/plugin/altimate.ts) and never
// needs to reach the TUI at all.
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workspace-link"

export class ApiWorkspaceLinkError extends Schema.ErrorClass<ApiWorkspaceLinkError>("WorkspaceLinkError")(
  {
    name: Schema.Literal("WorkspaceLinkError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 502 },
) {}

// altimate_change — checkpoint 8k: no more code-entry step; verification_uri resolves directly
// to the consent card (see link-service.ts's createDeviceLink).
export const WorkspaceLinkDeviceResponse = Schema.Struct({
  link_id: Schema.String,
  verification_uri: Schema.String,
  poll_token: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
})

export const WorkspaceLinkPollPayload = Schema.Struct({
  link_id: Schema.String,
  poll_token: Schema.String,
})

export const WorkspaceLinkPollResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("declined") }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    approved_by: Schema.String,
    workspace: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      slug: Schema.String,
      manage_url: Schema.String,
    }),
  }),
])

export const WorkspaceLinkPaths = {
  createDevice: `${root}/device`,
  poll: `${root}/poll`,
} as const

export const WorkspaceLinkHttpApi = HttpApi.make("workspaceLink")
  .add(
    HttpApiGroup.make("workspaceLink")
      .add(
        HttpApiEndpoint.post("createDevice", WorkspaceLinkPaths.createDevice, {
          query: WorkspaceRoutingQuery,
          success: described(WorkspaceLinkDeviceResponse, "Pending device-flow workspace link created"),
          error: ApiWorkspaceLinkError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workspaceLink.createDevice",
            summary: "Create a pending WorkspaceLink (device flow)",
            description:
              "Path B: create an unauthenticated, single-use pending workspace link for the current " +
              "project, reading the workspace_link_scan_cache if a fresh one exists. Talks to a local " +
              "mock backend until docs/workspace-plan/CONTRACT.md's open assumptions are confirmed.",
          }),
        ),
        HttpApiEndpoint.post("poll", WorkspaceLinkPaths.poll, {
          query: WorkspaceRoutingQuery,
          payload: WorkspaceLinkPollPayload,
          success: described(WorkspaceLinkPollResult, "WorkspaceLink poll result"),
          error: ApiWorkspaceLinkError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workspaceLink.poll",
            summary: "Poll a pending WorkspaceLink",
            description: "Poll a link created via createDevice for approval/decline/expiry.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "workspaceLink", description: "WorkspaceLink (docs/workspace-plan) routes." }),
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
