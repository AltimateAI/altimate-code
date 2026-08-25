// Recording pass-through proxy for script/e2e-free-tier.sh.
//
// Sits between the CLI and the gateway issuer and appends one JSON line per request to
// PROXY_LOG. It exists for the assertion that is otherwise unobservable from outside the
// process: that an install which has not consented sends the gateway nothing at all.
// Bodies are recorded so the run can also check that only the hash of the install secret
// goes over the wire, never the secret.
//
// Deliberately dumb: no rewriting, no retries, no caching. Anything it changed would be a
// difference between what the test proves and what ships.
const upstream = (process.env["UPSTREAM"] ?? "http://localhost:8080").replace(/\/+$/, "")
const port = Number(process.env["PROXY_PORT"] ?? 47503)
const logPath = process.env["PROXY_LOG"] ?? "/tmp/e2e-free-tier-proxy.jsonl"

const log = Bun.file(logPath).writer()

const server = Bun.serve({
  port,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text()

    // The harness's own readiness probe is not a CLI request; logging it would corrupt the
    // "zero requests before consent" count, and clearing the log afterwards is not an
    // option — the writer keeps its offset and a truncated file comes back with a NUL hole.
    if (url.pathname === "/health") return Response.json({ proxy: "ok", upstream })

    log.write(
      JSON.stringify({
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        body,
      }) + "\n",
    )
    log.flush()

    const headers = new Headers(req.headers)
    headers.delete("host")
    try {
      const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: body || undefined,
      })
      return new Response(response.body, { status: response.status, headers: response.headers })
    } catch (err) {
      // Surfaced as a 502 rather than a hang so the script fails with a readable message.
      return Response.json({ error: "proxy upstream unreachable", upstream, detail: String(err) }, { status: 502 })
    }
  },
})

console.error(`[proxy] :${server.port} -> ${upstream}, logging to ${logPath}`)
await new Promise(() => {})
