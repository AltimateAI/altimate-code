import type { MiddlewareHandler } from "hono"
import { Flag } from "../flag/flag"
import { getAdapter } from "./adapters"
import { Workspace } from "./workspace"
import { WorkspaceContext } from "./workspace-context"
import { AppRuntime } from "@/effect/app-runtime"

// This middleware forwards all non-GET requests if the workspace is a
// remote. The remote workspace needs to handle session mutations
async function routeRequest(req: Request) {
  // Right now, we need to forward all requests to the workspace
  // because we don't have syncing. In the future all GET requests
  // which don't mutate anything will be handled locally
  //
  // if (req.method === "GET") return

  if (!WorkspaceContext.workspaceID) return

  // altimate_change start — Workspace.get is now an Effect Service method; run it via AppRuntime
  const workspace = await AppRuntime.runPromise(Workspace.Service.use((svc) => svc.get(WorkspaceContext.workspaceID!)))
  // altimate_change end
  if (!workspace) {
    return new Response(`Workspace not found: ${WorkspaceContext.workspaceID}`, {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    })
  }

  // altimate_change start — upstream_fix: bridge merge originally called
  // `(adaptor as any).fetch(...)`, but Adaptor.fetch was renamed to
  // Adaptor.target() in v1.4.0. Calling .fetch threw at runtime whenever
  // OPENCODE_EXPERIMENTAL_WORKSPACES was enabled. Use the new target()
  // API and combine target.url with the original request's path+search
  // ourselves — ServerProxy.http overrides the URL with target.url
  // verbatim, dropping the request path, which would route every request
  // to the workspace's root.
  const adaptor = getAdapter(workspace.projectID, workspace.type)
  const target = await Promise.resolve(adaptor.target(workspace))
  if (target.type === "local") return

  const incoming = new URL(req.url)
  const baseURL = String(target.url).replace(/\/+$/, "")
  const destination = baseURL + incoming.pathname + incoming.search

  return fetch(destination, {
    method: req.method,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    headers: target.headers ? new Headers([...new Headers(req.headers), ...new Headers(target.headers)]) : req.headers,
    signal: req.signal,
    redirect: "manual",
  })
  // altimate_change end
}

export const WorkspaceRouterMiddleware: MiddlewareHandler = async (c, next) => {
  // Only available in development for now
  if (!Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
    return next()
  }

  const response = await routeRequest(c.req.raw)
  if (response) {
    return response
  }
  return next()
}
