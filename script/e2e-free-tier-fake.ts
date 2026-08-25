// Dry-run stand-ins for the gateway issuer, its inference route, and Langfuse, used by
// script/e2e-free-tier.sh --dry-run.
//
// These emulate the WIRE SHAPES documented in altimate-gateway/README.md so the script's
// assertions are exercised for real without Docker, Vertex, or spend. They are not a
// model of the gateway's behaviour: no budgets, no velocity limits, no policy hook. A
// green dry run means the harness works and the client holds up its end — it says nothing
// about whether the gateway enforces anything, which is what the live run is for.
//
// Faithfully reproduced, because the script asserts on them:
//   - principal derivation shape  free-<32 hex>, derived from the install hash
//   - session namespacing         free:<principal>:<client session id>
//   - tags                        tier:free, policy:<version>
//   - typed redaction             AKIA… -> [REDACTED:aws_access_key], at logging time
//     (so the model still sees the original text, as on the real stack)
import { createHmac } from "node:crypto"

const issuerPort = Number(process.argv[2] ?? 47501)
const langfusePort = Number(process.argv[3] ?? 47502)
const POLICY_VERSION = "dry-run-1"

// Deliberate breakage, so the harness can be shown to have teeth. A dry run that always
// passes proves the fake works, not that the checks would catch a regression — run each of
// these once after changing an assertion and confirm it goes red.
//   redaction  secrets reach the trace unmasked
//   session    the client session id is dropped (the X-Session-Id regression)
//   base_url   the issuer hands back a plaintext non-local URL
//   output_redaction_probe  the model never echoes the secret, so the output-side check
//                           has nothing to judge and must report INCONCLUSIVE, not PASS
const BREAK = process.env["FAKE_BREAK"] ?? ""

type Trace = {
  id: string
  userId: string
  sessionId: string
  tags: string[]
  input: unknown
  output: unknown
}

const traces: Trace[] = []
const principals = new Map<string, string>()

function principalFor(installHash: string): string {
  const existing = principals.get(installHash)
  if (existing) return existing
  const id = "free-" + createHmac("sha256", "dry-run-secret").update(installHash).digest("hex").slice(0, 32)
  principals.set(installHash, id)
  return id
}

const keys = new Map<string, string>()

/** The typed masking the real stack applies in its logging hook. Only the patterns the
 *  script probes for — this is a stand-in, not a reimplementation of redaction.py. */
function redact(text: string): string {
  if (BREAK === "redaction") return text
  return text
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws_access_key]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED:jwt]")
}

const issuer = Bun.serve({
  port: issuerPort,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", kill_switch: false, policy_version: POLICY_VERSION })
    }

    if (url.pathname === "/register" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { install_secret_hash?: string; cli_version?: string }
      const hash = body.install_secret_hash ?? ""
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        return Response.json({ code: "invalid_request", detail: "install_secret_hash" }, { status: 400 })
      }
      const principal = principalFor(hash)
      const apiKey = `sk-dry-${principal.slice(5, 13)}-${keys.size + 1}`
      keys.set(apiKey, principal)
      console.error(`[fake-issuer] register hash=${hash.slice(0, 12)}… principal=${principal} key=${apiKey}`)
      return Response.json({
        api_key: apiKey,
        base_url: BREAK === "base_url" ? "http://gateway.internal:4000" : `http://localhost:${issuerPort}`,
        model: "gemini-flash-free",
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      })
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const apiKey = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
      const principal = keys.get(apiKey)
      if (!principal) {
        return Response.json({ error: { type: "auth_error", message: "Invalid key" } }, { status: 401 })
      }
      const body = (await req.json().catch(() => ({}))) as {
        model?: string
        messages?: { role: string; content: unknown }[]
      }
      const clientSession = req.headers.get("x-session-id") ?? ""
      console.error(
        `[fake-inference] principal=${principal} model=${body.model} x-session-id=${clientSession || "MISSING"}`,
      )

      const prompt = (body.messages ?? [])
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n")

      const lastLine = prompt.trim().split("\n").pop() ?? ""
      const echoed = BREAK === "output_redaction_probe" ? "pong" : `${lastLine} pong`

      // Recorded AFTER the "provider call", exactly like the real logging hook: the model
      // saw the original text, the trace stores the masked copy.
      traces.unshift({
        id: crypto.randomUUID(),
        userId: principal,
        // An unqualified client value would let one install write into another's trace,
        // hence the namespace.
        sessionId: BREAK === "session" ? `free:${principal}:` : `free:${principal}:${clientSession}`,
        tags: [
          "tier:free",
          `policy:${POLICY_VERSION}`,
          "cli:dry-run",
          ...(/AKIA[0-9A-Z]{16}/.test(prompt) && BREAK !== "redaction" ? ["redacted:aws_access_key"] : []),
        ],
        input: redact(prompt),
        // Echoes the prompt back so the dry run exercises output masking too, matching what
        // the live model is asked to do.
        output: redact(echoed),
      })

      const chunks = [
        { choices: [{ delta: { role: "assistant", content: echoed }, index: 0 }] },
        { choices: [{ delta: {}, index: 0, finish_reason: "stop" }] },
      ]
      const sse =
        chunks
          .map(
            (c) =>
              `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: body.model, ...c })}\n\n`,
          )
          .join("") + "data: [DONE]\n\n"
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } })
    }

    return Response.json({ error: "not found", path: url.pathname }, { status: 404 })
  },
})

const langfuse = Bun.serve({
  port: langfusePort,
  idleTimeout: 120,
  fetch(req) {
    const url = new URL(req.url)
    // Basic auth is required so the script's credential handling is exercised, but any
    // credential is accepted — this is a stand-in, not an auth test.
    if (!req.headers.get("authorization")?.startsWith("Basic ")) {
      return Response.json({ message: "unauthorized" }, { status: 401 })
    }
    if (url.pathname === "/api/public/traces") {
      const limit = Number(url.searchParams.get("limit") ?? 50)
      return Response.json({ data: traces.slice(0, limit), meta: { totalItems: traces.length } })
    }
    return Response.json({ message: "not found" }, { status: 404 })
  },
})

console.error(`[fake] issuer+inference :${issuer.port}, langfuse :${langfuse.port}`)
await new Promise(() => {})
