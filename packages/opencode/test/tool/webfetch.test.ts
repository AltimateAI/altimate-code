import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"

const projectRoot = path.join(import.meta.dir, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

async function withFetch(
  mockFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch as unknown as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe("tool.webfetch", () => {
  test("returns image responses as file attachments", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await withFetch(
      async () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
      async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute({ url: "https://example.com/image.png", format: "markdown" }, ctx)
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          },
        })
      },
    )
  })

  test("keeps svg as text output", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'
    await withFetch(
      async () =>
        new Response(svg, {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute({ url: "https://example.com/image.svg", format: "html" }, ctx)
            expect(result.output).toContain("<svg")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("keeps text responses as text output", async () => {
    await withFetch(
      async () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute({ url: "https://example.com/file.txt", format: "text" }, ctx)
            expect(result.output).toBe("hello from webfetch")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("uses honest UA first, retries with browser UA on 403", async () => {
    const calls: string[] = []
    await withFetch(
      async (_input, init) => {
        const ua = (init?.headers as Record<string, string>)?.["User-Agent"] ?? ""
        calls.push(ua)
        if (ua.includes("altimate-code")) {
          return new Response("Forbidden", { status: 403 })
        }
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
      },
      async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute({ url: "https://example.com/page", format: "text" }, ctx)
            expect(result.output).toBe("ok")
            expect(calls.length).toBe(2)
            expect(calls[0]).toContain("altimate-code")
            expect(calls[1]).toContain("Chrome")
          },
        })
      },
    )
  })

  test("uses honest UA first, retries with browser UA on 406", async () => {
    const calls: string[] = []
    await withFetch(
      async (_input, init) => {
        const ua = (init?.headers as Record<string, string>)?.["User-Agent"] ?? ""
        calls.push(ua)
        if (ua.includes("altimate-code")) {
          return new Response("Not Acceptable", { status: 406 })
        }
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })
      },
      async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute({ url: "https://example.com/page", format: "text" }, ctx)
            expect(result.output).toBe("ok")
            expect(calls.length).toBe(2)
            expect(calls[0]).toContain("altimate-code")
            expect(calls[1]).toContain("Chrome")
          },
        })
      },
    )
  })

  test("does not retry on non-retryable status (500)", async () => {
    const calls: string[] = []
    await withFetch(
      async (_input, init) => {
        const ua = (init?.headers as Record<string, string>)?.["User-Agent"] ?? ""
        calls.push(ua)
        return new Response("Server Error", { status: 500 })
      },
      async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            expect(webfetch.execute({ url: "https://example.com/page", format: "text" }, ctx)).rejects.toThrow(
              "Request failed with status code: 500",
            )
            expect(calls.length).toBe(1)
            expect(calls[0]).toContain("altimate-code")
          },
        })
      },
    )
  })

  test("does not retry when honest UA succeeds", async () => {
    const calls: string[] = []
    await withFetch(
      async (_input, init) => {
        const ua = (init?.headers as Record<string, string>)?.["User-Agent"] ?? ""
        calls.push(ua)
        return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })
      },
      async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute({ url: "https://example.com/page", format: "text" }, ctx)
            expect(result.output).toBe("hello")
            expect(calls.length).toBe(1)
            expect(calls[0]).toContain("altimate-code")
          },
        })
      },
    )
  })

  test("throws when both UAs fail", async () => {
    const calls: string[] = []
    await withFetch(
      async (_input, init) => {
        const ua = (init?.headers as Record<string, string>)?.["User-Agent"] ?? ""
        calls.push(ua)
        return new Response("Forbidden", { status: 403 })
      },
      async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            expect(webfetch.execute({ url: "https://example.com/blocked", format: "text" }, ctx)).rejects.toThrow(
              "Request failed with status code: 403",
            )
            expect(calls.length).toBe(2)
            expect(calls[0]).toContain("altimate-code")
            expect(calls[1]).toContain("Chrome")
          },
        })
      },
    )
  })
})
