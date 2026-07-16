import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createServer } from "http"
import { randomBytes } from "crypto"
import open from "open"
import { AltimateApi } from "../api/client"

// Loopback port the CLI listens on for the browser to deliver the gateway
// credential after sign-in. Must match the redirect the web authorize page posts
// back to. 7317 is otherwise unused in this codebase.
const CALLBACK_PORT = 7317

// Web app that hosts the signup/login (authorize) page. Overridable for
// dev/staging via ALTIMATE_WEB_URL.
const DEFAULT_WEB_URL = "https://app.myaltimate.com"
// Fallback gateway API base if the callback omits one.
const DEFAULT_API_URL = "https://api.myaltimate.com"

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
    const url = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`)
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
    const apiUrl = url.searchParams.get("url") || DEFAULT_API_URL
    if (!token || !instance) {
      const msg = "Missing credential in callback"
      entry.reject(new Error(msg))
      html(400, HTML_ERROR(msg))
      return
    }

    entry.resolve({ api_url: apiUrl, instance, token })
    html(200, HTML_SUCCESS)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      // Bind to loopback only — the credential/abort endpoints must not be reachable
      // from the LAN.
      server!.listen(CALLBACK_PORT, "127.0.0.1", () => resolve())
      server!.on("error", reject)
    })
  } catch (err) {
    // Reset so a retry isn't blocked by the `if (server) return` guard, and surface
    // a clear reason (e.g. the port is already taken) instead of hanging.
    server = undefined
    const code = (err as NodeJS.ErrnoException)?.code
    throw new Error(
      code === "EADDRINUSE"
        ? `Port ${CALLBACK_PORT} is already in use — close whatever is using it and try again.`
        : `Could not start the sign-in server: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function stopCallbackServer() {
  if (server) {
    server.close()
    server = undefined
  }
}

// Register a pending flow keyed by `state` and return its promise. Called
// synchronously in authorize() before the browser opens; the server handler
// resolves/rejects it by state, so a fast redirect is never lost.
function registerPending(state: string, timeoutMs = 5 * 60 * 1000): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pending.delete(state)) reject(new Error("Timed out waiting for browser sign-in"))
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
            // can resolve to ::1 first and hit a closed IPv6 port.
            const redirect = `http://127.0.0.1:${CALLBACK_PORT}/callback`
            // Land on the sign-up page and let the user choose how to authenticate
            // (Google today, more providers later) rather than forcing Google.
            const authorizeUrl =
              `${webUrl}/register?client=altimate-code` +
              `&redirect=${encodeURIComponent(redirect)}` +
              `&state=${state}`

            await open(authorizeUrl).catch(() => undefined)

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
