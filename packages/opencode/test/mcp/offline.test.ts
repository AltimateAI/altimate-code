// altimate_change - new file
import { expect, test } from "bun:test"
import { Offline } from "../../src/config/offline"

test("offline MCP URL policy accepts only HTTP(S) localhost and loopback", () => {
  for (const url of ["http://localhost:3000/mcp", "https://localhost./mcp", "http://127.2.3.4/mcp", "http://[::1]:3000/mcp"])
    expect(Offline.isLocalURL(url)).toBe(true)
  for (const url of ["https://example.com/mcp", "http://localhost.example.com", "http://192.168.0.1/mcp", "file://localhost/mcp", "http://localhost@evil.test/mcp", "invalid"])
    expect(Offline.isLocalURL(url)).toBe(false)
})

test("offline local MCP fetch rejects remote requests and redirects before remote egress", async () => {
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls++
      return new URL(request.url).pathname === "/redirect"
        ? Response.redirect("https://example.com/mcp")
        : new Response("local MCP")
    },
  })
  try {
    const fetch = Offline.localFetch()
    expect(await (await fetch(server.url)).text()).toBe("local MCP")
    await expect(fetch(new URL("/redirect", server.url))).rejects.toThrow()
    await expect(fetch("https://example.com/mcp")).rejects.toThrow("non-local request")
    expect(calls).toBe(2)
  } finally {
    server.stop(true)
  }
})
