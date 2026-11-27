// altimate_change - new file
//
// How the server's Hono error handlers record an error they don't recognise: the full error, stack frames and nested
// causes included, in opencode.log under the ref the response carries; nothing on the console or the standard
// streams (the TUI owns them when it runs the server in-process); and a response even when opencode.log can't be
// written. Also server.ts's unknown-error and busy-session branches through the full server.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { mkdir, rename, rm, unlink } from "fs/promises"
import { Hono } from "hono"
import { Server } from "../../src/server/server"
import { errorHandler } from "../../src/server/middleware"
import { UNEXPECTED } from "../../src/altimate/server/error-response"
import { Log } from "../../src/util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Stack frames and source paths, as V8, JSC and Bun print them.
const STACKISH = /\n\s+at\s|\.(ts|js):\d+:\d+|node_modules/
const logFile = () => path.join(Global.Path.log, "opencode.log")

// Runs `run` with the print-logs flags unset, the default for `serve`.
async function withoutPrintLogs<T>(run: () => Promise<T>) {
  const saved = [process.env["ALTIMATE_PRINT_LOGS"], process.env["OPENCODE_PRINT_LOGS"]] as const
  delete process.env["ALTIMATE_PRINT_LOGS"]
  delete process.env["OPENCODE_PRINT_LOGS"]
  try {
    return await run()
  } finally {
    if (saved[0] === undefined) delete process.env["ALTIMATE_PRINT_LOGS"]
    else process.env["ALTIMATE_PRINT_LOGS"] = saved[0]
    if (saved[1] === undefined) delete process.env["OPENCODE_PRINT_LOGS"]
    else process.env["OPENCODE_PRINT_LOGS"] = saved[1]
  }
}

// Everything printed to the console or the standard streams while `run` runs.
async function printedDuring<T>(run: () => T | Promise<T>) {
  const printed: string[] = []
  const record = (...args: unknown[]) => void printed.push(args.map(String).join(" "))
  const spies = [
    spyOn(console, "log").mockImplementation(record),
    spyOn(console, "error").mockImplementation(record),
    spyOn(console, "warn").mockImplementation(record),
    spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (record(chunk), true)),
    spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (record(chunk), true)),
  ]
  try {
    return { result: await run(), printed: printed.join("\n") }
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

// The opencode.log line recorded under `ref`.
async function loggedUnder(ref: string) {
  const logged = await Bun.file(logFile()).text()
  return logged.split("\n").find((entry) => entry.includes(`ref=${ref}`))
}

function honoApp(thrown: unknown) {
  return new Hono().onError(errorHandler(Log.create({ service: "test" }))).get("/boom", () => {
    throw thrown
  })
}

describe("middleware.ts errorHandler, an unknown error", () => {
  test("is recorded with its stack frames and its nested cause", async () => {
    const err = new Error("outer marker", { cause: new Error("inner marker") })
    const body = await withoutPrintLogs(async () => (await honoApp(err).request("/boom")).json())
    const line = await loggedUnder(body.data.ref)
    expect(line).toContain("outer marker")
    expect(line).toContain("inner marker")
    // A frame of this file, where both errors were made.
    expect(line).toMatch(/at .*altimate-error-handlers\.test\.ts:\d+/)
  })

  test("prints nothing to the console or the standard streams", async () => {
    const { result: body, printed } = await withoutPrintLogs(() =>
      printedDuring(async () => (await honoApp(new Error("quiet marker")).request("/boom")).json()),
    )
    expect(await loggedUnder(body.data.ref)).toContain("quiet marker")
    expect(printed).not.toContain(body.data.ref)
    expect(printed).not.toContain("quiet marker")
  })

  test("still gets its response when opencode.log can't be opened", async () => {
    // A folder where the log file should be: opening it for append fails.
    const saved = `${logFile()}.saved-${process.pid}`
    const existed = await Filesystem.exists(logFile())
    if (existed) await rename(logFile(), saved)
    await mkdir(logFile())
    try {
      const response = await withoutPrintLogs(async () => honoApp(new Error("unlogged marker")).request("/boom"))
      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body).toMatchObject({ name: "UnknownError", data: { message: UNEXPECTED } })
      expect(body.data.ref).toMatch(/^err_[0-9a-f-]{8}$/)
    } finally {
      await rm(logFile(), { recursive: true, force: true })
      if (existed) await rename(saved, logFile())
    }
  })
})

describe("server.ts handler, through the full server", () => {
  const authPath = () => path.join(Global.Path.data, "auth.json")
  let original: string | undefined
  let servers: Array<{ stop: (force?: boolean) => unknown }> = []

  afterEach(async () => {
    for (const server of servers) await server.stop(true)
    servers = []
    if (original !== undefined) await Filesystem.write(authPath(), original)
    else await unlink(authPath()).catch(() => undefined)
    original = undefined
    await disposeAllInstances()
  })

  test("an unknown error answers the fixed message and a ref, and is recorded under it, never printed", async () => {
    // A remote config that answers 200 with a body that isn't JSON: loading the config fails with a plain Error.
    const remote = Bun.serve({
      port: 0,
      fetch: () => new Response("{not json", { headers: { "content-type": "application/json" } }),
    })
    servers.push(remote)
    original = await Filesystem.readText(authPath()).catch(() => undefined)
    await Filesystem.write(
      authPath(),
      JSON.stringify({ [remote.url.origin]: { type: "wellknown", key: "TEST_TOKEN", token: "test-token" } }),
    )
    await using dir = await tmpdir({ git: true })
    const { result: response, printed } = await withoutPrintLogs(() =>
      printedDuring(() => Server.Default().request("/agent", { headers: { "x-opencode-directory": dir.path } })),
    )
    const text = await response.text()
    expect(response.status).toBe(500)
    expect(text).not.toContain("failed to decode")
    expect(text).not.toMatch(STACKISH)
    const body = JSON.parse(text)
    expect(body).toMatchObject({ name: "UnknownError", data: { message: UNEXPECTED } })
    expect(await loggedUnder(body.data.ref)).toContain("failed to decode remote config")
    expect(printed).not.toContain(body.data.ref)
  })

  test("a busy session answers 400 with its message", async () => {
    if (process.platform === "win32") return // the busy window is a POSIX `sleep` in the session's shell
    await using dir = await tmpdir({ git: true })
    const app = Server.Default()
    const headers = { "x-opencode-directory": dir.path, "content-type": "application/json" }
    const session = await (await app.request("/session", { method: "POST", headers, body: "{}" })).json()
    // The session stays busy while its shell runs the command; no model is called for a shell command.
    const shell = Promise.resolve(
      app.request(`/session/${session.id}/shell`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agent: "builder", model: { providerID: "none", modelID: "none" }, command: "sleep 3" }),
      }),
    )
    try {
      // Any message id: the route checks the session first.
      const removeMessage = () =>
        Promise.resolve(
          app.request(`/session/${session.id}/message/msg_00000000000000000000000000`, {
            method: "DELETE",
            headers,
          }),
        )
      let response = await removeMessage()
      for (let attempt = 0; response.status !== 400 && attempt < 40; attempt++) {
        await Bun.sleep(50)
        response = await removeMessage()
      }
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        name: "UnknownError",
        data: { message: `Session ${session.id} is busy` },
      })
    } finally {
      await shell
    }
  }, 30_000)
})
