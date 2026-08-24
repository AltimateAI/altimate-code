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

/** DNS-label-shaped tenant guard for the freemium subdomain. Credentials
 * only require ``altimateInstanceName`` to be a non-empty string, so a tenant
 * like ``evil.example/path?x=`` would otherwise be interpolated straight into
 * the origin, opening the handoff URL — carrying the project path, remote,
 * callback address, CSRF state, and telemetry context — at
 * ``https://evil.example`` (m3 in the consensus review). Reject anything that
 * would not survive a round-trip through URL parsing back to the same host. */
const TENANT_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

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
<script>window.location.replace(${escapeInlineScript(manageUrl)})</script></body>`
}

const log = Log.create({ service: "altimate-workspace-handoff" })

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  )
}

/** JSON-encode + escape any ``</`` so a value containing ``</script>`` cannot
 * close the surrounding inline <script> block. Not reachable via any
 * caller-supplied field today (tenant is DNS-label-guarded, workspace_id is
 * a validated integer), but the belt-and-suspenders is trivial. (N5.b in
 * the consensus review.) */
function escapeInlineScript(value: string): string {
  return JSON.stringify(value).replace(/<\/(script)/gi, "<\\/$1")
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
<script>window.location.replace(${escapeInlineScript(home)})</script></body>`
}

export type HandoffFailureReason =
  | "unavailable" // resolveWorkspaceWebUrl returned null (not freemium)
  | "not_configured" // CLI credentials not present
  | "timeout" // 15-min window expired
  | "cancelled" // user hit Cancel in the browser
  | "tenant_mismatch" // callback tenant != credentials tenant
  | "port_exhausted" // 7317..7325 all EADDRINUSE
  | "browser_open_failed"
  | "aborted" // caller-provided AbortSignal fired
  | "error"

/** Snapshot of the credentials the handoff started against, returned to the
 * caller so it can re-verify against fresh creds immediately before binding
 * (M6 in the consensus review). Workspace ids are tenant-schema-local, so
 * binding a callback validated for tenant A under tenant B (after an account
 * switch mid-flow) would 404 or, worse, hit an unrelated workspace. */
export interface CredentialFingerprint {
  apiUrl: string
  tenant: string
}

export interface HandoffSuccess {
  ok: true
  workspaceId: number
  tenant: string
  /** Credentials the handoff resolved and validated the callback against.
   * Callers must compare against ``AltimateApi.getCredentials()`` at bind
   * time and refuse the bind if either field drifted. */
  credentials: CredentialFingerprint
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
 * Dev escape hatch: ``ALTIMATE_WORKSPACE_WEB_URL`` overrides the tenant map
 * lookup when set. The override is DEV-ONLY — it returns the URL as-is
 * without tenant scoping (which is what a local ``altimate2.localhost:3003``
 * dev server needs). Production callers must not set it; if it is somehow
 * present and points off-tenant, the CSRF ``state`` still gates the callback
 * so no cross-workspace bind is possible. */
export function resolveWorkspaceWebUrl(altimateUrl: string, tenant: string): URL | null {
  const override = process.env["ALTIMATE_WORKSPACE_WEB_URL"]
  if (override) {
    try {
      const u = new URL(override)
      if (u.protocol !== "http:" && u.protocol !== "https:") return null
      return u
    } catch {
      return null
    }
  }
  try {
    const apiHost = new URL(altimateUrl).host
    if (apiHost !== FREEMIUM_API_HOST) return null
    // DNS-label guard — see TENANT_LABEL_RE for rationale. Double-check by
    // reconstructing the origin from the parsed URL: if the parser resolved
    // to a different host (embedded slashes, port, path in the "tenant"),
    // refuse rather than emit a URL that points off-domain.
    if (!TENANT_LABEL_RE.test(tenant)) return null
    const lower = tenant.toLowerCase()
    const u = new URL(`https://${lower}.${FREEMIUM_WORKSPACE_HOST}`)
    if (u.hostname !== `${lower}.${FREEMIUM_WORKSPACE_HOST}`) return null
    return u
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
    // DNS-rebinding guard — bind to 127.0.0.1 is not enough on its own. A
    // malicious page can point its own hostname at 127.0.0.1, drive the
    // browser to ``http://attacker.com:7317/workspace-bound?state=...&
    // workspace_id=...``, and the connection lands here. The Host header
    // it sends is ``attacker.com``, so refusing anything except our own
    // loopback authorities kills the attack before state validation runs.
    // (altimate-harness-bot round 8.)
    const reqHost = (req.headers.host ?? "").toLowerCase()
    if (reqHost !== `127.0.0.1:${port}` && reqHost !== `localhost:${port}`) {
      res.writeHead(400)
      res.end("Bad request")
      return
    }
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

    // Integer-only: floats like ``42.5`` are rejected server-side but produce
    // a confusing failure the caller can't recover from. (m9 in the review.)
    // Also reject non-canonical spellings — ``Number()`` happily coerces
    // ``"1e2"``, ``"0x2a"``, and ``"  42 "`` into finite integers, so a
    // callback URL carrying those forms would slip past ``isInteger`` and
    // reach the bind payload. Requiring a plain decimal-digit string first
    // is the tight gate. (cubic cycle 4/5.)
    if (!/^[1-9][0-9]*$/.test(workspaceIdRaw)) {
      const msg = `Invalid workspace_id: ${workspaceIdRaw}`
      respond(400, htmlError(msg))
      pending.reject(markReason(new Error(msg), "error"))
      return
    }
    const workspaceId = Number(workspaceIdRaw)
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
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
    // Callback validated — but the SUCCESS payload carries the credentials
    // snapshot the handoff was started against; the caller re-verifies
    // against fresh creds before binding (M6). This module never binds.
    pending.resolve({
      ok: true,
      workspaceId,
      tenant,
      credentials: { apiUrl: "", tenant: pending.expectedTenant }, // apiUrl filled in by caller
    })
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
      // Post-listen persistent error handler. Without this, any socket-level
      // ``error`` event during the ~15-minute wait (spurious ECONNRESET,
      // client abort mid-request, an OS EMFILE spike) is unhandled and takes
      // the process down. We can't do anything useful with the error — the
      // listener is per-flow and short-lived — so log-and-continue is the
      // right call. (CodeRabbit cycle 6.)
      server.on("error", (err: NodeJS.ErrnoException) => {
        log.warn("handoff loopback listener emitted a post-listen error", {
          code: err.code,
          err: err.message,
        })
      })
      return { server, port }
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException
      // Defensive cleanup in case any listeners linger after a rejected bind.
      server.removeAllListeners("error")
      // Only keep walking on EADDRINUSE — any other errno (EACCES, EBADF, …)
      // is a real problem, not port squatting, so break out and report it
      // faithfully rather than falsely claiming "all ports in use". (m5)
      if (lastErr.code !== "EADDRINUSE") break
    }
  }

  server.close()
  // server.close() only stops accepting new connections — any keep-alive
  // socket still open in the port-exhaustion / squatter case keeps the
  // port bound until the peer drops. Force-terminate here so the next
  // ``altimate-code link`` doesn't skip this port needlessly. Guard with
  // ``?.()`` for Node <18.2. (altimate-harness-bot round 8.)
  server.closeAllConnections?.()
  const code = lastErr?.code
  throw markReason(
    new Error(
      code === "EADDRINUSE"
        ? `Every port in ${CALLBACK_PORT_MIN}-${CALLBACK_PORT_MAX} is in use (tried ${tried.join(", ")}). Close what's using them (e.g. \`lsof -i :${CALLBACK_PORT_MIN}\`) and try again.`
        : `Could not start the workspace-handoff server: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    ),
    code === "EADDRINUSE" ? "port_exhausted" : "error",
  )
}

export interface OpenBrowserHandoffInput {
  identifier: ProjectIdentifier
  projectName: string
  /** Optional AbortSignal — if it fires the flow settles with
   * ``{ok: false, reason: "aborted"}`` and tears down the listener. Lets a
   * TUI supersede a stale handoff without leaking a port for the full
   * 15-minute window. (m2) */
  signal?: AbortSignal
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
  // Preflight is inside the same try/catch that owns the startup IIFE — a
  // rejection from ``getCredentials()`` (malformed JSON, unresolved ${env:…}
  // placeholder, schema mismatch) or from any other setup step converts to
  // a HandoffResult instead of propagating as an unhandled rejection into
  // the TUI's ``void runBrowserHandoff(...)`` call sites. (M4)
  let creds: Awaited<ReturnType<typeof AltimateApi.getCredentials>>
  let webUrl: URL
  try {
    if (!(await AltimateApi.isConfigured().catch(() => false))) {
      return { ok: false, reason: "not_configured" }
    }
    creds = await AltimateApi.getCredentials()
    const resolved = resolveWorkspaceWebUrl(creds.altimateUrl, creds.altimateInstanceName)
    if (!resolved) return { ok: false, reason: "unavailable" }
    webUrl = resolved
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const state = randomBytes(16).toString("hex")

  // Register pending, then bind the listener. Timeout owns rejection with
  // reason "timeout"; the listener's own reject paths mark their own reasons.
  let listenerHandle: { server: Server; port: number } | undefined
  // ``settled`` reflects whether ``pending.resolve``/``pending.reject`` has
  // fired. Needed to close the server if the flow rejects (timeout / abort /
  // browser-open failure) DURING the ``await startListener(pending)`` window
  // — otherwise ``closeListener`` runs while ``listenerHandle`` is still
  // undefined, then the awaited startListener returns a server that never
  // gets closed and stays bound for the full 15-min timeout. (cubic cycle 5.)
  let settled = false
  const closeListener = () => {
    if (listenerHandle) {
      try {
        listenerHandle.server.close()
        // Force-terminate lingering keep-alive sockets — otherwise the
        // port can stay bound for minutes after abort/timeout and the
        // next ``altimate-code link`` walks past it needlessly. Guard
        // with ``?.()`` for Node <18.2. (altimate-harness-bot round 8.)
        listenerHandle.server.closeAllConnections?.()
      } catch {
        /* best effort */
      }
      listenerHandle = undefined
    }
  }

  return new Promise<HandoffResult>((resolve) => {
    let onAbort: (() => void) | null = null
    const pending: HandoffPending = {
      state,
      expectedTenant: creds.altimateInstanceName,
      workspaceWebBase: webUrl,
      resolve: (v) => {
        settled = true
        closeListener()
        clearTimeout(timeoutHandle)
        if (onAbort && input.signal) input.signal.removeEventListener("abort", onAbort)
        // Fill in the apiUrl snapshot the listener couldn't set (it doesn't
        // hold ``creds``); the tenant already went through the expectedTenant
        // check inside the listener.
        resolve({ ...v, credentials: { apiUrl: creds.altimateUrl, tenant: v.tenant } })
      },
      reject: (err) => {
        settled = true
        closeListener()
        clearTimeout(timeoutHandle)
        if (onAbort && input.signal) input.signal.removeEventListener("abort", onAbort)
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
    // ``.unref()`` so the timer alone doesn't keep the CLI process alive
    // once every other handle has exited. (m2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(timeoutHandle as any)?.unref?.()

    // Wire the AbortSignal — if it fires the flow settles with
    // ``reason: "aborted"`` and the listener is torn down immediately.
    if (input.signal) {
      if (input.signal.aborted) {
        pending.reject(markReason(new Error("Handoff aborted"), "aborted"))
        return
      }
      onAbort = () => pending.reject(markReason(new Error("Handoff aborted"), "aborted"))
      input.signal.addEventListener("abort", onAbort, { once: true })
    }

    ;(async () => {
      try {
        listenerHandle = await startListener(pending)
        // If the flow already settled during the ``await`` above (timeout
        // fired, abort fired, browser-open failed), ``closeListener`` ran
        // with ``listenerHandle`` still undefined — nothing was closed. Now
        // that we own a real handle, close it and bail so it doesn't sit
        // bound for the full timeout. (cubic cycle 5.)
        if (settled) {
          closeListener()
          return
        }
        // Capture the port to a local IMMEDIATELY — ``listenerHandle`` is
        // cleared by ``closeListener`` on timeout, and a lazy ``import()``
        // below can straddle that clear. (M4 sub-case)
        const boundPort = listenerHandle.port

        // Import buildCliContext lazily so this module doesn't pull altimate.ts
        // into every consumer's import graph at load time.
        const { buildCliContext } = await import("../plugin/altimate")
        const cliContext = await buildCliContext().catch((err) => {
          log.warn("buildCliContext failed; proceeding without", { err: String(err) })
          return ""
        })

        const redirect = `http://127.0.0.1:${boundPort}/workspace-bound`
        const target = new URL("/create-and-link", webUrl)
        target.searchParams.set("client", "altimate-code")
        target.searchParams.set("redirect", redirect)
        target.searchParams.set("state", state)
        target.searchParams.set("project_name", input.projectName)
        // Project path + remote go in the URL FRAGMENT, not the query, so
        // they don't land in SaaS access logs, WAF logs, or browser history
        // as query params. Same rationale as ``cli_context`` in altimate.ts
        // (see altimate.ts:135-137). (m6)
        const fragment = new URLSearchParams()
        if (input.identifier.repoRemote) fragment.set("project_remote", input.identifier.repoRemote)
        if (input.identifier.projectPath) fragment.set("project_path", input.identifier.projectPath)
        if (cliContext) fragment.set("cli_context", cliContext)
        const authorizeUrl = fragment.toString()
          ? `${target.toString()}#${fragment.toString()}`
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
      } catch (err) {
        // ANY throw in this async IIFE — startListener rejection, the lazy
        // ``import()``, ``buildCliContext()`` panic — funnels through
        // pending.reject so ``settled`` resolves and the caller sees a
        // ``HandoffResult`` instead of a 15-minute silent hang. (M4)
        const reason = (err as { handoffReason?: HandoffFailureReason }).handoffReason ?? "error"
        pending.reject(markReason(err as Error, reason))
      }
    })()
  })
}
