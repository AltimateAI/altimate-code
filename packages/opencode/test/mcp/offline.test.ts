// altimate_change - new file
import { expect, test } from "bun:test"
import path from "node:path"
import { Offline } from "../../src/config/offline"

test("loopback checks accept only literal local addresses", () => {
  for (const url of ["http://localhost:3000/mcp", "https://127.0.0.1/mcp", "http://[::1]:3000/mcp"])
    expect(Offline.isLocalURL(url)).toBe(true)
  for (const url of ["https://example.com/mcp", "http://localhost.example.com", "http://192.168.0.1/mcp", "file://localhost/mcp", "http://localhost@evil.test/mcp", "invalid"])
    expect(Offline.isLocalURL(url)).toBe(false)
  for (const host of ["localhost", "127.4.5.6", "::1", "[::1]"]) expect(Offline.isLoopbackHost(host)).toBe(true)
  for (const host of ["localhost.evil.test", "10.0.0.1", "0.0.0.0", "", undefined]) expect(Offline.isLoopbackHost(host)).toBe(false)
})

// start() replaces the process-wide fetch, so it runs in its own process.
test("the fetch guard allows loopback, refuses everything else and keeps the user's proxy settings", async () => {
  const module = path.resolve(import.meta.dir, "../../src/config/offline.ts")
  const script = `
    const { Offline } = await import(${JSON.stringify(module)})
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === "/local-redirect") return Response.redirect(new URL("/", request.url).href, 307)
      if (path === "/remote-redirect") return Response.redirect("https://example.com/", 302)
      if (path === "/see-other") return Response.redirect(new URL("/method", request.url).href, 303)
      if (path === "/method") return new Response(request.method)
      return new Response("local")
    } })
    Offline.start()
    const local = await (await fetch(server.url)).text()
    const followed = await (await fetch(new URL("/local-redirect", server.url))).text()
    const away = await fetch(new URL("/remote-redirect", server.url)).then(() => "sent", (error) => error.message)
    const seeOther = await (await fetch(new URL("/see-other", server.url), { method: "POST", body: "x" })).text()
    const manual = (await fetch(new Request(new URL("/local-redirect", server.url), { redirect: "manual" }))).status
    const remote = await fetch("https://example.com/").then(() => "sent", (error) => error.message)
    server.stop(true)
    console.log(JSON.stringify({ local, followed, away, seeOther, manual, remote, env: [process.env.ALTIMATE_OFFLINE, process.env.HTTPS_PROXY, process.env.NO_PROXY] }))`
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HTTPS_PROXY: "http://proxy.example:3128", NO_PROXY: "corp.example" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect({ code: await proc.exited, stderr }).toMatchObject({ code: 0 })
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
    local: "local",
    followed: "local",
    away: "Offline mode blocked a redirect away from this machine.",
    seeOther: "GET",
    manual: 307,
    remote: "Offline mode allows network requests only to the configured model endpoint.",
    env: ["1", "http://proxy.example:3128", "corp.example,localhost,127.0.0.1,[::1],0.0.0.0"],
  })
})

test("ALTIMATE_OFFLINE accepts the usual off spellings", () => {
  const previous = process.env.ALTIMATE_OFFLINE
  try {
    for (const value of ["", "0", "false", "off", "NO", " Off "]) {
      process.env.ALTIMATE_OFFLINE = value
      expect(Offline.enabled()).toBe(false)
    }
    for (const value of ["1", "true", "yes", "on"]) {
      process.env.ALTIMATE_OFFLINE = value
      expect(Offline.enabled()).toBe(true)
    }
  } finally {
    if (previous === undefined) delete process.env.ALTIMATE_OFFLINE
    else process.env.ALTIMATE_OFFLINE = previous
  }
})

test("model fetch stays below the configured base URL", async () => {
  const fetch = Offline.modelFetch("http://model.test:9000/v1")
  for (const url of ["http://model.test:9000/v2/chat", "http://model.test:9000/v1beta", "https://model.test:9000/v1/chat", "http://other.test:9000/v1/chat"])
    await expect(fetch(url)).rejects.toThrow("Offline mode blocked a request outside the configured model endpoint.")
  expect(() => Offline.modelFetch(undefined)).toThrow("explicit baseURL")
  expect(() => Offline.modelFetch("file:///tmp/model")).toThrow("HTTP(S)")
})
