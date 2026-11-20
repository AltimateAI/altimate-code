// altimate_change - new file
//
// What the server's catch-all error handlers send back: never an error's text, stack or file paths, only a fixed
// message and a ref (the error is logged in full under that ref). A remote config that can't be fetched answers 502
// with its name and status. Covers server.ts's handler through the full app, middleware.ts's handler directly, and
// the shared helpers.
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { unlink } from "fs/promises"
import { Hono } from "hono"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Server } from "../../src/server/server"
import { errorHandler } from "../../src/server/middleware"
import { NamedError } from "@opencode-ai/core/util/error"
import { Session } from "../../src/session"
import {
  clientMessage,
  errorRef,
  unknownErrorBody,
  upstreamStatus,
  UNEXPECTED,
} from "../../src/altimate/server/error-response"
import type { Log } from "../../src/util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Stack frames and source paths, as V8, JSC and Bun print them.
const STACKISH = /\n\s+at\s|\.(ts|js):\d+:\d+|node_modules/

function capturingLog() {
  const calls: Array<{ message: string; extra: Record<string, unknown> }> = []
  const log = {
    error: (message: string, extra: Record<string, unknown>) => calls.push({ message, extra }),
    info: () => {},
    warn: () => {},
    debug: () => {},
  } as unknown as Log.Logger
  return { log, calls }
}

describe("clientMessage", () => {
  test("drops stack-frame lines and keeps the rest", () => {
    const err = new Error(
      "failed to load\n    at fetch (/srv/app/src/x.ts:10:5)\n    at <anonymous> (native:7:39)\nat least one model is required",
    )
    expect(clientMessage(err)).toBe("failed to load\nat least one model is required")
  })

  test("drops frames without a source location too", () => {
    const err = new Error(
      "failed\n    at new Promise (<anonymous>)\n    at async Promise.all (index 0)\n    at forEach ([native code])\n    at <anonymous>",
    )
    expect(clientMessage(err)).toBe("failed")
    expect(clientMessage("    at new Promise (<anonymous>)")).toBe(UNEXPECTED)
  })

  test("reads a NamedError's text from data.message, where it keeps it", () => {
    const err = new NamedError.Unknown({ message: "provider refused the key\n    at call (/srv/p.ts:3:4)" })
    expect(err.message).toBe("UnknownError")
    expect(clientMessage(err)).toBe("provider refused the key")
    expect(clientMessage(new NamedError.Unknown({ message: "" }))).toBe(UNEXPECTED)
  })

  test("falls back to the fixed message when nothing is left", () => {
    expect(clientMessage(new Error(""))).toBe(UNEXPECTED)
    expect(clientMessage("    at fn (/a.js:1:2)")).toBe(UNEXPECTED)
  })
})

test("upstreamStatus is 502 only for an unavailable remote config", () => {
  expect(upstreamStatus("ConfigRemoteUnavailableError")).toBe(502)
  expect(upstreamStatus("ConfigRemoteAuthError")).toBeUndefined()
  expect(upstreamStatus("UnknownError")).toBeUndefined()
})

test("unknownErrorBody carries only the fixed message and the ref it is given", () => {
  const ref = errorRef()
  expect(ref).toMatch(/^err_[0-9a-f-]{8}$/)
  expect(unknownErrorBody(ref)).toEqual({ name: "UnknownError", data: { message: UNEXPECTED, ref } })
})

describe("middleware.ts errorHandler", () => {
  function app(thrown: unknown) {
    const { log, calls } = capturingLog()
    const hono = new Hono().onError(errorHandler(log)).get("/boom", () => {
      throw thrown
    })
    return { hono, calls }
  }

  test("an unknown error answers 500 with a fixed message and a ref, never its text or stack", async () => {
    const err = new Error("secret marker")
    const { hono, calls } = app(err)
    const response = await hono.request("/boom")
    const text = await response.text()
    expect(response.status).toBe(500)
    expect(text).not.toContain("secret marker")
    expect(text).not.toMatch(STACKISH)
    const body = JSON.parse(text)
    expect(body).toMatchObject({ name: "UnknownError", data: { message: UNEXPECTED } })
    // One log line, and it names the ref the client got.
    expect(calls).toEqual([{ message: "failed", extra: { ref: body.data.ref, error: err } }])
  })

  test("a busy session answers 400 with its message", async () => {
    const response = await app(new Session.BusyError("ses_busy")).hono.request("/boom")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ name: "UnknownError", data: { message: "Session ses_busy is busy" } })
  })

  test("an unavailable remote config answers 502 with its name, remote, status and reason", async () => {
    const err = new ConfigErrorV1.RemoteUnavailableError({
      remote: "https://config.example.com/.well-known/opencode",
      status: 503,
      reason: "HTTP 503",
    })
    const response = await app(err).hono.request("/boom")
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      name: "ConfigRemoteUnavailableError",
      data: { remote: "https://config.example.com/.well-known/opencode", status: 503, reason: "HTTP 503" },
    })
  })

  test("another core config error answers with its own fields, not a stack", async () => {
    const err = new ConfigErrorV1.RemoteAuthError({ url: "https://example.com", remote: "https://example.com/c.json" })
    const response = await app(err).hono.request("/boom")
    const text = await response.text()
    expect(response.status).toBe(500)
    expect(text).not.toMatch(STACKISH)
    expect(JSON.parse(text)).toEqual({
      name: "ConfigRemoteAuthError",
      data: { url: "https://example.com", remote: "https://example.com/c.json" },
    })
  })
})

describe("full server, remote config unavailable", () => {
  const authPath = () => path.join(Global.Path.data, "auth.json")
  let original: string | undefined
  let servers: Array<{ stop: (force?: boolean) => unknown }> = []

  async function withWellKnown(url: string) {
    original = await Filesystem.readText(authPath()).catch(() => undefined)
    await Filesystem.write(
      authPath(),
      JSON.stringify({ [url]: { type: "wellknown", key: "TEST_TOKEN", token: "test-token" } }),
    )
  }

  afterEach(async () => {
    for (const server of servers) await server.stop(true)
    servers = []
    if (original !== undefined) await Filesystem.write(authPath(), original)
    else await unlink(authPath()).catch(() => undefined)
    original = undefined
    await disposeAllInstances()
  })

  test("GET /agent answers 502 naming the remote and its status when the remote answers 500", async () => {
    const remote = Bun.serve({ port: 0, fetch: () => new Response("upstream exploded", { status: 500 }) })
    servers.push(remote)
    await withWellKnown(remote.url.origin)
    await using dir = await tmpdir({ git: true })
    const response = await Server.Default().request("/agent", { headers: { "x-opencode-directory": dir.path } })
    const text = await response.text()
    expect(response.status).toBe(502)
    expect(text).not.toMatch(STACKISH)
    expect(JSON.parse(text)).toEqual({
      name: "ConfigRemoteUnavailableError",
      data: { remote: `${remote.url.origin}/.well-known/opencode`, status: 500, reason: "HTTP 500" },
    })
  })

  test("an /api route sends no stack either (an empty 500: the instance fails to load before any handler runs)", async () => {
    const remote = Bun.serve({ port: 0, fetch: () => new Response("upstream exploded", { status: 500 }) })
    servers.push(remote)
    await withWellKnown(remote.url.origin)
    await using dir = await tmpdir({ git: true })
    const response = await Server.Default().request("/api/config", { headers: { "x-opencode-directory": dir.path } })
    const text = await response.text()
    expect(response.status).toBe(500)
    expect(text).toBe("")
  })

  test("a failing remote config URL is named by its template, never with the token filled in", async () => {
    const asked: string[] = []
    const remote = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        asked.push(url.pathname + url.search)
        if (url.pathname === "/.well-known/opencode") {
          return Response.json({ remote_config: { url: `${url.origin}/cfg?token={env:TEST_TOKEN}` } })
        }
        return new Response("no", { status: 500 })
      },
    })
    servers.push(remote)
    await withWellKnown(remote.url.origin)
    await using dir = await tmpdir({ git: true })
    const response = await Server.Default().request("/agent", { headers: { "x-opencode-directory": dir.path } })
    const text = await response.text()
    expect(asked).toContain("/cfg?token=test-token")
    expect(response.status).toBe(502)
    expect(text).not.toContain("test-token")
    expect(JSON.parse(text)).toEqual({
      name: "ConfigRemoteUnavailableError",
      data: { remote: `${remote.url.origin}/cfg?token={env:TEST_TOKEN}`, status: 500, reason: "HTTP 500" },
    })
  })

  test("GET /agent answers 502 with the transport reason when the remote refuses the connection", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") })
    const origin = closed.url.origin
    await closed.stop(true)
    await withWellKnown(origin)
    await using dir = await tmpdir({ git: true })
    const response = await Server.Default().request("/agent", { headers: { "x-opencode-directory": dir.path } })
    const text = await response.text()
    expect(response.status).toBe(502)
    expect(text).not.toMatch(STACKISH)
    expect(JSON.parse(text)).toEqual({
      name: "ConfigRemoteUnavailableError",
      data: { remote: `${origin}/.well-known/opencode`, reason: "TransportError" },
    })
  })
})
