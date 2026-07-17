import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ServerAuth } from "../../../src/server/auth"
import { cspForHtml, upstreamURL } from "../../../src/server/shared/ui"
import { hasPtyConnectTicketURL, isPtyConnectPath } from "../../../src/server/shared/pty-ticket"
import { isPublicUIPath } from "../../../src/server/shared/public-ui"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")
const srcDir = path.join(repoRoot, "packages", "opencode", "src")

async function readSrc(...rel: string[]) {
  return fs.readFile(path.join(srcDir, ...rel), "utf-8")
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

describe("UPI-29 authorization and PTY-ticket boundaries", () => {
  test("ServerAuth.header encodes explicit credentials and defaults explicit-password username to opencode", () => {
    expect(ServerAuth.header({ password: "pw" })).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`)
    expect(ServerAuth.header({ username: "alice", password: "secret" })).toBe(
      `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    )
  })

  test("ServerAuth.header returns undefined when no password is configured", () => {
    const previous = process.env.OPENCODE_SERVER_PASSWORD
    delete process.env.OPENCODE_SERVER_PASSWORD
    try {
      expect(ServerAuth.header()).toBeUndefined()
      expect(ServerAuth.headers()).toBeUndefined()
    } finally {
      if (previous !== undefined) process.env.OPENCODE_SERVER_PASSWORD = previous
    }
  })

  test("PTY connect ticket bypass is path-specific and still requires the ticket query", () => {
    expect(isPtyConnectPath("/pty/abc/connect")).toBe(true)
    expect(isPtyConnectPath("/pty/abc/other")).toBe(false)
    expect(hasPtyConnectTicketURL(new URL("http://localhost/pty/abc/connect?ticket=one"))).toBe(true)
    expect(hasPtyConnectTicketURL(new URL("http://localhost/pty/abc/connect"))).toBe(false)
    expect(hasPtyConnectTicketURL(new URL("http://localhost/session?ticket=one"))).toBe(false)
  })

  test("public UI auth bypass is limited to GET asset paths", () => {
    expect(isPublicUIPath("GET", "/site.webmanifest")).toBe(true)
    expect(isPublicUIPath("GET", "/web-app-manifest-192x192.png")).toBe(true)
    expect(isPublicUIPath("POST", "/site.webmanifest")).toBe(false)
    expect(isPublicUIPath("GET", "/")).toBe(false)
    expect(isPublicUIPath("GET", "/assets/app.js")).toBe(false)
  })

  test("HttpApi authorization uses custom middleware, not security alternatives that can remap NotFound", async () => {
    const source = await readSrc("server", "routes", "instance", "httpapi", "middleware", "authorization.ts")
    const activeSource = stripComments(source)
    expect(activeSource).not.toContain("HttpApiSecurity")
    expect(source).toContain("Avoid HttpApiSecurity alternatives")
    expect(source).toContain("validateCredential(effect, credential, config)")
    expect(source).toContain('HttpApiError.UnauthorizedNoContent')
  })

  test("PTY ticket bypass only appears in the PTY authorization layer", async () => {
    const source = await readSrc("server", "routes", "instance", "httpapi", "middleware", "authorization.ts")
    const ptyBody = source.slice(source.indexOf("export const ptyConnectAuthorizationLayer"))
    const regularBody = source.slice(source.indexOf("export const authorizationLayer"), source.indexOf("export const ptyConnectAuthorizationLayer"))

    expect(ptyBody).toContain("if (hasPtyConnectTicketURL(url)) return yield* effect")
    expect(regularBody).not.toContain("hasPtyConnectTicketURL")
  })
})

describe("UPI-30 and UPI-31 SSE lifecycle and UI proxy branding", () => {
  test("HttpApi SSE subscribes before server.connected, filters instance/workspace, and closes on dispose", async () => {
    const source = await readSrc("server", "routes", "instance", "httpapi", "handlers", "event.ts")
    const listenAt = source.indexOf("const unsubscribe = yield* events.listen")
    const connectedAt = source.indexOf('Stream.make({ id: eventID(), type: "server.connected"')

    expect(listenAt).toBeGreaterThan(-1)
    expect(connectedAt).toBeGreaterThan(-1)
    expect(listenAt).toBeLessThan(connectedAt)
    expect(source).toContain("event.location?.directory === instance.directory")
    expect(source).toContain("event.location.workspaceID === undefined || event.location.workspaceID === workspaceID")
    expect(source).toContain('Stream.takeUntil((event) => event.type === "server.instance.disposed")')
    expect(source).toContain('"Cache-Control": "no-cache, no-transform"')
    expect(source).toContain('"X-Accel-Buffering": "no"')
  })

  test("shared UI proxy targets Altimate host and CSP includes the inline theme preload hash", () => {
    const html = `<html><head><script id="oc-theme-preload-script">window.__theme="dark"</script></head></html>`
    const csp = cspForHtml(html)

    expect(upstreamURL("/assets/app.js")).toBe("https://app.altimate.ai/assets/app.js")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-")
    expect(csp).toContain("connect-src * data:")
  })

  test("shared UI CSP does not hash external scripts or unrelated inline scripts", () => {
    const html = `<html><head><script src="/assets/app.js"></script><script id="other">alert(1)</script></head></html>`
    const csp = cspForHtml(html)
    expect(csp).not.toContain("'sha256-")
    expect(csp).toContain("default-src 'self'")
  })

  test("legacy Hono UI proxy and shared HttpApi UI proxy both use the Altimate host", async () => {
    const legacy = await readSrc("server", "server.ts")
    const shared = await readSrc("server", "shared", "ui.ts")

    expect(legacy).toContain("https://app.altimate.ai")
    expect(legacy).not.toContain("https://app.opencode.ai")
    expect(shared).toContain('export const UI_UPSTREAM = new URL("https://app.altimate.ai")')
    expect(shared).not.toContain("https://app.opencode.ai")
  })
})
