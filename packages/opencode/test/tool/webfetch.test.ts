import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  fn: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => fn(server.url),
    (server) => Effect.sync(() => server.stop(true)),
  )

const exec = Effect.fn("WebFetchToolTest.exec")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
  // altimate_change start — upstream_fix: redirect rule tests pass the effective ruleset (anomalyco/opencode#59748)
  permissions?: PermissionV1.Ruleset,
  // altimate_change end
) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, permissions ? { ...ctx, permissions } : ctx)
})

// altimate_change start — upstream_fix: redirect rule tests (anomalyco/opencode#59748, anomalyco/opencode#61701)
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return ""
    return String(Cause.squash(exit.cause))
  })
// altimate_change end

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      yield* withFetch(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        (url) =>
          Effect.gen(function* () {
            const result = yield* exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          }),
      )
    }),
  )

  it.instance("keeps svg as text output", () =>
    withFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/image.svg", url).toString(), format: "html" })
          expect(result.output).toContain("<svg")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("keeps text responses as text output", () =>
    withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/file.txt", url).toString(), format: "text" })
          expect(result.output).toBe("hello from webfetch")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    withFetch(
      () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/page.html", url).toString(), format: "text" })
          expect(result.output).toBe("Hello world")
          expect(result.attachments).toBeUndefined()
        }),
    ),
  )

  // altimate_change start — upstream_fix: redirect rule tests (anomalyco/opencode#59748, anomalyco/opencode#61701)
  it.instance("follows redirects to targets the rules allow", () => {
    const requested: string[] = []
    return withFetch(
      (req) => {
        const path = new URL(req.url).pathname
        requested.push(path)
        if (path === "/start") return new Response(null, { status: 302, headers: { location: "/target#frag" } })
        return new Response("arrived", { status: 200, headers: { "content-type": "text/plain" } })
      },
      (url) =>
        Effect.gen(function* () {
          const result = yield* exec({ url: new URL("/start", url).toString(), format: "text" }, [
            { permission: "webfetch", pattern: "*", action: "allow" },
          ])
          expect(result.output).toBe("arrived")
          expect(requested).toEqual(["/start", "/target"])
        }),
    )
  })

  it.instance("stops at a redirect target the rules deny", () => {
    const requested: string[] = []
    return withFetch(
      (req) => {
        const path = new URL(req.url).pathname
        requested.push(path)
        if (path === "/start") return new Response(null, { status: 302, headers: { location: "/secret" } })
        return new Response("secret", { status: 200, headers: { "content-type": "text/plain" } })
      },
      (url) =>
        Effect.gen(function* () {
          const message = yield* failure(
            exec({ url: new URL("/start", url).toString(), format: "text" }, [
              { permission: "webfetch", pattern: "*", action: "allow" },
              { permission: "webfetch", pattern: new URL("/secret", url).toString(), action: "deny" },
            ]),
          )
          expect(message).toContain("prevents you from using this specific tool call")
          expect(requested).toEqual(["/start"])
        }),
    )
  })

  it.instance("rejects redirects to non-HTTP schemes and endless redirect chains", () =>
    withFetch(
      (req) => {
        const path = new URL(req.url).pathname
        if (path === "/file") return new Response(null, { status: 301, headers: { location: "file:///etc/passwd" } })
        return new Response(null, { status: 307, headers: { location: `${path}x` } })
      },
      (url) =>
        Effect.gen(function* () {
          expect(yield* failure(exec({ url: new URL("/file", url).toString(), format: "text" }))).toContain(
            "URL must use http:// or https://",
          )
          expect(yield* failure(exec({ url: new URL("/loop", url).toString(), format: "text" }))).toContain(
            "Too many redirects",
          )
        }),
    ),
  )

  it.instance("rejects credentials in the requested URL and in redirect targets", () => {
    let requests = 0
    return withFetch(
      (req) => {
        requests++
        const target = new URL("/next", req.url)
        target.username = "user"
        return new Response(null, { status: 302, headers: { location: target.toString() } })
      },
      (url) =>
        Effect.gen(function* () {
          const withCredentials = new URL("/start", url)
          withCredentials.username = "user"
          expect(yield* failure(exec({ url: withCredentials.toString(), format: "text" }))).toContain(
            "URL must not include credentials",
          )
          expect(requests).toBe(0)
          expect(yield* failure(exec({ url: new URL("/start", url).toString(), format: "text" }))).toContain(
            "URL must not include credentials",
          )
          expect(requests).toBe(1)
        }),
    )
  })
  // altimate_change end
})
