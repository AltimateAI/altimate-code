// Altimate Code onboarding prototype — stub server.
//
// One local Bun server on http://localhost:8787 serving BOTH the pixel-faithful
// web pages and the API the CLI talks to. The device-auth wire contract mirrors
// packages/opencode/src/account/index.ts exactly (standard OAuth device grant);
// instance provisioning is modeled as bearer-authenticated follow-up calls.
//
// Run:  ~/.bun/bin/bun run prototype/stub-server/server.ts
// Port override:  PORT=9000 bun run prototype/stub-server/server.ts

import {
  apiKeyInstance,
  authorize,
  createSession,
  getByDevice,
  getByRefresh,
  getByToken,
  getByUser,
  isInstanceTaken,
  isPersonalEmail,
  suggestInstance,
  listPendingEmails,
  markEmailVerified,
  mintToken,
  pollInstance,
  recordPendingEmail,
  rotateToken,
  startProvisioning,
} from "./state"
import { connectedPage, devInboxPage, googleChooserPage, instancePage, provisioningPage, registerPage, verifyPage } from "./pages"

const PORT = Number(process.env.PORT ?? 8787)
const TOKEN_TTL_SECONDS = 3600
const DEVICE_CODE_EXPIRES_IN = 900
const POLL_INTERVAL = 2
const VALID_TENANT_REGEX = /^[a-z_][a-z0-9_-]*$/

const PRIYA_EMAIL = "priya@acme.com"

function logEvent(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }))
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? ""
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? ""
  try {
    if (ct.includes("application/json")) return (await req.json()) as Record<string, unknown>
    if (ct.includes("form")) {
      const form = await req.formData()
      return Object.fromEntries([...form.entries()])
    }
  } catch {
    /* fall through */
  }
  return {}
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url
  const method = req.method.toUpperCase()

  // ---- API: device authorization (standard OAuth device grant) ----
  if (pathname === "/auth/device/code" && method === "POST") {
    const body = await readBody(req)
    const session = createSession(String(body.client_id ?? "opencode-cli"))
    logEvent("device_code_issued", { user_code: session.userCode })
    return json({
      device_code: session.deviceCode,
      user_code: session.userCode,
      verification_uri_complete: `/register?code=${session.userCode}`,
      expires_in: DEVICE_CODE_EXPIRES_IN,
      interval: POLL_INTERVAL,
    })
  }

  if (pathname === "/auth/device/token" && method === "POST") {
    const body = await readBody(req)
    const grant = String(body.grant_type ?? "")

    if (grant === "refresh_token") {
      const target = getByRefresh(String(body.refresh_token ?? ""))
      if (!target) return json({ error: "invalid_grant", error_description: "Unknown refresh token" }, 400)
      const rotated = rotateToken(target)
      return json({
        access_token: rotated.access,
        refresh_token: rotated.refresh,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SECONDS,
      })
    }

    const deviceCode = String(body.device_code ?? "")
    const session = getByDevice(deviceCode)
    if (!session) return json({ error: "expired_token", error_description: "Unknown device code" })
    if (session.status === "pending")
      return json({ error: "authorization_pending", error_description: "Waiting for the user to sign in" })

    const tokens = mintToken(session)
    logEvent("token_issued", { email: session.email })
    return json({
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
    })
  }

  // ---- API: bearer-authenticated follow-ups ----
  if (pathname === "/api/user" && method === "GET") {
    const session = requireSession(req)
    if (!session) return json({ error: "unauthorized" }, 401)
    return json({ id: session.email ?? "user", email: session.email, suggested_instance: session.suggestedInstance })
  }

  if (pathname === "/api/orgs" && method === "GET") {
    const session = requireSession(req)
    if (!session) return json({ error: "unauthorized" }, 401)
    return json([])
  }

  if (pathname === "/api/instance" && method === "POST") {
    const session = requireSession(req)
    if (!session) return json({ error: "unauthorized" }, 401)
    const body = await readBody(req)
    const name = String(body.name ?? "").trim().toLowerCase()
    if (!VALID_TENANT_REGEX.test(name))
      return json({ error: "invalid_name", error_description: "Invalid instance name" }, 400)
    if (isInstanceTaken(name)) {
      logEvent("instance_name_taken", { name })
      return json({ error: "name_taken", error_description: `Instance "${name}" is already taken` }, 409)
    }
    startProvisioning(session, name)
    logEvent("instance_provisioning", { name })
    return json({ status: "provisioning", instance: name }, 201)
  }

  if (pathname === "/api/instance" && method === "GET") {
    const session = requireSession(req)
    if (!session) return json({ error: "unauthorized" }, 401)
    const result = pollInstance(session)
    if (result.status === "ready" && result.apiKey) {
      if (!readyLogged.has(session.deviceCode)) {
        logEvent("instance_ready", { instance: result.instance })
        readyLogged.add(session.deviceCode)
      }
      return json({ status: "ready", instance: result.instance, api_key: result.apiKey })
    }
    // The name is entered on the WEB (/instance); until the form is submitted the
    // CLI polls through this state silently.
    if (result.status === "none") return json({ status: "awaiting_name" })
    return json({ status: result.status })
  }

  // ---- API: live instance-name availability (used by the /instance web page) ----
  if (pathname === "/api/instance/check" && method === "GET") {
    const name = (url.searchParams.get("name") ?? "").trim().toLowerCase()
    if (!VALID_TENANT_REGEX.test(name)) {
      return json({
        valid: false,
        error: "Use lowercase letters, numbers, - or _, starting with a letter or underscore.",
      })
    }
    if (isInstanceTaken(name)) return json({ valid: true, available: false, suggestion: suggestInstance(name) })
    return json({ valid: true, available: true })
  }

  // ---- Web: instance naming (same flow, right after sign-in) ----
  if (pathname === "/instance" && method === "GET") {
    const code = url.searchParams.get("code") ?? ""
    const session = getByUser(code)
    if (!session || session.status !== "authorized") return html(errorPage("Complete sign-in first."), 404)
    if (session.instanceStatus !== "none") return redirect("/connected")
    return html(instancePage(session.userCode, session.suggestedInstance ?? "workspace"))
  }

  if (pathname === "/web/instance" && method === "POST") {
    const body = await readBody(req)
    const code = String(body.code ?? "")
    const name = String(body.name ?? "").trim().toLowerCase()
    const session = getByUser(code)
    if (!session || session.status !== "authorized") return html(errorPage("Complete sign-in first."), 404)
    if (session.instanceStatus !== "none") return redirect("/connected")
    if (!VALID_TENANT_REGEX.test(name)) {
      return html(
        instancePage(session.userCode, name, {
          error: "Use lowercase letters, numbers, - or _, starting with a letter or underscore.",
        }),
      )
    }
    if (isInstanceTaken(name)) {
      logEvent("instance_name_taken", { name })
      return html(instancePage(session.userCode, name, { error: `"${name}" is taken — try ${suggestInstance(name)}` }))
    }
    startProvisioning(session, name)
    logEvent("instance_provisioning", { name })
    // Provisioning is shown WEB-side: spinner page that flips to "Connected"
    // when ready (the CLI just waits for authentication and consumes the key).
    return redirect(`/provisioning?code=${encodeURIComponent(session.userCode)}`)
  }

  if (pathname === "/provisioning" && method === "GET") {
    const code = url.searchParams.get("code") ?? ""
    const session = getByUser(code)
    if (!session || session.instanceStatus === "none") return html(errorPage("Complete sign-in first."), 404)
    return html(provisioningPage(session.userCode, session.email ?? ""))
  }

  // Web-side provisioning status (keyed by user_code; no key material returned —
  // the api_key travels only through the bearer-authenticated GET /api/instance)
  if (pathname === "/web/instance/status" && method === "GET") {
    const code = url.searchParams.get("code") ?? ""
    const session = getByUser(code)
    if (!session) return json({ error: "unknown session" }, 404)
    const result = pollInstance(session)
    return json({ status: result.status === "ready" ? "ready" : "provisioning" })
  }

  // ---- API: credential validation (mirrors the real backend's endpoint used by
  //      AltimateApi.validateCredentials) ----
  if (pathname === "/dbt/v3/validate-credentials" && method === "GET") {
    const token = bearerToken(req)
    const tenant = req.headers.get("x-tenant") ?? ""
    const instance = token ? apiKeyInstance(token) : undefined
    if (!token || instance === undefined) {
      logEvent("credential_validation_failed", { reason: "invalid_key" })
      return json({ error: "invalid key" }, 401)
    }
    if (instance !== tenant.toLowerCase()) {
      logEvent("credential_validation_failed", { reason: "invalid_instance", tenant })
      return json({ error: "invalid instance" }, 403)
    }
    return json({ ok: true })
  }

  // ---- Prototype: CLI-side instrumentation events (fire-and-forget) ----
  if (pathname === "/dev/event" && method === "POST") {
    const body = await readBody(req)
    const { event, ...data } = body
    logEvent(String(event ?? "unknown"), data as Record<string, unknown>)
    return json({ ok: true })
  }

  // ---- Web: OAuth (Google) path ----
  if (pathname === "/oauth/google" && method === "GET") {
    const code = url.searchParams.get("code") ?? ""
    logEvent("provider_selected", { provider: "google", user_code: code })
    return html(googleChooserPage(code))
  }

  if (pathname === "/oauth/google/callback" && method === "GET") {
    const code = url.searchParams.get("code") ?? ""
    const session = getByUser(code)
    if (!session) return html(errorPage("Unknown or expired sign-in session."), 404)
    authorize(session, PRIYA_EMAIL)
    logEvent("device_authorized", { method: "google", email: PRIYA_EMAIL })
    // Instance naming happens in the same web flow, right after sign-in.
    return redirect(`/instance?code=${encodeURIComponent(session.userCode)}`)
  }

  // ---- Web: email path ----
  if (pathname === "/auth/email" && method === "POST") {
    const body = await readBody(req)
    const code = String(body.code ?? "")
    const email = String(body.email ?? "").trim()
    if (isPersonalEmail(email)) {
      logEvent("signup_blocked_personal_email", { email })
      return html(
        registerPage(code, {
          open: true,
          emailValue: email,
          emailError: "Please use your work email — personal email domains aren't supported.",
        }),
      )
    }
    recordPendingEmail(code, email)
    logEvent("email_signup_started", { email })
    return redirect(`/verify?code=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}`)
  }

  if (pathname === "/dev/inbox" && method === "GET") {
    return html(devInboxPage(listPendingEmails()))
  }

  if (pathname === "/dev/inbox/verify" && method === "GET") {
    const code = url.searchParams.get("code") ?? ""
    const pending = markEmailVerified(code)
    const session = getByUser(code)
    if (pending && session) {
      authorize(session, pending.email)
      logEvent("device_authorized", { method: "email", email: pending.email })
      // Continue the same web flow: name the instance right after verification.
      return redirect(`/instance?code=${encodeURIComponent(session.userCode)}`)
    }
    return redirect("/dev/inbox")
  }

  // ---- Web: Altimate pages ----
  if ((pathname === "/" || pathname === "/register") && method === "GET") {
    const code = url.searchParams.get("code") ?? ""
    return html(registerPage(code))
  }

  if (pathname === "/connected" && method === "GET") {
    return html(connectedPage(PRIYA_EMAIL))
  }

  if (pathname === "/verify" && method === "GET") {
    const email = url.searchParams.get("email") ?? "your email"
    return html(verifyPage(email))
  }

  if (pathname === "/assets/signup-design-reference.png" && method === "GET") {
    return new Response(Bun.file(new URL("../assets/signup-design-reference.png", import.meta.url)))
  }

  return html(errorPage("Not found"), 404)
}

// --- helpers that need the session store ---

function requireSession(req: Request) {
  const token = bearerToken(req)
  if (!token) return undefined
  return getByToken(token)
}

// Tracks which sessions have already logged `instance_ready`, so the poll loop
// only emits it once.
const readyLogged = new Set<string>()

function errorPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Altimate prototype</title>
  <body style="font-family:system-ui;background:#F4F5F8;color:#222529;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center"><h1 style="font-weight:600">${message}</h1></div></body>`
}

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  fetch: handle,
})

console.log(`\n  Altimate Code onboarding stub server`)
console.log(`  → http://localhost:${PORT}/register`)
console.log(`  → http://localhost:${PORT}/dev/inbox   (email fallback mailbox)\n`)
