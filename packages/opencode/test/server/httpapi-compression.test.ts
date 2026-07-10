import { describe, expect, test } from "bun:test"
import { gunzipSync, inflateSync } from "node:zlib"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { compressionLayer } from "../../src/server/routes/instance/httpapi/middleware/compression"

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        yield* router.add("*", "/config", () => Effect.succeed(HttpServerResponse.jsonUnsafe(fatConfig())))
        yield* router.add("GET", "/event", () => Effect.succeed(sseResponse()))
        yield* router.add("GET", "/global/event", () => Effect.succeed(sseResponse()))
      }),
    ).pipe(Layer.provide([compressionLayer, HttpServer.layerServices])),
    { disableLogger: true },
  )
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init)
      return Promise.resolve(handler.handler(request))
    },
  }
}

// /config echoes the config back. Padding the config pushes the response body
// well past the 1024 B threshold so we can observe compression behavior.
function fatConfig() {
  const instructions: string[] = []
  for (let i = 0; i < 50; i++) {
    instructions.push(`padding-instruction-${i}-${"x".repeat(40)}`)
  }
  return {
    formatter: false,
    lsp: false,
    username: "compression-test-user",
    instructions,
  }
}

function sseResponse() {
  return HttpServerResponse.raw(new TextEncoder().encode(`data: ${"x".repeat(2048)}\n\n`), {
    headers: new Headers({ "content-type": "text/event-stream" }),
  })
}

describe("HttpApi compression", () => {
  describe("encodes responses", () => {
    test("gzips JSON when Accept-Encoding includes gzip and body exceeds threshold", async () => {
      const response = await app().request("/config", {
        headers: { "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("gzip")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = gunzipSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
      expect(compressed.byteLength).toBeLessThan(decompressed.byteLength)
    })

    test("uses deflate when only deflate is acceptable", async () => {
      const response = await app().request("/config", {
        headers: { "accept-encoding": "deflate" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("deflate")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = inflateSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
    })

    test("prefers gzip when both gzip and deflate are acceptable", async () => {
      const response = await app().request("/config", {
        headers: { "accept-encoding": "gzip, deflate" },
      })
      expect(response.headers.get("content-encoding")).toBe("gzip")
    })

    test("does not include the original Content-Length when compressed", async () => {
      const response = await app().request("/config", {
        headers: { "accept-encoding": "gzip" },
      })
      const compressed = new Uint8Array(await response.arrayBuffer())
      const declared = response.headers.get("content-length")
      // Either absent (transfer-encoding chunked) or matches the compressed length.
      if (declared !== null) expect(Number(declared)).toBe(compressed.byteLength)
    })
  })

  describe("skips", () => {
    test("when no Accept-Encoding header is present", async () => {
      const response = await app().request("/config")
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when Accept-Encoding only allows unsupported encodings", async () => {
      const response = await app().request("/config", {
        headers: { "accept-encoding": "br" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when the response body is below the 1024-byte threshold", async () => {
      const handler = HttpRouter.toWebHandler(
        HttpRouter.use((router) =>
          router.add("GET", "/config", () => Effect.succeed(HttpServerResponse.jsonUnsafe({ formatter: false }))),
        ).pipe(Layer.provide([compressionLayer, HttpServer.layerServices])),
        { disableLogger: true },
      )
      const response = await handler.handler(
        new Request("http://localhost/config", { headers: { "accept-encoding": "gzip" } }),
      )
      expect(response.status).toBe(200)
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body.byteLength).toBeLessThan(1024)
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("HEAD requests", async () => {
      const response = await app().request("/config", {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })
  })

  describe("streaming exclusions", () => {
    test("/event SSE is not compressed", async () => {
      const controller = new AbortController()
      const response = await app().request("/event", {
        headers: { "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })

    test("/global/event SSE is not compressed", async () => {
      const controller = new AbortController()
      const response = await app().request("/global/event", {
        headers: { "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })
  })
})
