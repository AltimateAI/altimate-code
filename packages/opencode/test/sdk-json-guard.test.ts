import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"
import { createClient as createV2Client } from "../../sdk/js/src/v2/gen/client/client.gen"
import { createClient as createV1Client } from "../../sdk/js/src/gen/client/client.gen"
import { createOpencodeClient } from "../../sdk/js/src/v2/client"
import { errorData } from "../src/util/error"

// The JSON-parse guard lives in GENERATED code that `script/build.ts` wipes
// (clean: true) and re-applies on every release build. These tests pin the
// chain end to end: the needle still matches the generator TEMPLATE on disk
// (the real drift detector), both copies carry the guard, build.ts carries
// the re-apply step, and live-server tests drive the actual failure shapes
// against BOTH clients (v1 is the root `@opencode-ai/sdk` export plugins use).

const sdk = fileURLToPath(new URL("../../sdk/js/", import.meta.url))
const read = (rel: string) => Bun.file(path.join(sdk, rel)).text()

describe("sdk json guard — codegen drift", () => {
  it("the needle still matches @hey-api/client-fetch's template on disk", async () => {
    // build.ts throws mid-release if this stops matching; catching it here
    // moves the failure to CI (resolved through the sdk package root: the
    // generator exports only ".", "./internal" and "./package.json")
    const root = path.dirname(require.resolve("@hey-api/openapi-ts/package.json", { paths: [sdk] }))
    const tpl = await Bun.file(path.join(root, "dist/clients/fetch/client.ts")).text()
    // exactly one site: build.ts patches the first string match only, and
    // asserts the count — a second site in a future template must fail here
    expect(tpl.split("          data = text ? JSON.parse(text) : {};").length - 1).toBe(1)
  })

  it("build.ts pins the needle literal and re-applies the guard", async () => {
    const build = await read("script/build.ts")
    expect(build).toContain('const jsonGuardNeedle = "          data = text ? JSON.parse(text) : {};"')
    expect(build).toContain("post-codegen patch expects exactly one site")
    expect(build).toContain("but the body was not JSON")
  })

  it("both generated clients carry the guard", async () => {
    for (const rel of ["src/gen/client/client.gen.ts", "src/v2/gen/client/client.gen.ts"]) {
      const src = await read(rel)
      expect(src).toContain("guard JSON parse against non-JSON")
      expect(src).toContain("but the body was not JSON")
    }
  })
})

describe("sdk json guard — live failure shapes", () => {
  let server: ReturnType<typeof Bun.serve>
  let base: string
  const html = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>"

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname
        if (p.endsWith("/lying-proxy"))
          return new Response(html, { status: 200, headers: { "content-type": "application/json" } })
        if (p.endsWith("/echo-page"))
          // an Express-style page echoes the request target, query included
          return new Response(`<!DOCTYPE html><html><body><pre>Cannot GET ${new URL(req.url).pathname}${new URL(req.url).search}</pre></body></html>`, {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        if (p.endsWith("/echo-title"))
          // a CDN/proxy page that renders the request target in its <title>
          return new Response(`<!DOCTYPE html><html><head><title>Page not found at ${new URL(req.url).pathname}${new URL(req.url).search}</title></head><body>404</body></html>`, {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        if (p.endsWith("/echo-title-encoded"))
          return new Response(`<!DOCTYPE html><html><head><title>Not found: ${encodeURIComponent(new URL(req.url).pathname + new URL(req.url).search)}</title></head><body>404</body></html>`, {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        if (p.endsWith("/truncated-json"))
          return new Response('{"token":"SENTINEL_SECRET_VALUE","more":', {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        if (p.endsWith("/plain-text"))
          return new Response("just text", { status: 200, headers: { "content-type": "text/plain" } })
        if (p.endsWith("/empty-chunked")) {
          // a 200 with an empty streamed body and no Content-Length reaches
          // the json switch arm (the 204 / Content-Length:0 early return
          // does not cover it)
          const body = new ReadableStream({ start(c) { c.close() } })
          return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
        }
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
      },
    })
    base = `http://localhost:${server.port}`
  })
  afterAll(() => server.stop(true))

  for (const [name, make] of [["v2", createV2Client], ["v1", createV1Client]] as const) {
    it(`${name}: HTML mislabeled as application/json rejects with a traceable, query-free error`, async () => {
      const client = make({ baseUrl: base })
      const err = await client
        .get({ url: "/lying-proxy", query: { directory: "/Users/jdoe/secret-project" } })
        .then(() => null)
        .catch((e: unknown) => e as Error & { cause?: { body?: string } })
      expect(err).not.toBeNull()
      expect(err!.message).toContain("but the body was not JSON")
      expect(err!.message).toContain("GET /lying-proxy")
      expect(err!.message).not.toContain("directory=")
      expect(err!.message).not.toContain("secret-project")
      expect(err!.message).toContain("content-type application/json")
      expect(err!.cause?.body).toContain("502 Bad Gateway")
      // the markup case keeps its diagnostic through the repo's error serializer
      expect(JSON.stringify(errorData(err))).toContain("502 Bad Gateway")
    })

    it(`${name}: a page that echoes the request URL contributes nothing but its title`, async () => {
      const client = make({ baseUrl: base })
      const err = await client
        .get({ url: "/echo-page", query: { directory: "/Users/jdoe/secret-project" } })
        .then(() => null)
        .catch((e: unknown) => e as Error & { cause?: { body?: string } })
      expect(err).not.toBeNull()
      expect(err!.message).toContain("but the body was not JSON")
      expect(err!.cause?.body).toBeUndefined()
      expect(JSON.stringify(errorData(err))).not.toContain("secret-project")
      expect(JSON.stringify(errorData(err))).not.toContain("directory=")
    })

    it(`${name}: a <title> that echoes the request target is dropped, raw or percent-encoded`, async () => {
      const client = make({ baseUrl: base })
      for (const url of ["/echo-title", "/echo-title-encoded"]) {
        const err = await client
          .get({ url, query: { directory: "/Users/jdoe/secret-project" } })
          .then(() => null)
          .catch((e: unknown) => e as Error & { cause?: { body?: string } })
        expect(err).not.toBeNull()
        expect(err!.cause?.body).toBeUndefined()
        expect(JSON.stringify(errorData(err))).not.toContain("secret-project")
        expect(JSON.stringify(errorData(err))).not.toContain("directory")
      }
    })

    it(`${name}: a malformed REAL JSON body never reaches serialized error data`, async () => {
      const client = make({ baseUrl: base })
      const err = await client
        .get({ url: "/truncated-json" })
        .then(() => null)
        .catch((e: unknown) => e as Error & { cause?: { body?: string } })
      expect(err).not.toBeNull()
      expect(err!.message).toContain("but the body was not JSON")
      expect(err!.cause?.body).toBeUndefined()
      // util/error.ts serializes `cause` into structured logs and stderr
      expect(JSON.stringify(errorData(err))).not.toContain("SENTINEL_SECRET_VALUE")
      expect(JSON.stringify(err!.cause)).not.toContain("SENTINEL_SECRET_VALUE")
    })
  }

  it("v1: parseAs text still dispatches through the split switch", async () => {
    const client = createV1Client({ baseUrl: base })
    const res = await client.get({ url: "/plain-text", parseAs: "text" })
    expect(res.data).toBe("just text")
  })

  it("v1: a chunked empty 200 yields {} (declared alignment with v2; was SyntaxError)", async () => {
    const client = createV1Client({ baseUrl: base })
    const res = await client.get({ url: "/empty-chunked" })
    expect(res.data).toEqual({})
  })

  it("honestly-labeled text/html (with charset) rejects at the v2 interceptor", async () => {
    const oc = createOpencodeClient({ baseUrl: base })
    const err = await oc.app
      .log({ service: "t", level: "info", message: "x" })
      .then(() => null)
      .catch((e: unknown) => e as Error)
    expect(err).not.toBeNull()
    expect(String(err)).toContain("text/html")
  })
})
