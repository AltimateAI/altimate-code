import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createServer } from "http"
import { randomBytes } from "crypto"
import open from "open"
import { AltimateApi } from "../api/client"

// Loopback port the CLI listens on for the browser to deliver the gateway
// credential after Google sign-in. Must match the redirect the web authorize
// page posts back to. 7317 is otherwise unused in this codebase.
const CALLBACK_PORT = 7317

// Web app that hosts the signup/login (authorize) page. Overridable for
// dev/staging via ALTIMATE_WEB_URL.
const DEFAULT_WEB_URL = "https://app.myaltimate.com"
// Fallback gateway API base if the callback omits one.
const DEFAULT_API_URL = "https://api.myaltimate.com"

const HTML_SUCCESS = `<!doctype html><meta charset="utf-8"><title>Altimate Code</title>
<body style="font-family:system-ui;text-align:center;padding:64px">
<h2>Signed in ✓</h2><p>You can return to your terminal.</p>
<script>setTimeout(()=>window.close(),1500)</script></body>`

const HTML_ERROR = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Altimate Code</title>
<body style="font-family:system-ui;text-align:center;padding:64px">
<h2>Connection failed</h2><p>${msg}</p><p>Please return to your terminal and try again.</p></body>`

interface CallbackResult {
  api_url: string
  instance: string
  api_key: string
}

interface Pending {
  state: string
  resolve: (creds: CallbackResult) => void
  reject: (err: Error) => void
}

let server: ReturnType<typeof createServer> | undefined
let pending: Pending | undefined

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

    const error = url.searchParams.get("error")
    if (error) {
      pending?.reject(new Error(error))
      pending = undefined
      html(200, HTML_ERROR(error))
      return
    }

    const state = url.searchParams.get("state")
    // Bind the callback to the unguessable state the CLI generated — rejects a
    // stray/malicious local request that didn't originate from our browser tab.
    if (!pending || !state || state !== pending.state) {
      const msg = "Invalid state — possible CSRF"
      pending?.reject(new Error(msg))
      pending = undefined
      html(400, HTML_ERROR(msg))
      return
    }

    const apiKey = url.searchParams.get("key")
    const instance = url.searchParams.get("instance")
    const apiUrl = url.searchParams.get("url") || DEFAULT_API_URL
    if (!apiKey || !instance) {
      const msg = "Missing credential in callback"
      pending.reject(new Error(msg))
      pending = undefined
      html(400, HTML_ERROR(msg))
      return
    }

    const current = pending
    pending = undefined
    current.resolve({ api_url: apiUrl, instance, api_key: apiKey })
    html(200, HTML_SUCCESS)
  })

  await new Promise<void>((resolve, reject) => {
    server!.listen(CALLBACK_PORT, () => resolve())
    server!.on("error", reject)
  })
}

function stopCallbackServer() {
  if (server) {
    server.close()
    server = undefined
  }
}

function waitForCallback(state: string, timeoutMs = 5 * 60 * 1000): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pending) {
        pending = undefined
        reject(new Error("Timed out waiting for browser sign-in"))
      }
    }, timeoutMs)
    pending = {
      state,
      resolve: (creds) => {
        clearTimeout(timeout)
        resolve(creds)
      },
      reject: (err) => {
        clearTimeout(timeout)
        reject(err)
      },
    }
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
            // Bind the port BEFORE opening the browser so the credential can
            // only be delivered to this process.
            const state = randomBytes(16).toString("hex")
            await startCallbackServer()

            const webUrl = (process.env.ALTIMATE_WEB_URL || DEFAULT_WEB_URL).replace(/\/+$/, "")
            const redirect = `http://localhost:${CALLBACK_PORT}/callback`
            const authorizeUrl =
              `${webUrl}/register?client=altimate-code` +
              `&redirect=${encodeURIComponent(redirect)}` +
              `&state=${state}`

            await open(authorizeUrl).catch(() => undefined)

            return {
              url: authorizeUrl,
              instructions: "Sign in with Google in your browser to connect Altimate LLM Gateway.",
              method: "auto",
              async callback() {
                try {
                  const creds = await waitForCallback(state)
                  // Persist to ~/.altimate/altimate.json — the provider loader
                  // reads this first (it carries the instance/tenant + api_url
                  // the generic auth.json store can't).
                  await AltimateApi.saveCredentials({
                    altimateUrl: creds.api_url,
                    altimateInstanceName: creds.instance,
                    altimateApiKey: creds.api_key,
                  })
                  return { type: "success", key: creds.api_key, provider: "altimate-backend" }
                } catch {
                  return { type: "failed" }
                } finally {
                  stopCallbackServer()
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
