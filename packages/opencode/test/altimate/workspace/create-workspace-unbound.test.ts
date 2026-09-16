// altimate_change - new file
// Coverage for WorkspaceApi.createWorkspaceUnbound (AI-9171).
//
// This exists because `altimate link`'s "create a quick workspace" row always
// failed on an already-linked project: it went through `createAndBind`, whose
// server handler pre-checks the identifiers and 409s BEFORE creating, so the
// rebind that was supposed to follow never got a target. The fix creates the
// workspace unbound first, then repoints.
//
// The assertions worth having are about the REQUEST, not the response. Two
// creation paths now exist, and the silent failure mode is that they disagree:
// `POST /datamates/` defaults memory and the knowledge engine to false, while
// the create-and-bind path sets both true. If this drifts, the same menu row
// produces a differently-configured workspace depending only on whether the
// project happened to be linked — which nothing else would catch.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const ORIGINAL_TEST_HOME = process.env.OPENCODE_TEST_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-createunbound-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "home", ".altimate"), { recursive: true })
process.env.OPENCODE_TEST_HOME = path.join(SANDBOX, "home")

const API_URL = "https://api.example.test"
const TENANT = "acme"

// A real credentials file, so the module resolves them the same way it does in
// production rather than through a stubbed export.
writeFileSync(
  path.join(SANDBOX, "home", ".altimate", "altimate.json"),
  JSON.stringify({
    altimateUrl: API_URL,
    altimateInstanceName: TENANT,
    altimateApiKey: "test-key",
  }),
)

const { WorkspaceApi } = await import("@/altimate/workspace/api-client")

const ORIGINAL_FETCH = globalThis.fetch

interface Captured {
  url: string
  method: string
  body: Record<string, unknown>
}

let captured: Captured[] = []

/** Stub fetch, recording each request and replying with `reply`. */
function respondWith(status: number, reply: unknown) {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    })
    return new Response(JSON.stringify(reply), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
}

beforeEach(() => {
  captured = []
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

afterAll(() => {
  if (ORIGINAL_TEST_HOME === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = ORIGINAL_TEST_HOME
})

describe("createWorkspaceUnbound", () => {
  test("posts to /datamates/, NOT to the binding router", async () => {
    respondWith(200, { id: 77 })
    await WorkspaceApi.createWorkspaceUnbound({ name: "jaffle_shop" })

    expect(captured).toHaveLength(1)
    expect(captured[0].method).toBe("POST")
    // The whole point: this must not reach create_and_bind, which would 409.
    expect(captured[0].url).not.toContain("datamate-project-bindings")
    expect(captured[0].url).toContain("/datamates/")
  })

  test("sends no project identifier — binding is the caller's next step", async () => {
    respondWith(200, { id: 77 })
    await WorkspaceApi.createWorkspaceUnbound({ name: "jaffle_shop" })

    expect(captured[0].body).not.toHaveProperty("repo_remote")
    expect(captured[0].body).not.toHaveProperty("project_path")
  })

  test("applies the workspace defaults, not the SaaS ones", async () => {
    respondWith(200, { id: 77 })
    await WorkspaceApi.createWorkspaceUnbound({ name: "jaffle_shop" })

    // `POST /datamates/` defaults both to false. Sending them explicitly is what
    // keeps an already-linked project's new workspace configured like every
    // other CLI-created one. Dropping either line is the regression.
    expect(captured[0].body.memory_enabled).toBe(true)
    expect(captured[0].body.knowledge_engine_enabled).toBe(true)
    expect(captured[0].body.privacy).toBe("private")
    // Required by CreateDatamateRequest — omitting it is a 422.
    expect(captured[0].body.integrations).toEqual([])
  })

  test("returns the created id and the caller's name", async () => {
    respondWith(200, { id: 77 })
    const created = await WorkspaceApi.createWorkspaceUnbound({ name: "jaffle_shop" })
    expect(created).toEqual({ id: 77, name: "jaffle_shop" })
  })

  test("passes a description through when given, null when not", async () => {
    respondWith(200, { id: 77 })
    await WorkspaceApi.createWorkspaceUnbound({ name: "a", description: "from the CLI" })
    expect(captured[0].body.description).toBe("from the CLI")

    captured = []
    respondWith(200, { id: 78 })
    await WorkspaceApi.createWorkspaceUnbound({ name: "b" })
    expect(captured[0].body.description).toBeNull()
  })

  test("rejects a response with no usable id rather than returning NaN", async () => {
    // A workspace the caller cannot then rebind to is worse than a clear error:
    // `Number(undefined)` is NaN, which would reach the rebind as a garbage
    // target id.
    respondWith(200, { id: null })
    await expect(WorkspaceApi.createWorkspaceUnbound({ name: "x" })).rejects.toThrow(/no usable id/)
  })

  test("rejects a non-integer id", async () => {
    respondWith(200, { id: "not-a-number" })
    await expect(WorkspaceApi.createWorkspaceUnbound({ name: "x" })).rejects.toThrow(/no usable id/)
  })
})
