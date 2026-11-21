// altimate_change - new file
import { expect, test } from "bun:test"
import { Offline } from "../../src/config/offline"

test("offline MCP URL policy accepts only HTTP(S) localhost and loopback", () => {
  for (const url of ["http://localhost:3000/mcp", "https://localhost./mcp", "http://127.2.3.4/mcp", "http://[::1]:3000/mcp", "http://0.0.0.0:4096", "http://[::]:4096"])
    expect(Offline.isLocalURL(url)).toBe(true)
  for (const url of ["https://example.com/mcp", "http://localhost.example.com", "http://192.168.0.1/mcp", "file://localhost/mcp", "http://localhost@evil.test/mcp", "invalid"])
    expect(Offline.isLocalURL(url)).toBe(false)
})

test("offline local MCP fetch rejects remote requests and redirects before remote egress", async () => {
  // Bun applies HTTP(S)_PROXY to loopback too unless NO_PROXY covers it; keep an ambient proxy out of this test.
  const proxyKeys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]
  const savedProxy = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]))
  for (const key of proxyKeys) delete process.env[key]
  process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost"
  let calls = 0
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        calls++
        return new URL(request.url).pathname === "/redirect"
          ? Response.redirect("https://example.com/mcp")
          : new Response("local MCP")
      },
    })
    const fetch = Offline.localFetch()
    expect(await (await fetch(server.url)).text()).toBe("local MCP")
    await expect(fetch(new URL("/redirect", server.url))).rejects.toThrow()
    await expect(fetch("https://example.com/mcp")).rejects.toThrow("non-local request")
    expect(calls).toBe(2)
  } finally {
    server?.stop(true)
    for (const key of proxyKeys) {
      if (savedProxy[key] === undefined) delete process.env[key]
      else process.env[key] = savedProxy[key]
    }
  }
})

test("user programs get their own proxy exclusions back, not the offline bypass", () => {
  const keys = ["NO_PROXY", "no_proxy", "ALTIMATE_OFFLINE_USER_PROXY"]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    // What Offline.start leaves behind: the bypass, plus the user's original values.
    process.env.ALTIMATE_OFFLINE_USER_PROXY = JSON.stringify({ NO_PROXY: "corp.example" })
    process.env.NO_PROXY = process.env.no_proxy = "*"
    const env: Record<string, string | undefined> = Offline.userEnv({ ...process.env, PATH: "/bin" })
    expect(env.NO_PROXY).toBe("corp.example")
    expect(env.no_proxy).toBeUndefined()
    expect(env.ALTIMATE_OFFLINE_USER_PROXY).toBeUndefined()
    expect(env.PATH).toBe("/bin")
    // A copied env that lacks the key (Bun omits variables assigned after startup) still gets the saved value.
    const copy: Record<string, string | undefined> = { PATH: "/bin" }
    expect(Offline.userEnv(copy).NO_PROXY).toBe("corp.example")
    // A value the program's own configuration set is kept.
    expect(Offline.userEnv({ ...process.env, NO_PROXY: "mcp.local" }).NO_PROXY).toBe("mcp.local")
    // Without offline state, the environment is unchanged.
    delete process.env.ALTIMATE_OFFLINE_USER_PROXY
    expect(Offline.userEnv({ NO_PROXY: "*" }).NO_PROXY).toBe("*")
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
