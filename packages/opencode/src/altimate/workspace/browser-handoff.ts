// altimate_change - new file
//
// Browser-based workspace creation handoff. CLI opens Ralph's SaaS approval
// modal at ``<tenant>.ws.myaltimate.com/create-and-link`` with the current
// project's context, user approves, the SaaS creates a workspace and delivers
// its ID back to the CLI via a loopback callback. The CLI then binds the
// current project to that workspace via the existing
// ``POST /datamate-project-bindings/bind`` endpoint.
//
// This module deliberately DUPLICATES the loopback listener pattern from
// ``altimate/plugin/altimate.ts`` rather than sharing a helper — the two flows
// are similar enough that a naive extraction would trade duplication for
// coupling on state/global lifecycle. Refactor to a shared helper is a
// follow-up ticket once both flows have prod experience; the port range
// (7317..7325) is walked independently by each listener instance so a live
// OAuth server on 7317 forces workspace-handoff to bind 7318 without either
// close operation affecting the other.
//
// See docs `workspace-browser-handoff-plan-v3.md` for the design context.
import { createServer, type Server } from "http"
import { randomBytes } from "crypto"
import open from "open"

import { AltimateApi } from "@/altimate/api/client"
import { Log } from "@/altimate/util/log"

import type { ProjectIdentifier } from "./api-client"

// Freemium is the only deployment served by the workspace stack today. When
// altimate-backend goes multi-deployment (enterprise), extend this to a small
// mapping. Returning null means "not supported here" — the CLI hides the
// browser-handoff option entirely rather than open a broken URL.
const FREEMIUM_API_HOST = "api.myaltimate.com"
const FREEMIUM_WORKSPACE_HOST = "ws.myaltimate.com"

// Loopback port range for the workspace-bound callback. Shared with the OAuth
// sign-in listener in altimate.ts — each listener walks independently, so a
// live OAuth server on 7317 forces us to 7318 (or later) transparently.
const CALLBACK_PORT_MIN = 7317
const CALLBACK_PORT_MAX = 7325

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** Loopback success page. We land the user back on the SaaS workspace page via
 * top-level navigation — matches the OAuth sign-in pattern in altimate.ts,
 * which is proven in prod. The rationale over a subresource fetch: HTTPS→HTTP
 * loopback subresource fetches trigger Chrome/Safari Private Network Access
 * checks (preflight OPTIONS with Access-Control-Request-Private-Network); a
 * top-level navigation from an HTTP 302 or ``window.location.href`` bypasses
 * PNA entirely. Meta refresh + JS assign for belt-and-suspenders. */
function deliverySuccessHtml(manageUrl: string): string {
  const safe = escapeHtml(manageUrl)
  return `<!doctype html><meta charset="utf-8"><title>Altimate Code</title>
<meta http-equiv="refresh" content="0;url=${safe}">
<body style="font-family:system-ui;text-align:center;padding:64px">
<h2>Workspace ready</h2><p>Returning you to the workspace page…</p>
<p><a href="${safe}">Continue</a> if you're not redirected automatically.</p>
<script>window.location.replace(${JSON.stringify(manageUrl)})</script></body>`
}

const log = Log.create({ service: "altimate-workspace-handoff" })

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  )
}

function htmlError(msg: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Altimate Code</title>
<body style="font-family:system-ui;text-align:center;padding:64px">
<h2>Workspace handoff failed</h2><p>${escapeHtml(msg)}</p>
<p>Please return to your terminal and try again.</p></body>`
}

/** Cancel-path response: bounce the browser back to the SaaS workspace home
 * so the user doesn't get stranded on the plain loopback page. Same top-level
 * navigation mechanism as ``deliverySuccessHtml``. */
function cancelHtml(workspaceWebBase: URL): string {
  const home = workspaceWebBase.toString().replace(/\/$/, "") + "/"
  const safe = escapeHtml(home)
  return `<!doctype html><meta charset="utf-8"><title>Altimate Code</title>
<meta http-equiv="refresh" content="0;url=${safe}">
<body style="font-family:system-ui;text-align:center;padding:64px">
<h2>Cancelled</h2><p>Returning you to the workspace home…</p>
<p><a href="${safe}">Continue</a> if you're not redirected automatically.</p>
<script>window.location.replace(${JSON.stringify(home)})</script></body>`
}

export type HandoffFailureReason =
  | "unavailable" // resolveWorkspaceWebUrl returned null (not freemium)
  | "not_configured" // CLI credentials not present
  | "timeout" // 15-min window expired
  | "cancelled" // user hit Cancel in the browser
  | "tenant_mismatch" // callback tenant != credentials tenant
  | "port_exhausted" // 7317..7325 all in use
  | "browser_open_failed"
  | "error"

export interface HandoffSuccess {
  ok: true
  workspaceId: number
  tenant: string
}
export interface HandoffFailure {
  ok: false
  reason: HandoffFailureReason
  message?: string
  authorizeUrl?: string // set for browser_open_failed so caller can copy-paste
}
export type HandoffResult = HandoffSuccess | HandoffFailure

/** Compute the workspace-stack URL for a given API host + tenant, or null if
 * this deployment isn't supported (localhost, enterprise, custom domain).
 *
 * Dev escape hatch: ``ALTIMATE_WORKSPACE_WEB_URL`` overrides the map lookup
 * when set (must be a well-formed URL). Used for local integration testing
 * against a non-freemium SaaS instance. Not something production users touch. */
export function resolveWorkspaceWebUrl(altimateUrl: string, tenant: string): URL | null {
  const override = process.env["ALTIMATE_WORKSPACE_WEB_URL"]
  if (override) {
    try {
      return new URL(override)
    } catch {
      return null
    }
  }
  try {
    const apiHost = new URL(altimateUrl).host
    if (apiHost !== FREEMIUM_API_HOST) return null
    return new URL(`https://${tenant}.${FREEMIUM_WORKSPACE_HOST}`)
  } catch {
    return null
  }
}

interface HandoffPending {
  state: string
  expectedTenant: string
  /** Base URL for the tenant's SaaS workspace stack, used to build the
   * ``/w/:id`` bounce target that the loopback success HTML redirects to. */
  workspaceWebBase: URL
  resolve: (v: HandoffSuccess) => void
  reject: (err: Error & { handoffReason?: HandoffFailureReason }) => void
}

function markReason<E extends Error>(err: E, reason: HandoffFailureReason): E & { handoffReason: HandoffFailureReason } {
  return Object.assign(err, { handoffReason: reason })
}

/** Start a per-flow loopback listener on the first available port in the
 * shared 7317..7325 range. Own server, own pending map — no coupling to the
 * OAuth listener in altimate.ts. */
async function startListener(pending: HandoffPending): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const port = (server.address() as { port?: number } | null)?.port ?? CALLBACK_PORT_MIN
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`)
    if (url.pathname !== "/workspace-bound") {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    const respond = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "text/html" })
      res.end(body)
    }

    // Validate state FIRST — a request without the right state can neither
    // cancel nor deliver anything.
    const state = url.searchParams.get("state")
    if (!state || state !== pending.state) {
      respond(400, htmlError("Invalid or unknown workspace-handoff state"))
      return
    }

    // Respond BEFORE resolving/rejecting the pending flow — the reject path
    // closes the listener via closeListener(), which can race with the
    // response flush and leave the client fetch hanging. Order matters.
    const error = url.searchParams.get("error")
    if (error) {
      const reason: HandoffFailureReason = error === "cancelled" ? "cancelled" : "error"
      // Cancel bounces the browser back to the SaaS workspace home so the user
      // isn't stranded on the plain loopback page; hard errors keep the plain
      // error card (there's no useful place to bounce them to).
      const body = error === "cancelled" ? cancelHtml(pending.workspaceWebBase) : htmlError(error)
      respond(200, body)
      pending.reject(markReason(new Error(error), reason))
      return
    }

    const workspaceIdRaw = url.searchParams.get("workspace_id")
    const tenant = url.searchParams.get("tenant")
    if (!workspaceIdRaw || !tenant) {
      const msg = "Missing workspace_id or tenant in callback"
      respond(400, htmlError(msg))
      pending.reject(markReason(new Error(msg), "error"))
      return
    }

    if (tenant !== pending.expectedTenant) {
      // Cross-tenant defence: user created the workspace in a tenant that
      // doesn't match the CLI's credentials. Refuse the bind — the workspace
      // ID is tenant-schema-local so binding here would 404 or, worse, hit an
      // unrelated workspace in the CLI's tenant.
      const msg = `Workspace was created in tenant "${tenant}" but the CLI is signed into "${pending.expectedTenant}"`
      respond(400, htmlError(msg))
      pending.reject(markReason(new Error(msg), "tenant_mismatch"))
      return
    }

    const workspaceId = Number(workspaceIdRaw)
    if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
      const msg = `Invalid workspace_id: ${workspaceIdRaw}`
      respond(400, htmlError(msg))
      pending.reject(markReason(new Error(msg), "error"))
      return
    }

    // Bounce the browser back to the SaaS workspace page. Loopback constructs
    // the URL itself (no need to trust a `return` query param) — the base is
    // deterministic from the tenant we already validated above.
    const manageUrl = `${pending.workspaceWebBase.toString().replace(/\/$/, "")}/w/${workspaceId}`
    respond(200, deliverySuccessHtml(manageUrl))
    pending.resolve({ ok: true, workspaceId, tenant })
  })

  // Walk 7317..7325 — each server instance is independent, so a squatting
  // OAuth listener on 7317 just makes us bind 7318.
  const tried: number[] = []
  let lastErr: NodeJS.ErrnoException | undefined
  for (let port = CALLBACK_PORT_MIN; port <= CALLBACK_PORT_MAX; port++) {
    tried.push(port)
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: NodeJS.ErrnoException) => reject(err)
        server.once("error", onErr)
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", onErr)
          resolve()
        })
      })
      return { server, port }
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException
      // Defensive cleanup in case any listeners linger after a rejected bind.
      server.removeAllListeners("error")
      if (lastErr.code !== "EADDRINUSE") break
    }
  }

  server.close()
  const code = lastErr?.code
  throw markReason(
    new Error(
      code === "EADDRINUSE"
        ? `Every port in ${CALLBACK_PORT_MIN}-${CALLBACK_PORT_MAX} is in use (tried ${tried.join(", ")}). Close what's using them (e.g. \`lsof -i :${CALLBACK_PORT_MIN}\`) and try again.`
        : `Could not start the workspace-handoff server: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    ),
    "port_exhausted",
  )
}

export interface OpenBrowserHandoffInput {
  identifier: ProjectIdentifier
  projectName: string
}

/** Full browser-handoff flow. Returns the created/picked workspace ID on
 * success, or a typed failure reason on any error path. Never throws — every
 * error is expressed as ``{ok: false, reason}`` so the caller can toast the
 * appropriate message. */
export async function openWorkspaceBrowserHandoff(input: OpenBrowserHandoffInput): Promise<HandoffResult> {
  return runHandoffWithOpener(input, (url) => open(url).then(() => undefined))
}

/** Same as ``openWorkspaceBrowserHandoff`` but takes the browser-open callback
 * as a dependency so tests can inject a fake that fires the loopback callback
 * synchronously instead of launching a real browser. Not exported from the
 * package barrel — only tests import this directly. */
export async function runHandoffWithOpener(
  input: OpenBrowserHandoffInput,
  openBrowser: (url: string) => Promise<void>,
): Promise<HandoffResult> {
  if (!(await AltimateApi.isConfigured().catch(() => false))) {
    return { ok: false, reason: "not_configured" }
  }
  const creds = await AltimateApi.getCredentials()
  const webUrl = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
  if (!webUrl) return { ok: false, reason: "unavailable" }

  const state = randomBytes(16).toString("hex")

  // Register pending, then bind the listener. Timeout owns rejection with
  // reason "timeout"; the listener's own reject paths mark their own reasons.
  let listenerHandle: { server: Server; port: number } | undefined
  const closeListener = () => {
    if (listenerHandle) {
      try {
        listenerHandle.server.close()
      } catch {
        /* best effort */
      }
      listenerHandle = undefined
    }
  }

  const settled = new Promise<HandoffResult>((resolve) => {
    const pending: HandoffPending = {
      state,
      expectedTenant: creds.altimateInstanceName,
      workspaceWebBase: webUrl,
      resolve: (v) => {
        closeListener()
        clearTimeout(timeoutHandle)
        resolve(v)
      },
      reject: (err) => {
        closeListener()
        clearTimeout(timeoutHandle)
        const reason = (err as { handoffReason?: HandoffFailureReason }).handoffReason ?? "error"
        const authorizeUrl = (err as { authorizeUrl?: string }).authorizeUrl
        resolve({
          ok: false,
          reason,
          message: err.message,
          ...(authorizeUrl ? { authorizeUrl } : {}),
        })
      },
    }
    const timeoutHandle = setTimeout(() => {
      pending.reject(markReason(new Error("Timed out waiting for browser workspace handoff"), "timeout"))
    }, DEFAULT_TIMEOUT_MS)

    ;(async () => {
      try {
        listenerHandle = await startListener(pending)
      } catch (err) {
        const reason = (err as { handoffReason?: HandoffFailureReason }).handoffReason ?? "error"
        pending.reject(markReason(err as Error, reason))
        return
      }

      // Import buildCliContext lazily so this module doesn't pull altimate.ts
      // into every consumer's import graph at load time.
      const { buildCliContext } = await import("../plugin/altimate")
      const cliContext = await buildCliContext().catch((err) => {
        log.warn("buildCliContext failed; proceeding without", { err: String(err) })
        return ""
      })

      const redirect = `http://127.0.0.1:${listenerHandle.port}/workspace-bound`
      const target = new URL("/create-and-link", webUrl)
      target.searchParams.set("client", "altimate-code")
      target.searchParams.set("redirect", redirect)
      target.searchParams.set("state", state)
      if (input.identifier.repoRemote) target.searchParams.set("project_remote", input.identifier.repoRemote)
      if (input.identifier.projectPath) target.searchParams.set("project_path", input.identifier.projectPath)
      target.searchParams.set("project_name", input.projectName)
      const authorizeUrl = cliContext
        ? `${target.toString()}#cli_context=${encodeURIComponent(cliContext)}`
        : target.toString()

      try {
        await openBrowser(authorizeUrl)
      } catch (err) {
        // Browser open failed. Preserve the URL so the caller can copy-paste.
        pending.reject(
          Object.assign(
            markReason(new Error(`Could not open browser: ${err instanceof Error ? err.message : String(err)}`), "browser_open_failed"),
            { authorizeUrl },
          ),
        )
      }
    })()
  })

  return settled
}
