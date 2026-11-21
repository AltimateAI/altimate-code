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
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local") })
    Offline.start()
    const local = await (await fetch(server.url)).text()
    const remote = await fetch("https://example.com/").then(() => "sent", (error) => error.message)
    server.stop(true)
    console.log(JSON.stringify({ local, remote, env: [process.env.ALTIMATE_OFFLINE, process.env.HTTPS_PROXY, process.env.NO_PROXY] }))`
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HTTPS_PROXY: "http://proxy.example:3128", NO_PROXY: "corp.example" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect({ code: await proc.exited, stderr }).toMatchObject({ code: 0 })
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
    local: "local",
    remote: "Offline mode allows network requests only to the configured model endpoint.",
    env: ["1", "http://proxy.example:3128", "corp.example,localhost,127.0.0.1,[::1]"],
  })
})

test("model fetch stays below the configured base URL", async () => {
  const fetch = Offline.modelFetch("http://model.test:9000/v1")
  for (const url of ["http://model.test:9000/v2/chat", "http://model.test:9000/v1beta", "https://model.test:9000/v1/chat", "http://other.test:9000/v1/chat"])
    await expect(fetch(url)).rejects.toThrow("Offline mode blocked a request outside the configured model endpoint.")
  expect(() => Offline.modelFetch(undefined)).toThrow("explicit baseURL")
  expect(() => Offline.modelFetch("file:///tmp/model")).toThrow("HTTP(S)")
})
