// altimate_change - new file
// Control-flow coverage for the "create a quick workspace" row, on
// BOTH surfaces that offer it.
//
// The bug was never in a request shape — it was in which request got sent.
// `createAndBind` 409s before creating anything when the project is already
// linked, so the rebind that was meant to follow was unreachable and the row
// always failed. A test that only checks payloads cannot see that, which is why
// these assert the *sequence of endpoints* instead.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
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

// A create opens the new workspace's manage URL in the browser. Stubbed before
// the modules under test load, so a local run does not open real tabs; recorded,
// so the tests still prove the open happens. Returns a subprocess-like emitter,
// as `oauth-browser.test.ts` does: `mock.module` is process-wide in Bun, and the
// MCP OAuth path attaches `error`/`exit` handlers to whatever `open` resolves to.
const opened: string[] = []
mock.module("open", () => ({
  default: async (url: string) => {
    opened.push(url)
    return new EventEmitter()
  },
}))

const { createThenBindOrRebind } = await import("@/cli/cmd/link")
const { createAndBindInline, bindOrRebindInline, runWorkspaceManage } = await import(
  "@/plugin/tui/altimate/workspace"
)
const { recordApprovedBinding, readLocalBinding } = await import("@/altimate/workspace/state")
const { flushPendingSyncs } = await import("@/altimate/workspace/skill-sync")
const { hiddenBindingMessage, QUICK_WORKSPACE_PRIVATE_NOTE, WorkspaceApi } = await import(
  "@/altimate/workspace/api-client"
)

const ORIGINAL_FETCH = globalThis.fetch

interface Call {
  method: string
  path: string
  body: Record<string, unknown>
  tenant?: string
}
let calls: Call[] = []
let routes: Array<{ match: RegExp; method?: string; status: number; body: unknown }> = []
/** Runs when a request matches, before its answer: lets a test act while a request is in flight. */
let onRequest: ((call: Call) => void) | undefined

function stubFetch() {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = String(init?.method ?? "GET")
    const call: Call = {
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : {},
      tenant: new Headers(init?.headers).get("x-tenant") ?? undefined,
    }
    calls.push(call)
    onRequest?.(call)
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
 * `recordApprovedBinding` kicks off — this is about which create ran.
 *
 * Lookups (GET) are ignored too. `bun test` runs every file in one process, so a
 * background sync still in flight from an earlier file can land its binding
 * lookup (`GET /datamate-project-bindings/by-path`) in this file's stub, which
 * failed this at random on CI. Every request these tests assert is a write. */
const sequence = () =>
  calls
    .filter((c) => c.path.includes("/datamates") || c.path.includes("/datamate-project-bindings"))
    .filter((c) => c.method !== "GET")
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
  onRequest = undefined
  opened.length = 0
  stubFetch()
})
afterEach(async () => {
  // The TUI create leaves its skill sync detached so the dialog can close at once. Settled here,
  // against this file's stub, so it cannot run on into the next test.
  // Bounded well inside the test timeout: a sync that never settles is the guard's to name, not a
  // 30s stall here.
  await flushPendingSyncs(5_000)
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
    expect(opened).toEqual(["https://x.test/w/7"])
    expect(process.exitCode ?? 0).toBe(0)
  })

  test("a background lookup landing mid-flow does not change which create ran", async () => {
    routes = [
      {
        match: /datamate-project-bindings\/$/,
        method: "POST",
        status: 200,
        body: { datamate: { id: 7, name: "proj" }, binding: BINDING, manage_url: "https://x.test/w/7" },
      },
    ]
    // What CI hit: a sync from another file resolving its binding through this stub.
    await fetch(`${API_URL}/datamate-project-bindings/by-path?project_path=%2Felsewhere`)
    await createThenBindOrRebind(IDENTIFIER, "proj", "/tmp/proj", null)

    expect(sequence()).toEqual(["POST /datamate-project-bindings/"])
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

  test("with no readable credential it creates nothing", async () => {
    const ws = WorkspaceApi as unknown as Record<string, (...a: any[]) => Promise<unknown>>
    const original = ws.captureCredentials
    ws.captureCredentials = async () => null
    try {
      await createThenBindOrRebind(IDENTIFIER, "proj", "/tmp/proj", EXISTING)
    } finally {
      ws.captureCredentials = original
    }
    expect(sequence()).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  test("the unbound create and its rebind both run as the credential the flow captured", async () => {
    routes = [
      { match: /\/datamates\/$/, method: "POST", status: 200, body: { id: 7 } },
      { match: /by-remote/, method: "PUT", status: 200, body: { binding: BINDING } },
    ]
    const api = WorkspaceApi as unknown as Record<string, (...a: any[]) => Promise<unknown>>
    const original = { create: api.createWorkspaceUnbound, rebind: api.rebindByRemote }
    const ranAs: string[] = []
    api.createWorkspaceUnbound = (input: { actAs?: { instance: string } }) => {
      ranAs.push(`create:${input.actAs?.instance}`)
      return original.create(input)
    }
    api.rebindByRemote = (input: { actAs?: { instance: string } }) => {
      ranAs.push(`rebind:${input.actAs?.instance}`)
      return original.rebind(input)
    }
    try {
      await createThenBindOrRebind(IDENTIFIER, "proj", "/tmp/proj", EXISTING)
    } finally {
      api.createWorkspaceUnbound = original.create
      api.rebindByRemote = original.rebind
    }
    expect(ranAs).toEqual(["create:acme", "rebind:acme"])
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

  test("the unbound create and its rebind both run as the credential the flow captured", async () => {
    routes = [
      { match: /\/datamates\/$/, method: "POST", status: 200, body: { id: 7 } },
      { match: /by-remote/, method: "PUT", status: 200, body: { binding: BINDING } },
    ]
    const ws = WorkspaceApi as unknown as Record<string, (...a: any[]) => Promise<unknown>>
    const original = { create: ws.createWorkspaceUnbound, rebind: ws.rebindByRemote }
    const ranAs: string[] = []
    ws.createWorkspaceUnbound = (input: { actAs?: { instance: string } }) => {
      ranAs.push(`create:${input.actAs?.instance}`)
      return original.create(input)
    }
    ws.rebindByRemote = (input: { actAs?: { instance: string } }) => {
      ranAs.push(`rebind:${input.actAs?.instance}`)
      return original.rebind(input)
    }
    const { api } = stubApi()
    try {
      await createAndBindInline(api, IDENTIFIER, "proj", { expectedCurrentDatamateId: 3, matchedBy: "remote" })
    } finally {
      ws.createWorkspaceUnbound = original.create
      ws.rebindByRemote = original.rebind
    }
    expect(ranAs).toEqual(["create:acme", "rebind:acme"])
  })

  test("with no readable credential it creates nothing", async () => {
    const ws = WorkspaceApi as unknown as Record<string, (...a: any[]) => Promise<unknown>>
    const original = ws.captureCredentials
    ws.captureCredentials = async () => null
    const { api, toasts } = stubApi()
    try {
      await createAndBindInline(api, IDENTIFIER, "proj", { expectedCurrentDatamateId: 3, matchedBy: "remote" })
    } finally {
      ws.captureCredentials = original
    }
    expect(sequence()).toEqual([])
    expect(toasts.some((t) => t.variant === "error" && /nothing was created/.test(t.message))).toBe(true)
  })

  test("a create whose account is switched mid-request is not recorded under the next account", async () => {
    routes = [
      {
        match: /datamate-project-bindings\/$/,
        method: "POST",
        status: 200,
        body: { datamate: { id: 7, name: "proj" }, binding: BINDING, manage_url: "https://x.test/w/7" },
      },
    ]
    const credentials = path.join(SANDBOX, "home", ".altimate", "altimate.json")
    const acme = { altimateUrl: API_URL, altimateInstanceName: "acme", altimateApiKey: "test-key" }
    onRequest = (call) => {
      if (call.method === "POST" && call.path === "/datamate-project-bindings/")
        writeFileSync(credentials, JSON.stringify({ ...acme, altimateInstanceName: "other", altimateApiKey: "other-key" }))
    }
    const { api, toasts } = stubApi()
    try {
      await createAndBindInline(api, IDENTIFIER, "proj")
      // Workspace 7 belongs to "acme": the account signed in now must not find it as its link.
      expect(await readLocalBinding("/tmp/proj")).toBeNull()
      // And the confirmation says the link stands but nothing was synced, instead of the usual one.
      expect(toasts.some((t) => t.variant === "warning" && /account changed during the link/.test(t.message))).toBe(true)
    } finally {
      writeFileSync(credentials, JSON.stringify(acme))
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// A name-withheld 409 (a teammate's private workspace) must render the
// "workspace you can't see" guidance in the TUI, not the false race message.
// ─────────────────────────────────────────────────────────────────────────────
describe("TUI: hidden-binding conflict toast", () => {
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

  test("a 409 with the workspace name withheld toasts the private-workspace guidance, not a race", async () => {
    routes = [
      {
        match: /datamate-project-bindings/,
        method: "POST",
        status: 409,
        body: { detail: { message: "already linked", existing_datamate_id: 7 } }, // no existing_datamate_name
      },
    ]
    const { api, toasts } = stubApi()
    // existing=undefined → bindExisting → 409 (name withheld) → hidden-binding toast.
    await bindOrRebindInline(api, IDENTIFIER, 5, undefined)
    expect(toasts.some((t) => t.message === hiddenBindingMessage({ message: "already linked", existing_datamate_id: 7 }))).toBe(true)
    expect(toasts.some((t) => /claimed this project while you were choosing/i.test(t.message))).toBe(false)
  })

  test("the quick-create row says the same thing — it used to point at a picker with nothing in it", async () => {
    routes = [
      {
        match: /datamate-project-bindings/,
        method: "POST",
        status: 409,
        body: { detail: { message: "already linked", existing_datamate_id: 7 } }, // no existing_datamate_name
      },
    ]
    const { api, toasts } = stubApi()
    // No `rebindFrom`: the project looks unlinked to this user, because the binding that
    // owns it belongs to a workspace they cannot see. This is Bob, a minute after cloning.
    await createAndBindInline(api, IDENTIFIER, "proj")
    expect(toasts.some((t) => t.message === hiddenBindingMessage({ message: "already linked", existing_datamate_id: 7 }))).toBe(true)
    // The advice that sent him round the loop: a picker scoped to workspaces he can see
    // lists none of them, so "use the palette to change" had nothing to offer.
    expect(toasts.some((t) => /Link this project to a workspace/.test(t.message))).toBe(false)
  })

  test("names the hidden workspace and the account signed in now, so a second sign-in is diagnosable", async () => {
    // The exact body the service returns when the remote is bound to a private workspace the
    // caller does not own: the id is sent, the name and path are withheld.
    routes = [
      {
        match: /datamate-project-bindings/,
        method: "POST",
        status: 409,
        body: {
          detail: {
            message: "This project is already linked to a different workspace",
            existing_datamate_id: 38,
            existing_datamate_name: null,
            repo_remote: "https://github.com/acme/proj",
            project_path: null,
          },
        },
      },
      { match: /^\/users\/me$/, method: "GET", status: 200, body: { id: 1, email: "serviceuser@example.com" } },
    ]
    const { api, toasts } = stubApi()
    await bindOrRebindInline(api, IDENTIFIER, 29, undefined)
    const toast = toasts.find((t) => /already linked/.test(t.message))
    expect(toast?.message).toBe(
      hiddenBindingMessage(
        { message: "x", existing_datamate_id: 38 },
        { email: "serviceuser@example.com", instance: "acme" },
      ),
    )
    expect(toast?.message).toContain('(workspace id 38) that serviceuser@example.com on instance "acme" can\'t see')
  })

  const HIDDEN_409 = {
    match: /datamate-project-bindings/,
    method: "POST",
    status: 409,
    body: {
      detail: {
        message: "This project is already linked to a different workspace",
        existing_datamate_id: 38,
        existing_datamate_name: null,
        repo_remote: "https://github.com/acme/proj",
        project_path: null,
      },
    },
  }
  const CREDENTIALS = path.join(SANDBOX, "home", ".altimate", "altimate.json")
  const ACME = { altimateUrl: API_URL, altimateInstanceName: "acme", altimateApiKey: "test-key" }
  /** Signs in as another account while the bind is in flight, and back afterwards. */
  const switchAccountDuringBind = () => {
    onRequest = (call) => {
      if (call.method === "POST" && call.path.includes("/bind"))
        writeFileSync(CREDENTIALS, JSON.stringify({ ...ACME, altimateInstanceName: "other", altimateApiKey: "other-key" }))
    }
  }

  for (const listed of [true, false]) {
    test(`names the account the bind ran as, not one signed in since (${listed ? "listed" : "ambient"} credential)`, async () => {
      routes = [
        HIDDEN_409,
        { match: /^\/users\/me$/, method: "GET", status: 200, body: { id: 1, email: "serviceuser@example.com" } },
      ]
      switchAccountDuringBind()
      const { api, toasts } = stubApi()
      try {
        const listedAs = listed ? { url: API_URL, instance: "acme", apiKey: "test-key" } : undefined
        await bindOrRebindInline(api, IDENTIFIER, 29, undefined, listedAs)
      } finally {
        writeFileSync(CREDENTIALS, JSON.stringify(ACME))
      }
      expect(calls.filter((c) => c.path === "/users/me").map((c) => c.tenant)).toEqual(["acme"])
      expect(toasts.find((t) => /already linked/.test(t.message))?.message).toContain(
        'that serviceuser@example.com on instance "acme" can\'t see',
      )
    })
  }

  test("when the account answer has no email, the message still names the workspace", async () => {
    routes = [HIDDEN_409, { match: /^\/users\/me$/, method: "GET", status: 200, body: { id: 1 } }]
    const { api, toasts } = stubApi()
    await bindOrRebindInline(api, IDENTIFIER, 29, undefined)
    expect(toasts.find((t) => /already linked/.test(t.message))?.message).toBe(
      hiddenBindingMessage({ message: "x", existing_datamate_id: 38 }),
    )
  })

  test("when the account lookup fails, the message still names the workspace", async () => {
    routes = [HIDDEN_409, { match: /^\/users\/me$/, method: "GET", status: 500, body: { detail: "boom" } }]
    const { api, toasts } = stubApi()
    await bindOrRebindInline(api, IDENTIFIER, 29, undefined)
    expect(toasts.find((t) => /already linked/.test(t.message))?.message).toBe(
      hiddenBindingMessage({ message: "x", existing_datamate_id: 38 }),
    )
  })

  test("a NAMED 409 is still a real race, and still names the workspace", async () => {
    routes = [
      {
        match: /datamate-project-bindings/,
        method: "POST",
        status: 409,
        body: { detail: { message: "already linked", existing_datamate_id: 7, existing_datamate_name: "team-ws" } },
      },
    ]
    const { api, toasts } = stubApi()
    await createAndBindInline(api, IDENTIFIER, "proj")
    expect(toasts.some((t) => /already linked to "team-ws"/.test(t.message))).toBe(true)
    expect(toasts.some((t) => t.message === hiddenBindingMessage({ message: "already linked", existing_datamate_id: 7 }))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The other half of the dead end: the person who CREATED the workspace is the
// only one who can open it up, and nothing on this surface told them so.
// ─────────────────────────────────────────────────────────────────────────────
describe("TUI: quick-create privacy note", () => {
  /** Renders the confirmation dialog instead of discarding it, so the title it
   * actually shows can be read back. */
  const dialogApi = () => {
    const cap: { title: string | null } = { title: null }
    const toasts: Array<{ variant?: string; message: string }> = []
    return {
      cap,
      toasts,
      api: {
        state: { path: { directory: "/tmp/proj" } },
        ui: {
          DialogSelect: (props: { title: string }) => {
            cap.title = props.title
            return null
          },
          dialog: { clear: () => {}, replace: (fn: () => unknown) => void fn() },
          toast: (t: { variant?: string; message: string }) => toasts.push(t),
        },
      } as never,
    }
  }

  test("a create tells the creator the workspace is private and how to share it", async () => {
    routes = [
      {
        match: /datamate-project-bindings\/$/,
        method: "POST",
        status: 200,
        body: { datamate: { id: 7, name: "proj" }, binding: BINDING, manage_url: "https://x.test/w/7" },
      },
    ]
    const d = dialogApi()
    await createAndBindInline(d.api, IDENTIFIER, "proj")
    expect(d.cap.title).toContain(QUICK_WORKSPACE_PRIVATE_NOTE)
  })

  test("binding to an EXISTING workspace does not, because its privacy was never this flow's to describe", async () => {
    routes = [{ match: /\/bind$/, method: "POST", status: 200, body: { binding: BINDING } }]
    const d = dialogApi()
    await bindOrRebindInline(d.api, IDENTIFIER, 7, undefined)
    expect(d.cap.title).toBeTruthy()
    expect(d.cap.title).not.toContain(QUICK_WORKSPACE_PRIVATE_NOTE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The `/workspace` menu is not a dead end — it offers Open in browser /
// Switch workspace / Unlink when linked, and "Link to a workspace" when not.
// ─────────────────────────────────────────────────────────────────────────────
describe("TUI: /workspace menu options", () => {
  const menuApi = () => {
    const cap: { options: Array<{ title: string; value: string }>; current?: string } = { options: [] }
    return {
      cap,
      api: {
        state: { path: { directory: "/tmp/proj" } },
        ui: {
          // The menu is rendered as <api.ui.DialogSelect options={…}/>; capture the props.
          DialogSelect: (props: { options: Array<{ title: string; value: string }>; current?: string }) => {
            cap.options = props.options
            cap.current = props.current
            return null
          },
          dialog: { clear: () => {}, replace: (fn: () => unknown) => void fn() },
          toast: () => {},
        },
      } as never,
    }
  }

  test("linked project: menu offers Open in browser, Switch workspace and Unlink", async () => {
    routes = [
      {
        match: /by-(remote|path)/,
        status: 200,
        body: { datamate: { id: 7, name: "proj", memory_enabled: true }, binding: BINDING },
      },
    ]
    await recordApprovedBinding("/tmp/proj", {
      datamateId: 7,
      datamateName: "proj",
      repoRemote: BINDING.repo_remote,
      projectPath: null,
      linkedAt: Date.now(),
    }, { awaitBackfill: true })
    const m = menuApi()
    await runWorkspaceManage(m.api, "/tmp/proj")
    const values = m.cap.options.map((o) => o.value)
    // Unconditional additions: Switch workspace + Unlink alongside refresh/sync.
    expect(values).toEqual(expect.arrayContaining(["refresh", "sync", "link", "unlink", "done"]))
    expect(m.cap.options.find((o) => o.value === "link")?.title).toBe("Switch workspace")
    // "Open in browser" is gated on a resolvable web URL (deployment-dependent); when present
    // it must carry the right label. The fake host here yields none, so it's correctly absent.
    const open = m.cap.options.find((o) => o.value === "open")
    if (open) expect(open.title).toBe("Open in browser")
  })

  test("unlinked project: menu offers 'Link to a workspace', not a dead end", async () => {
    routes = [{ match: /by-(remote|path)/, status: 404, body: { detail: "not linked" } }]
    const m = menuApi()
    await runWorkspaceManage(m.api, "/tmp/proj-unlinked")
    const values = m.cap.options.map((o) => o.value)
    expect(values).toContain("link")
    expect(m.cap.options.find((o) => o.value === "link")?.title).toBe("Link to a workspace")
    expect(values).not.toContain("unlink")
  })
})

describe("CLI: hidden-binding conflict", () => {
  test("create-and-bind names the hidden workspace and the account it ran as, not one signed in since", async () => {
    const credentials = path.join(SANDBOX, "home", ".altimate", "altimate.json")
    const acme = { altimateUrl: API_URL, altimateInstanceName: "acme", altimateApiKey: "test-key" }
    onRequest = (call) => {
      if (call.method === "POST" && call.path === "/datamate-project-bindings/")
        writeFileSync(credentials, JSON.stringify({ ...acme, altimateInstanceName: "other", altimateApiKey: "other-key" }))
    }
    routes = [
      {
        match: /datamate-project-bindings\/$/,
        method: "POST",
        status: 409,
        body: { detail: { message: "already linked", existing_datamate_id: 38, existing_datamate_name: null } },
      },
      { match: /^\/users\/me$/, method: "GET", status: 200, body: { id: 1, email: "serviceuser@example.com" } },
    ]
    const written: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await createThenBindOrRebind(IDENTIFIER, "proj", "/tmp/proj", null)
    } finally {
      process.stdout.write = write
      writeFileSync(credentials, JSON.stringify(acme))
    }
    expect(calls.filter((c) => c.path === "/users/me").map((c) => c.tenant)).toEqual(["acme"])
    const out = written.join("")
    expect(out).toContain('(workspace id 38) that serviceuser@example.com on instance "acme" can\'t see')
    expect(out).toContain("Nothing was created.")
    expect(process.exitCode).toBe(1)
  })
})
