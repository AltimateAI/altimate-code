// altimate_change - new file
// Control-flow coverage for the "create a quick workspace" row, on
// BOTH surfaces that offer it.
//
// The bug was never in a request shape — it was in which request got sent.
// `createAndBind` 409s before creating anything when the project is already
// linked, so the rebind that was meant to follow was unreachable and the row
// always failed. A test that only checks payloads cannot see that, which is why
// these assert the *sequence of endpoints* instead.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const ORIGINAL_TEST_HOME = process.env.OPENCODE_TEST_HOME
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME
const SANDBOX = path.join(os.tmpdir(), `altimate-createflow-${process.pid}-${Date.now()}`)
mkdirSync(path.join(SANDBOX, "home", ".altimate"), { recursive: true })
mkdirSync(path.join(SANDBOX, "state"), { recursive: true })
// Set before the modules under test are imported: they resolve `Global.Path`
// at import time, so this cannot move into `beforeEach`. Restored in
// `afterAll`, and the sandbox is per-pid so parallel files cannot collide.
process.env.OPENCODE_TEST_HOME = path.join(SANDBOX, "home")
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state")

const API_URL = "https://api.example.test"
writeFileSync(
  path.join(SANDBOX, "home", ".altimate", "altimate.json"),
  JSON.stringify({ altimateUrl: API_URL, altimateInstanceName: "acme", altimateApiKey: "test-key" }),
)

const { createThenBindOrRebind } = await import("@/cli/cmd/link")
const { createAndBindInline } = await import("@/plugin/tui/altimate/workspace")

const ORIGINAL_FETCH = globalThis.fetch

interface Call {
  method: string
  path: string
  body: Record<string, unknown>
}
let calls: Call[] = []
let routes: Array<{ match: RegExp; method?: string; status: number; body: unknown }> = []

function stubFetch() {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = String(init?.method ?? "GET")
    calls.push({
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    })
    const route = routes.find(
      (r) => r.match.test(url.pathname) && (r.method === undefined || r.method === method),
    )
    const { status, body } = route ?? { status: 200, body: {} }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
}

/** Endpoint sequence, ignoring the best-effort memory/skill traffic that
 * `recordApprovedBinding` kicks off — this is about which create ran. */
const sequence = () =>
  calls
    .filter((c) => c.path.includes("/datamates") || c.path.includes("/datamate-project-bindings"))
    .map((c) => `${c.method} ${c.path}`)

const BINDING = {
  id: 1,
  datamate_id: 7,
  datamate_name: "proj",
  repo_remote: "https://github.com/acme/proj",
  project_path: null,
}

const IDENTIFIER = { repoRemote: "https://github.com/acme/proj", projectPath: "/tmp/proj" }
const EXISTING = {
  datamate: { id: 3, name: "old-workspace" },
  matchedBy: "remote" as const,
  binding: { ...BINDING, id: 9, datamate_id: 3, datamate_name: "old-workspace" },
}

beforeEach(() => {
  calls = []
  routes = []
  stubFetch()
})
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  process.exitCode = 0 // Bun ignores `= undefined`; a leaked 1 fails later files
})
afterAll(() => {
  if (ORIGINAL_TEST_HOME === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = ORIGINAL_TEST_HOME
  if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME
})

describe("CLI: createThenBindOrRebind", () => {
  test("unlinked project uses the atomic create-and-bind, and never rebinds", async () => {
    routes = [
      {
        match: /datamate-project-bindings\/$/,
        method: "POST",
        status: 200,
        body: { datamate: { id: 7, name: "proj" }, binding: BINDING, manage_url: "https://x.test/w/7" },
      },
    ]
    await createThenBindOrRebind(IDENTIFIER, "proj", "/tmp/proj", null)

    expect(sequence()).toEqual(["POST /datamate-project-bindings/"])
    expect(process.exitCode ?? 0).toBe(0)
  })

  test("already-linked project creates UNBOUND, then rebinds", async () => {
    routes = [
      { match: /\/datamates\/$/, method: "POST", status: 200, body: { id: 7 } },
      { match: /by-remote/, method: "PUT", status: 200, body: { binding: BINDING } },
    ]
    await createThenBindOrRebind(IDENTIFIER, "proj", "/tmp/proj", EXISTING)

    // The whole fix: /datamates/ (no identifiers) first, then the rebind.
    // Before this fix it was a single POST to the bindings router that 409'd.
    expect(sequence()).toEqual(["POST /datamates/", "PUT /datamate-project-bindings/by-remote"])
    const create = calls.find((c) => c.path.endsWith("/datamates/"))!
    expect(create.body).not.toHaveProperty("repo_remote")
    expect(create.body).not.toHaveProperty("project_path")
    expect(create.body.memory_enabled).toBe(true)
    expect(create.body.knowledge_engine_enabled).toBe(true)
    expect(process.exitCode ?? 0).toBe(0)
  })

  test("a failed rebind reports the orphan rather than claiming success", async () => {
    routes = [
      { match: /\/datamates\/$/, method: "POST", status: 200, body: { id: 7 } },
      { match: /by-remote/, method: "PUT", status: 500, body: { detail: "boom" } },
    ]
    await createThenBindOrRebind(IDENTIFIER, "proj", "/tmp/proj", EXISTING)

    // Created, not linked: the caller must exit non-zero so a script does not
    // treat this as a successful link.
    expect(sequence()).toEqual(["POST /datamates/", "PUT /datamate-project-bindings/by-remote"])
    expect(process.exitCode).toBe(1)
  })

  test("a 409 on the unbound create does not run the rebind", async () => {
    routes = [{ match: /\/datamates\/$/, method: "POST", status: 409, body: { detail: "nope" } }]
    await createThenBindOrRebind(IDENTIFIER, "proj", "/tmp/proj", EXISTING)

    expect(sequence()).toEqual(["POST /datamates/"])
    expect(process.exitCode).toBe(1)
  })
})

describe("TUI: createAndBindInline", () => {
  const stubApi = () => {
    const toasts: Array<{ variant?: string; message: string }> = []
    return {
      toasts,
      api: {
        state: { path: { directory: "/tmp/proj" } },
        ui: {
          toast: (t: { variant?: string; message: string }) => toasts.push(t),
          dialog: { clear: () => {}, replace: () => {} },
        },
      } as never,
    }
  }

  test("already-linked project creates UNBOUND, then rebinds", async () => {
    routes = [
      { match: /\/datamates\/$/, method: "POST", status: 200, body: { id: 7 } },
      { match: /by-remote/, method: "PUT", status: 200, body: { binding: BINDING } },
    ]
    const { api } = stubApi()
    await createAndBindInline(api, IDENTIFIER, "proj", {
      expectedCurrentDatamateId: 3,
      matchedBy: "remote",
    })

    // The Major issue on PR #1314: this surface kept calling the atomic
    // create-and-bind, which 409s first, so the rebind below it never ran.
    expect(sequence()).toEqual(["POST /datamates/", "PUT /datamate-project-bindings/by-remote"])
  })

  test("unlinked project still uses the atomic create-and-bind", async () => {
    routes = [
      {
        match: /datamate-project-bindings\/$/,
        method: "POST",
        status: 200,
        body: { datamate: { id: 7, name: "proj" }, binding: BINDING, manage_url: "https://x.test/w/7" },
      },
    ]
    const { api } = stubApi()
    await createAndBindInline(api, IDENTIFIER, "proj")

    expect(sequence()).toEqual(["POST /datamate-project-bindings/"])
  })

  test("a failed rebind toasts the orphan instead of reporting success", async () => {
    routes = [
      { match: /\/datamates\/$/, method: "POST", status: 200, body: { id: 7 } },
      { match: /by-remote/, method: "PUT", status: 500, body: { detail: "boom" } },
    ]
    const { api, toasts } = stubApi()
    await createAndBindInline(api, IDENTIFIER, "proj", {
      expectedCurrentDatamateId: 3,
      matchedBy: "remote",
    })

    expect(toasts.some((t) => t.variant === "error" && /CREATED but could not be linked/.test(t.message))).toBe(true)
  })
})
