import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createServer } from "http"
import { randomBytes } from "crypto"
import open from "open"
import { AltimateApi } from "../api/client"
// altimate_change — onboarding telemetry for the gateway sign-in funnel
import * as OnboardingTelemetry from "../telemetry/onboarding"

/**
 * Why a failure reason is attached at the rejection site rather than inferred from the message:
 * `gateway_auth_failed.reason` is a closed enum, and the callback's catch sees only an Error.
 * Matching on message text would silently drift the moment any of these strings is reworded, and
 * the `error` query param is attacker-influenced text we must not parse or forward. Tagging the
 * error where the cause is known keeps the classification deterministic — and note that an
 * unknown/invalid `state` never rejects a pending flow at all (the handler 400s without touching
 * the map), so a CSRF mismatch legitimately surfaces later as `timeout`, not `denied`.
 */
type GatewayFailureReason = "timeout" | "denied" | "error"

function markReason(err: Error, reason: GatewayFailureReason): Error {
  return Object.assign(err, { altimateGatewayReason: reason })
}

function reasonOf(err: unknown): GatewayFailureReason {
  const tagged = (err as { altimateGatewayReason?: GatewayFailureReason } | undefined)?.altimateGatewayReason
  return tagged ?? "error"
}

// Loopback port range the CLI listens on for the browser to deliver the gateway
// credential after sign-in. We prefer 7317 (mnemonic + otherwise unused in this
// codebase), then fall back through 7318..7325 so a squatting dev tool
// (Docker Desktop, Rancher, a stray dev server) can't wedge sign-in. The
// browser is redirected to whatever port we successfully bind, so the fallback
// is transparent to the user.
const CALLBACK_PORT_PREFERRED = 7317
const CALLBACK_PORT_MAX = 7325
// Actual port bound at runtime — filled in by startCallbackServer() so the
// authorize URL redirect matches whatever we could grab.
let currentCallbackPort: number | undefined

// Web app that hosts the signup/login (authorize) page. Overridable for
// dev/staging via ALTIMATE_WEB_URL.
const DEFAULT_WEB_URL = "https://app.myaltimate.com"
// Fallback gateway API base when the browser callback omits a url. Overridable
// for dev/staging via ALTIMATE_API_URL (mirrors ALTIMATE_WEB_URL) — e.g. point
// the token exchange at a local backend when the web has no BACKEND_API_URL to
// deliver.
const DEFAULT_API_URL = "https://api.myaltimate.com"

// The one-time login_token is POSTed to the callback-supplied API base, so that
// base must be trusted — otherwise a crafted callback could exfiltrate the token
// to an attacker's server. Allow only HTTPS Altimate-owned hosts, an explicitly
// configured ALTIMATE_API_URL, or loopback (for local dev, where http is ok).
function isTrustedApiUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  const host = u.hostname
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1"
  // An operator-configured ALTIMATE_API_URL backend is trusted so the exchange can
  // point at a dev/staging backend, which is commonly plain http on a non-loopback
  // host (docker/LAN). Match the configured ORIGIN (scheme + host + port), not the
  // host alone — otherwise an https-configured host could be downgraded to plaintext
  // http on a hostname match (a callback `url=http://<same-host>` would leak the
  // one-time token over cleartext). Plain-http dev still works when the operator
  // themselves configured http.
  const configured = process.env.ALTIMATE_API_URL
  if (configured) {
    try {
      const c = new URL(configured)
      if (c.protocol === u.protocol && c.host === u.host) return true
    } catch {
      /* ignore a malformed override */
    }
  }
  // Everything else must be HTTPS (or http on loopback for local dev).
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback)) return false
  if (isLoopback) return true
  return host === "api.myaltimate.com" || host.endsWith(".myaltimate.com") || host.endsWith(".altimate.ai")
}

// Escape reflected values before interpolating them into the callback HTML — the
// error text originates from the URL query string, so it must not be trusted.
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  )
}

// Neutral copy: the loopback returns this as soon as it RECEIVES the token, before
// the CLI has exchanged/persisted it — so don't claim "Signed in" (the terminal is
// the source of truth for actual success/failure).
const HTML_SUCCESS = `<!doctype html><meta charset="utf-8"><title>Altimate Code</title>
<body style="font-family:system-ui;text-align:center;padding:64px">
<h2>Authorization received</h2><p>Return to your terminal to finish connecting.</p>
<script>setTimeout(()=>window.close(),1500)</script></body>`

const HTML_ERROR = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Altimate Code</title>
<body style="font-family:system-ui;text-align:center;padding:64px">
<h2>Connection failed</h2><p>${escapeHtml(msg)}</p><p>Please return to your terminal and try again.</p></body>`

interface CallbackResult {
  api_url: string
  instance: string
  // Short-lived, one-time login_token delivered by the browser. Exchanged for
  // the gateway auth_token in callback() — the raw api_key never rides in the URL.
  token: string
}

interface Pending {
  resolve: (creds: CallbackResult) => void
  reject: (err: Error) => void
}

let server: ReturnType<typeof createServer> | undefined
// Shared in-flight startup promise. Concurrent `authorize()` calls must await
// the SAME startup (and read the SAME bound port) instead of one racing past
// the other on a stale/undefined `currentCallbackPort`. Cleared on both
// success and failure so a subsequent retry re-runs the port walk.
let startupInFlight: Promise<void> | undefined
// Pending flows keyed by the unguessable `state`. Registered synchronously in
// authorize() BEFORE the browser opens, so an instant redirect (an already
// signed-in user) is matched instead of dropped. Note: `ProviderAuth.authorize`
// (packages/opencode/src/provider/auth.ts) stores one pending flow per provider,
// so two OVERLAPPING Altimate sign-ins at the same time are already unsupported
// at the layer above — this map still exists per-state so a browser callback
// arriving out-of-order can find its own promise, and to keep the same server
// reusable across sequential sign-ins.
const pending = new Map<string, Pending>()

async function startCallbackServer(): Promise<void> {
  // Fast path: server already bound and healthy.
  if (server && currentCallbackPort !== undefined) return
  // Coalesce: a second caller mid-startup awaits the first's outcome so the
  // redirect it builds uses the actually-bound port, not a guess. Without
  // this, `currentCallbackPort ?? PREFERRED` would resolve to 7317 on the
  // second caller before the first's port walk finished — the exact race
  // CodeRabbit + cubic flagged as P1.
  if (startupInFlight) return startupInFlight
  startupInFlight = doStartCallbackServer()
  try {
    await startupInFlight
  } finally {
    startupInFlight = undefined
  }
}

async function doStartCallbackServer(): Promise<void> {
  server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${currentCallbackPort ?? CALLBACK_PORT_PREFERRED}`)
    if (url.pathname !== "/callback") {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    const html = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "text/html" })
      res.end(body)
    }

    // Validate `state` FIRST — before honoring `error` — so a request without a
    // known state can neither cancel an in-progress flow nor deliver anything.
    const state = url.searchParams.get("state")
    const entry = state ? pending.get(state) : undefined
    if (!state || !entry) {
      html(400, HTML_ERROR("Invalid or unknown sign-in state"))
      return
    }
    pending.delete(state)

    const error = url.searchParams.get("error")
    if (error) {
      // altimate_change — the browser reported an explicit failure: the only true `denied` signal
      entry.reject(markReason(new Error(error), "denied"))
      html(200, HTML_ERROR(error))
      return
    }

    const token = url.searchParams.get("token")
    const instance = url.searchParams.get("instance")
    const apiUrl = url.searchParams.get("url") || process.env.ALTIMATE_API_URL || DEFAULT_API_URL
    if (!token || !instance) {
      const msg = "Missing credential in callback"
      entry.reject(new Error(msg))
      html(400, HTML_ERROR(msg))
      return
    }
    if (!isTrustedApiUrl(apiUrl)) {
      // Refuse to hand the one-time token to an untrusted exchange target.
      const msg = "Untrusted callback URL"
      entry.reject(new Error(msg))
      html(400, HTML_ERROR(msg))
      return
    }

    entry.resolve({ api_url: apiUrl, instance, token })
    html(200, HTML_SUCCESS)
  })

  // Walk the port range so a squatting dev tool on 7317 doesn't wedge sign-in.
  // First success wins; only report EADDRINUSE if every port in the range is
  // taken. Non-EADDRINUSE errors fail fast (permissions, exhausted fds).
  const tried: number[] = []
  let lastErr: NodeJS.ErrnoException | undefined
  for (let port = CALLBACK_PORT_PREFERRED; port <= CALLBACK_PORT_MAX; port++) {
    tried.push(port)
    // Use a NAMED handler for the bind attempt so we can removeListener on
    // both success AND failure. A prior version left the anonymous `reject`
    // wired on success — a later runtime error would then call reject() on
    // an already-resolved promise (silent no-op), swallowing the diagnostic.
    // A named handler pairs cleanly with removeListener + makes the lifetime
    // symmetric.
    const onListenErr = (err: NodeJS.ErrnoException) => {
      lastErr = err
    }
    let bound = false
    try {
      await new Promise<void>((resolve, reject) => {
        // Bind to loopback only — the credential/abort endpoints must not be reachable
        // from the LAN.
        const onErr = (err: NodeJS.ErrnoException) => {
          onListenErr(err)
          reject(err)
        }
        server!.once("error", onErr)
        server!.listen(port, "127.0.0.1", () => {
          server!.removeListener("error", onErr)
          resolve()
        })
      })
      bound = true
      currentCallbackPort = port
      return
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException
      // `once` self-detached on fire; nothing to remove here. If the code
      // ever moves back to `on(...)`, add an explicit removeListener here.
      if (lastErr.code !== "EADDRINUSE") break
    } finally {
      if (!bound) {
        // Defensive: even with `once`, if the promise rejects for any
        // reason OTHER than an `error` event (unlikely today, cheap
        // insurance for future edits), make sure no stale handler remains.
        server!.removeAllListeners("error")
      }
    }
  }
  // Every candidate port is either taken or gave a hard failure. Reset so a
  // retry isn't blocked by the `if (server) return` guard.
  server = undefined
  currentCallbackPort = undefined
  const code = lastErr?.code
  throw new Error(
    code === "EADDRINUSE"
      ? `Every port in ${CALLBACK_PORT_PREFERRED}-${CALLBACK_PORT_MAX} is already in use (tried ${tried.join(", ")}). Close whatever is using them (e.g. \`lsof -i :${CALLBACK_PORT_PREFERRED}\`) and try again.`
      : `Could not start the sign-in server: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

function stopCallbackServer() {
  if (server) {
    server.close()
    server = undefined
    currentCallbackPort = undefined
  }
}

// Register a pending flow keyed by `state` and return its promise. Called
// synchronously in authorize() before the browser opens; the server handler
// resolves/rejects it by state, so a fast redirect is never lost.
// 15-minute window for the whole flow — the earlier 5-minute default was too
// short for corporate SSO where Okta → Duo → password manager → MFA on phone
// can easily push past 5 min. Ticket load ("got MFA prompt, went to phone, came
// back, sign-in failed") justifies the longer wait.
function registerPending(state: string, timeoutMs = 15 * 60 * 1000): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // altimate_change — tag as `timeout` for gateway_auth_failed classification
      if (pending.delete(state)) reject(markReason(new Error("Timed out waiting for browser sign-in"), "timeout"))
      // If the dialog was dismissed and callback() never ran its finally, the
      // loopback server would otherwise stay bound past the timeout. Free the
      // port once nothing is waiting on it.
      if (pending.size === 0) stopCallbackServer()
    }, timeoutMs)
    pending.set(state, {
      resolve: (creds) => {
        clearTimeout(timeout)
        resolve(creds)
      },
      reject: (err) => {
        clearTimeout(timeout)
        reject(err)
      },
    })
  })
}

export async function AltimateAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "altimate-backend",
      methods: [
        {
          type: "oauth",
          label: "Altimate LLM Gateway",
          async authorize() {
            const state = randomBytes(16).toString("hex")
            await startCallbackServer()
            // Register the pending flow BEFORE opening the browser so an instant
            // redirect can be matched by state rather than dropped as CSRF.
            const result = registerPending(state)
            // If callback() is never awaited (e.g. the dialog is dismissed before it
            // runs), the pending promise still rejects on timeout — swallow that here
            // so it can't surface as an unhandled rejection. callback() awaits the
            // same promise independently.
            void result.catch(() => {})

            const webUrl = (process.env.ALTIMATE_WEB_URL || DEFAULT_WEB_URL).replace(/\/+$/, "")
            // Use 127.0.0.1 to match the loopback bind — a plain `localhost` redirect
            // can resolve to ::1 first and hit a closed IPv6 port. `currentCallbackPort`
            // reflects the actual port startCallbackServer() grabbed (may fall back
            // from 7317 to 7318..7325 if a dev tool is squatting).
            const boundPort = currentCallbackPort ?? CALLBACK_PORT_PREFERRED
            const redirect = `http://127.0.0.1:${boundPort}/callback`
            // Land on the sign-up page and let the user choose how to authenticate
            // (Google today, more providers later) rather than forcing Google.
            const authorizeUrl =
              `${webUrl}/register?client=altimate-code` +
              `&redirect=${encodeURIComponent(redirect)}` +
              `&state=${state}`

            // Try to open the browser. Failure is silent because the URL is
            // already surfaced elsewhere: the auth dialog in packages/tui/src/
            // component/dialog-provider.tsx renders it as a clickable Link and
            // binds `c` to copy it to the clipboard. An earlier version wrote
            // the URL to process.stderr here as a fallback for SSH/tmux, but
            // the auth plugin runs inside a worker whose stderr is redirected
            // to the log file at the top of packages/opencode/src/cli/tui/
            // worker.ts — so that write reached the log, never the terminal.
            // Removed to stop leaking state-bearing authorize URLs into logs.
            await open(authorizeUrl).catch(() => undefined)

            // altimate_change start — onboarding funnel: gateway sign-in started.
            // Spec name is `gateway_device_code_issued`; this flow is a browser loopback OAuth
            // with no device code, so the event means "authorize URL built, browser open
            // attempted". open() failures are swallowed above (the URL is also printed for the
            // user to paste), so this fires even when no browser actually launched.
            // The URL is never sent — it carries the CSRF `state`.
            const startedAt = Date.now()
            void OnboardingTelemetry.emit({ type: "gateway_device_code_issued" })
            // altimate_change end

            return {
              url: authorizeUrl,
              instructions: "Complete sign-in in your browser to connect Altimate LLM Gateway.",
              method: "auto",
              async callback() {
                try {
                  const creds = await result
                  // The instance name comes from the browser callback; validate it
                  // before persisting (the manual paste path validates too).
                  if (!AltimateApi.isValidInstanceName(creds.instance)) {
                    throw new Error(`invalid instance name from callback: ${creds.instance}`)
                  }
                  // Exchange the short-lived, one-time login_token for the gateway
                  // auth_token server-side — the raw api_key never rides in the URL.
                  const authToken = await AltimateApi.exchangeSocialToken(creds.api_url, creds.instance, creds.token)
                  // Persist to ~/.altimate/altimate.json — the provider loader
                  // reads this first (it carries the instance/tenant + api_url
                  // the generic auth.json store can't).
                  await AltimateApi.saveCredentials({
                    altimateUrl: creds.api_url,
                    altimateInstanceName: creds.instance,
                    altimateApiKey: authToken,
                  })
                  // altimate_change start — onboarding funnel: auth succeeded and the instance
                  // is live. The instance name is the customer's tenant identifier and is never
                  // sent. time_to_connect_ms is measured from the browser-open above, so it
                  // belongs to this attempt's closure rather than any shared pending state.
                  void OnboardingTelemetry.emit({ type: "gateway_auth_completed" })
                  void OnboardingTelemetry.emit({
                    type: "instance_connected",
                    time_to_connect_ms: Date.now() - startedAt,
                  })
                  // altimate_change end
                  return { type: "success", key: authToken, provider: "altimate-backend" }
                } catch (err) {
                  // Log the reason (CSRF / timeout / invalid instance / …). Runs in the
                  // server process, so this goes to the log, not the TUI display.
                  console.error("[altimate] gateway sign-in failed:", err instanceof Error ? err.message : err)
                  // altimate_change — onboarding funnel: only the classified enum is sent. The
                  // message can embed the instance name (see the invalid-instance throw above),
                  // so it never reaches telemetry.
                  void OnboardingTelemetry.emit({ type: "gateway_auth_failed", reason: reasonOf(err) })
                  return { type: "failed" }
                } finally {
                  // Keep the shared server up while another flow is still waiting.
                  if (pending.size === 0) stopCallbackServer()
                }
              },
            }
          },
        },
        {
          // Fallback: paste an instance-name::api-key manually.
          type: "api",
          label: "Paste API key",
        },
      ],
    },
  }
}
