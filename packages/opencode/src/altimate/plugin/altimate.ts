import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createServer } from "http"
import { randomBytes } from "crypto"
import open from "open"
import { AltimateApi } from "../api/client"

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
// Pending flows keyed by the unguessable `state`. Registered synchronously in
// authorize() BEFORE the browser opens, so an instant redirect (an already
// signed-in user) is matched instead of dropped; keying by state also lets two
// concurrent /auth flows coexist without clobbering each other.
const pending = new Map<string, Pending>()

async function startCallbackServer(): Promise<void> {
  if (server) return
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
      entry.reject(new Error(error))
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
    try {
      await new Promise<void>((resolve, reject) => {
        // Bind to loopback only — the credential/abort endpoints must not be reachable
        // from the LAN.
        server!.listen(port, "127.0.0.1", () => resolve())
        server!.on("error", reject)
      })
      currentCallbackPort = port
      return
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException
      // Detach the failed listener before trying the next port — otherwise the
      // 'error' handler stays wired and fires on the next listen attempt too.
      server!.removeAllListeners("error")
      if (lastErr.code !== "EADDRINUSE") break
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
      if (pending.delete(state)) reject(new Error("Timed out waiting for browser sign-in"))
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

            // Try to open the browser, but ALWAYS print the URL to stderr too —
            // `open()` silently fails on SSH / tmux / WSL-without-wslu / VS Code
            // Remote-SSH, and without a printed URL a headless user gets no path
            // forward and times out staring at "Complete sign-in in your browser".
            await open(authorizeUrl).catch(() => undefined)
            process.stderr.write(
              `\nIf your browser didn't open automatically, complete sign-in at:\n  ${authorizeUrl}\n\n`,
            )

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
                  return { type: "success", key: authToken, provider: "altimate-backend" }
                } catch (err) {
                  // Log the reason (CSRF / timeout / invalid instance / …). Runs in the
                  // server process, so this goes to the log, not the TUI display.
                  console.error("[altimate] gateway sign-in failed:", err instanceof Error ? err.message : err)
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
