import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Fiber } from "effect"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { resetDatabase } from "./db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const originalDisableFilewatcher = process.env["OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER"]

beforeEach(() => {
  process.env["OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER"] = "1"
})

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  if (originalDisableFilewatcher === undefined) delete process.env["OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER"]
  else process.env["OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER"] = originalDisableFilewatcher
  await Instance.disposeAll().catch(() => undefined)
  await disposeAllInstances()
  await resetDatabase()
})

function app() {
  return Server.Default()
}

async function currentProjectID(directory: string) {
  const response = await app().request("/project/current", {
    headers: { "x-opencode-directory": directory },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

function waitGlobalDisposed() {
  return waitGlobalBusEvent({
    message: "timed out waiting for global disposal",
    predicate: (event) => event.payload.type === "global.disposed",
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const preserveGlobalConfig = Effect.gen(function* () {
  const file = path.join(Global.Path.config, "altimate-code.json")
  const exists = yield* Effect.promise(() => Bun.file(file).exists())
  const before = exists ? yield* Effect.promise(() => Bun.file(file).text()) : undefined
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (before === undefined) await fs.rm(file, { force: true }).catch(() => undefined)
      else await Bun.write(file, before)
      await Config.invalidate().catch(() => undefined)
    }),
  )
})

describe("Hono HttpApi bridge", () => {
  it.live(
    "legacy project config update disposes the active instance",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          Server.Default().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "legacy-hono-local", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "legacy-hono-local",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
    }),
  )

  it.live(
    "legacy global config update disposes running instances and emits global disposed",
    Effect.gen(function* () {
      yield* preserveGlobalConfig
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const headers = { "x-opencode-directory": tmp.path }
      const username = `legacy-global-${path.basename(tmp.path)}`

      const warm = yield* Effect.promise(() => Promise.resolve(Server.Default().request("/path", { headers })))
      expect(warm.status).toBe(200)

      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const globalDisposed = yield* waitGlobalDisposed().pipe(Effect.forkScoped({ startImmediately: true }))
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          Server.Default().request("/global/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ username })
      yield* Fiber.join(disposed)
      yield* Fiber.join(globalDisposed)
    }),
  )

  test("serves TUI-used non-/api project, copy, control-plane, and sync routes", async () => {
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path }
    const projectID = await currentProjectID(tmp.path)
    const location = `location%5Bdirectory%5D=${encodeURIComponent(tmp.path)}`

    const directories = await app().request(`/project/${projectID}/directories`, { headers })
    expect(directories.status).toBe(200)
    expect(await directories.json()).toEqual([{ directory: tmp.path }])

    const generated = await app().request(`/experimental/project/${projectID}/copy/generate-name`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(generated.status).toBe(200)
    expect(await generated.json()).toMatchObject({ name: expect.any(String) })

    const create = await app().request(`/experimental/project/${projectID}/copy?${location}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(create.status).toBe(400)

    const remove = await app().request(`/experimental/project/${projectID}/copy?${location}`, {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(remove.status).toBe(400)

    const refresh = await app().request(`/experimental/project/${projectID}/copy/refresh?${location}`, {
      method: "POST",
      headers,
    })
    expect(refresh.status).toBe(204)

    const move = await app().request("/experimental/control-plane/move-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(move.status).toBe(400)

    const sync = await app().request("/sync/steal", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(sync.status).toBe(400)
  })

  test("legacy Hono question routes reject malformed question ids", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const headers = { "x-opencode-directory": tmp.path, "content-type": "application/json" }

    const reply = await app().request("/question/invalid-question-id/reply", {
      method: "POST",
      headers,
      body: JSON.stringify({ answers: [["Yes"]] }),
    })
    const reject = await app().request("/question/invalid-question-id/reject", {
      method: "POST",
      headers,
    })

    expect(reply.status).toBe(400)
    expect(reject.status).toBe(400)
  })
})
