import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { createClient } from "../../sdk/js/src/v2/gen/client/client.gen"
import { createOpencodeClient } from "../../sdk/js/src/v2/client"

// The JSON-parse guard lives in GENERATED code that `script/build.ts` wipes
// (clean: true) and re-applies on every release build. These tests pin both
// halves: the drift canaries fail if either copy of the patch disappears, and
// the live-server tests exercise the actual failure shapes (a proxy serving
// an HTML error page as application/json, and one labeling it honestly).

describe("sdk json guard — drift canaries", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url).pathname).text()

  it("both generated clients carry the guard", async () => {
    for (const p of [
      "../../sdk/js/src/gen/client/client.gen.ts",
      "../../sdk/js/src/v2/gen/client/client.gen.ts",
    ]) {
      const src = await read(p)
      expect(src).toContain("guard JSON parse against non-JSON")
      expect(src).toContain("but the body was not JSON")
    }
  })

  it("build.ts re-applies the v2 guard after codegen with a matching needle", async () => {
    const build = await read("../../sdk/js/script/build.ts")
    expect(build).toContain("json-guard patch did not apply")
    expect(build).toContain('const jsonGuardNeedle = "          data = text ? JSON.parse(text) : {};"')
    expect(build).toContain("but the body was not JSON")
  })
})

describe("sdk json guard — live failure shapes", () => {
  let server: ReturnType<typeof Bun.serve>
  let base: string
  const html = "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>"

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path.endsWith("/lying-proxy"))
          return new Response(html, { status: 200, headers: { "content-type": "application/json" } })
        // every other route: an honest proxy error page with charset
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
      },
    })
    base = `http://localhost:${server.port}`
  })
  afterAll(() => server.stop(true))

  it("HTML mislabeled as application/json rejects with an actionable error", async () => {
    const client = createClient({ baseUrl: base })
    const err = await client
      .get({ url: "/lying-proxy" })
      .then(() => null)
      .catch((e: unknown) => e as Error & { cause?: { body?: string } })
    expect(err).not.toBeNull()
    expect(err!.message).toContain("but the body was not JSON")
    expect(err!.message).toContain("/lying-proxy")
    expect(err!.message).toContain("content-type application/json")
    expect(err!.cause?.body).toContain("502 Bad Gateway")
  })

  it("honestly-labeled text/html (with charset) rejects at the interceptor", async () => {
    const oc = createOpencodeClient({ baseUrl: base })
    const err = await oc.app
      .log({ service: "t", level: "info", message: "x" })
      .then(() => null)
      .catch((e: unknown) => e as Error)
    expect(err).not.toBeNull()
    expect(String(err)).toContain("text/html")
  })
})
