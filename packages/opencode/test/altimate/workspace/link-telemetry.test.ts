import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"

// Set before the modules under test load: AltimateApi reads Global.Path.home at call time,
// but the sandbox must exist before the first credential read.
const ORIGINAL_TEST_HOME = process.env.OPENCODE_TEST_HOME
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), "link-telemetry-"))
process.env.OPENCODE_TEST_HOME = path.join(SANDBOX, "home")
mkdirSync(path.join(SANDBOX, "home", ".altimate"), { recursive: true })
const API_URL = "https://api.example.test"
writeFileSync(
  path.join(SANDBOX, "home", ".altimate", "altimate.json"),
  JSON.stringify({ altimateUrl: API_URL, altimateInstanceName: "acme", altimateApiKey: "test-key" }),
)

const {
  WorkspaceApi,
  linkFailureReason,
  endpointOf,
  altimateRequest,
  WorkspaceApiError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = await import("../../../src/altimate/workspace/api-client")
const { Telemetry } = await import("../../../src/altimate/telemetry")

type Reply = { status: number; body?: unknown } | { throw: Error } | { hang: true }
type Event = import("../../../src/altimate/telemetry").Telemetry.Event

describe("workspace link telemetry", () => {
  const ORIGINAL_FETCH = globalThis.fetch
  let events: Event[]
  let requests: { method: string; url: string; body: unknown }[]
  let replies: Reply[]
  let trackSpy: ReturnType<typeof spyOn>

  const binding = (id: number) => ({
    binding: { id: 1, datamate_id: id, datamate_name: `ws-${id}`, repo_remote: "git@x:y.git", project_path: null },
  })
  const of = (type: string) => events.filter((e) => e.type === type) as any[]

  beforeEach(() => {
    events = []
    requests = []
    replies = []
    trackSpy = spyOn(Telemetry, "track").mockImplementation((e) => {
      events.push(e)
    })
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      const r = replies.shift() ?? { status: 200, body: binding(1) }
      if ("throw" in r) throw r.throw
      if ("hang" in r) {
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        )
      }
      const rr = r as { status: number; body?: unknown }
      return new Response(rr.body === undefined ? "" : JSON.stringify(rr.body), {
        status: rr.status,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch
  })

  afterEach(() => {
    trackSpy.mockRestore()
    globalThis.fetch = ORIGINAL_FETCH
  })

  afterAll(() => {
    if (ORIGINAL_TEST_HOME === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = ORIGINAL_TEST_HOME
    rmSync(SANDBOX, { recursive: true, force: true })
  })

  test("bind to an existing workspace reports workspace_linked on the success response", async () => {
    replies = [{ status: 200, body: binding(42) }]
    await WorkspaceApi.bindExisting(42, { repoRemote: "git@x:y.git" })
    expect(of("workspace_linked")).toEqual([expect.objectContaining({ workspace_id: 42, how: "bind_existing" })])
    expect(of("workspace_link_failed")).toHaveLength(0)
    expect(of("workspace_api_error")).toHaveLength(0)
  })

  test("create-and-bind reports workspace_created then workspace_linked", async () => {
    replies = [
      { status: 200, body: { ...binding(7), datamate: { id: 7, name: "ws-7" }, manage_url: "https://app/ws/7" } },
    ]
    await WorkspaceApi.createAndBind({ name: "ws-7", identifier: { projectPath: "/p" } })
    expect(of("workspace_created")).toEqual([expect.objectContaining({ workspace_id: 7, how: "create_and_bind" })])
    expect(of("workspace_linked")).toEqual([expect.objectContaining({ workspace_id: 7, how: "create_and_bind" })])
    expect(events.findIndex((e) => e.type === "workspace_created")).toBeLessThan(
      events.findIndex((e) => e.type === "workspace_linked"),
    )
  })

  test("an unbound create (the create-then-rebind path) reports workspace_created with how create_unbound", async () => {
    replies = [{ status: 200, body: { id: 13 } }]
    await WorkspaceApi.createWorkspaceUnbound({ name: "ws-13" })
    expect(of("workspace_created")).toEqual([expect.objectContaining({ workspace_id: 13, how: "create_unbound" })])
    expect(of("workspace_linked")).toHaveLength(0) // the rebind that follows reports the link

    events = []
    replies = [{ status: 200, body: { id: "7" } }] // malformed id: refused, and not reported as created
    await expect(WorkspaceApi.createWorkspaceUnbound({ name: "x" })).rejects.toThrow(/no usable id/)
    expect(of("workspace_created")).toHaveLength(0)
    // ...but it is a failed link step: the answer was unusable, which is not a network failure.
    expect(of("workspace_link_failed")).toEqual([expect.objectContaining({ how: "create_unbound", reason: "other" })])

    events = []
    replies = [{ status: 409, body: { detail: { message: "name taken" } } }]
    await expect(WorkspaceApi.createWorkspaceUnbound({ name: "x" })).rejects.toBeInstanceOf(ConflictError)
    expect(of("workspace_link_failed")).toEqual([
      expect.objectContaining({ how: "create_unbound", reason: "conflict" }),
    ])
  })

  test("a rebind reports workspace_switched with both ids, then workspace_linked", async () => {
    replies = [{ status: 200, body: binding(9) }]
    await WorkspaceApi.rebindByRemote({ remote: "git@x:y.git", targetDatamateId: 9, expectedCurrentDatamateId: 4 })
    expect(of("workspace_switched")).toEqual([
      expect.objectContaining({ to_workspace_id: 9, from_workspace_id: 4, how: "rebind_remote" }),
    ])
    expect(of("workspace_linked")).toEqual([expect.objectContaining({ workspace_id: 9, how: "rebind_remote" })])

    events = []
    replies = [{ status: 200, body: binding(11) }]
    await WorkspaceApi.rebindByPath({ projectPath: "/p", targetDatamateId: 11 })
    const sw = of("workspace_switched")[0]
    expect(sw.to_workspace_id).toBe(11)
    expect(sw.how).toBe("rebind_path")
    expect("from_workspace_id" in sw).toBe(false)
  })

  test("unlink reports workspace_unlinked with the id the caller knew", async () => {
    replies = [{ status: 204 }]
    expect(await WorkspaceApi.unbindProject({ repoRemote: "git@x:y.git" }, 42)).toBe(true)
    expect(of("workspace_unlinked")).toEqual([expect.objectContaining({ workspace_id: 42 })])

    events = []
    replies = [{ status: 404, body: { detail: "no binding" } }]
    expect(await WorkspaceApi.unbindProject({ repoRemote: "git@x:y.git" })).toBe(false)
    expect(of("workspace_unlinked")).toHaveLength(0)
    // "Already unlinked" is an answer, not a failed call.
    expect(of("workspace_api_error")).toHaveLength(0)

    events = []
    replies = [{ status: 500, body: { detail: "boom" } }]
    await expect(WorkspaceApi.unbindProject({ repoRemote: "git@x:y.git" })).rejects.toBeInstanceOf(WorkspaceApiError)
    expect(of("workspace_api_error")).toEqual([
      expect.objectContaining({ endpoint: "DELETE /datamate-project-bindings/", status: 500, status_class: "5xx" }),
    ])
  })

  test("failed links report workspace_link_failed with a reason class and the API error", async () => {
    replies = [{ status: 404, body: { detail: "gone" } }]
    await expect(WorkspaceApi.bindExisting(42, { projectPath: "/p" })).rejects.toBeInstanceOf(NotFoundError)
    expect(of("workspace_link_failed")).toEqual([
      expect.objectContaining({ how: "bind_existing", reason: "not_found", workspace_id: 42 }),
    ])
    expect(of("workspace_api_error")).toEqual([
      expect.objectContaining({ endpoint: "POST /datamate-project-bindings/bind", status: 404, workspace_id: 42 }),
    ])
    expect(of("workspace_linked")).toHaveLength(0)

    events = []
    replies = [{ status: 403, body: { detail: "nope" } }]
    await expect(WorkspaceApi.bindExisting(42, { projectPath: "/p" })).rejects.toBeInstanceOf(ForbiddenError)
    expect(of("workspace_link_failed")[0].reason).toBe("auth")
    // A 403 is a refusal, not an expired session.
    expect(of("workspace_auth_expired")).toHaveLength(0)
    expect(of("workspace_api_error")).toEqual([
      expect.objectContaining({ status: 403, status_class: "4xx", workspace_id: 42 }),
    ])

    events = []
    replies = [{ status: 401, body: { detail: "expired" } }]
    await expect(WorkspaceApi.bindExisting(42, { projectPath: "/p" })).rejects.toBeInstanceOf(WorkspaceApiError)
    expect(of("workspace_link_failed")[0].reason).toBe("auth")
    expect(of("workspace_auth_expired")).toEqual([
      expect.objectContaining({ endpoint: "POST /datamate-project-bindings/bind", status: 401, workspace_id: 42 }),
    ])
    expect(of("workspace_api_error")).toHaveLength(0)

    events = []
    replies = [{ status: 409, body: { detail: { message: "already linked", existing_datamate_id: 3 } } }]
    await expect(WorkspaceApi.bindExisting(42, { projectPath: "/p" })).rejects.toBeInstanceOf(ConflictError)
    expect(of("workspace_link_failed")[0].reason).toBe("conflict")

    events = []
    replies = [{ throw: new Error("ECONNREFUSED") }]
    await expect(WorkspaceApi.rebindByPath({ projectPath: "/p", targetDatamateId: 5 })).rejects.toBeInstanceOf(
      WorkspaceApiError,
    )
    expect(of("workspace_link_failed")[0]).toEqual(expect.objectContaining({ how: "rebind_path", reason: "network" }))
    expect(of("workspace_api_error")[0]).toEqual(
      expect.objectContaining({
        endpoint: "PUT /datamate-project-bindings/by-path",
        status_class: "network",
        workspace_id: 5,
      }),
    )

    events = []
    replies = [{ status: 500, body: { detail: "boom" } }]
    await expect(WorkspaceApi.createAndBind({ name: "x", identifier: { projectPath: "/p" } })).rejects.toBeInstanceOf(
      WorkspaceApiError,
    )
    expect(of("workspace_link_failed")[0]).toEqual(expect.objectContaining({ how: "create_and_bind", reason: "other" }))
    expect(of("workspace_api_error")[0].status_class).toBe("5xx")
  })

  test("endpoints are masked of ids and a timeout is its own class", async () => {
    replies = [{ status: 500, body: { detail: "x" } }]
    await expect(WorkspaceApi.getBindingForRemote("git@x:y.git")).rejects.toBeInstanceOf(WorkspaceApiError)
    expect(of("workspace_link_failed")).toHaveLength(0)
    expect(of("workspace_api_error")[0].endpoint).toBe("GET /datamate-project-bindings/by-remote")

    events = []
    replies = [{ hang: true }]
    const r = WorkspaceApi.listDatamates()
    await expect(r).rejects.toThrow(/timed out/)
    expect(of("workspace_api_error")[0]).toEqual(expect.objectContaining({ status_class: "timeout" }))
  }, 40_000)

  test("endpoints mask every dynamic segment, and a bad 2xx body is its own class", async () => {
    expect(endpointOf("GET", "/datamate-project-bindings", "/by-remote")).toBe(
      "GET /datamate-project-bindings/by-remote",
    )
    // The datamates router only lists its root here: any other shape is masked whole.
    expect(endpointOf("GET", "/datamates", "/123/memory/8f2c0a1e-9b7d-4e11-a0c2-5d6e7f8a9b0c")).toBe(
      "GET /datamates/:id/:id/:id",
    )
    expect(endpointOf("POST", "/datamates", "/42/skills/pub_Ab12Cd/attach")).toBe(
      "POST /datamates/:id/:id/:id/:id",
    )
    // A route table, not spelling: ids and file paths are masked whatever they contain, including
    // a public id or a file named after a route word.
    expect(endpointOf("GET", "/skills", "/pub-many")).toBe("GET /skills/:id")
    expect(endpointOf("GET", "/skills", "/status")).toBe("GET /skills/:id")
    expect(endpointOf("PUT", "/skills", "/status/datamates")).toBe("PUT /skills/:id/datamates")
    expect(endpointOf("GET", "/skills", "/pub_x/files/status")).toBe("GET /skills/:id/files/:path")
    expect(endpointOf("GET", "/skills", "/pub_x/files/docs/readme.md")).toBe("GET /skills/:id/files/:path")
    expect(endpointOf("GET", "/skills", "/pub_x/unexpected/route")).toBe("GET /skills/:id/:id/:id")
    expect(endpointOf("PATCH", "/datamates/memory", "/list")).toBe("PATCH /datamates/memory/list")
    expect(endpointOf("PATCH", "/datamates/memory", "/mem_status")).toBe("PATCH /datamates/memory/:id")
    expect(endpointOf("POST", "/datamate-project-bindings", "/bind")).toBe("POST /datamate-project-bindings/bind")
    expect(endpointOf("DELETE", "/datamate-project-bindings", "/")).toBe("DELETE /datamate-project-bindings/")
    // Not a workspace router (whoami reports nothing), so not listed: masked whole.
    expect(endpointOf("GET", "/users", "/me")).toBe("GET /:id/:id")
    expect(endpointOf("GET", "/unknown-router", "/anything/else")).toBe("GET /:id/:id/:id")
    expect(endpointOf("GET", "/datamates", "/42/skills/pub_Ab12Cd/files/readme.md")).toBe(
      "GET /datamates/:id/:id/:id/:id/:id",
    )

    replies = [{ status: 200 }] // 2xx with an empty body where JSON was required
    await expect(WorkspaceApi.listDatamates()).rejects.toThrow(/Empty 200 body/)
    expect(of("workspace_api_error")).toEqual([expect.objectContaining({ status_class: "response", status: 200 })])
  })

  test("a body that stalls after the server answered keeps the answer's status class", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
            )
          },
        }),
        { status: 500 },
      )) as typeof globalThis.fetch
    const stalled: any = await altimateRequest("GET", "/x", { base: "/datamates", timeoutMs: 200 }).catch((e) => e)
    expect(stalled).toBeInstanceOf(WorkspaceApiError)
    expect(stalled.message).toMatch(/timed out/)
    expect(stalled.status).toBe(500) // the answer's status rides on the error
    expect(linkFailureReason(stalled)).toBe("other") // answered: not a network failure
    // A known status whose body failed classifies like a readable answer with that status.
    expect(linkFailureReason(new WorkspaceApiError("stalled", 404))).toBe("not_found")
    expect(linkFailureReason(new WorkspaceApiError("stalled", 403))).toBe("auth")
    expect(linkFailureReason(new WorkspaceApiError("stalled", 409))).toBe("conflict")
    expect(linkFailureReason(new WorkspaceApiError("stalled", 412))).toBe("conflict")
    expect(linkFailureReason(new WorkspaceApiError("cannot reach"))).toBe("network")
    expect(linkFailureReason(new WorkspaceApiError("no usable id", undefined, "response"))).toBe("other")
    expect(of("workspace_api_error")).toEqual([expect.objectContaining({ status_class: "5xx", status: 500 })])

    events = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () =>
              controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
            )
          },
        }),
        { status: 200 },
      )) as typeof globalThis.fetch
    await expect(altimateRequest("GET", "/x", { base: "/datamates", timeoutMs: 200 })).rejects.toThrow(/timed out/)
    expect(of("workspace_api_error")).toEqual([expect.objectContaining({ status_class: "timeout", status: 200 })])
  })

  test("a body that fails after the server answered keeps the answer's status class", async () => {
    // Oversized 500: readBounded() refuses the body before the status branch; the row is still a 5xx.
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response("x", { status: 500, headers: { "content-length": "100000000" } })) as typeof globalThis.fetch
    await expect(altimateRequest("GET", "/x", { base: "/datamates", boundResponse: true })).rejects.toBeInstanceOf(
      WorkspaceApiError,
    )
    expect(of("workspace_api_error")).toEqual([expect.objectContaining({ status_class: "5xx", status: 500 })])

    events = []
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response("x", { status: 200, headers: { "content-length": "100000000" } })) as typeof globalThis.fetch
    await expect(altimateRequest("GET", "/x", { base: "/datamates", boundResponse: true })).rejects.toBeInstanceOf(
      WorkspaceApiError,
    )
    expect(of("workspace_api_error")).toEqual([expect.objectContaining({ status_class: "response", status: 200 })])
  })

  test("a not-linked lookup is an answer: a 404 from either lookup reports no row", async () => {
    replies = [
      { status: 404, body: { detail: "no binding" } },
      { status: 404, body: { detail: "no binding" } },
    ]
    await expect(
      WorkspaceApi.getBindingForProject({ repoRemote: "git@x:y.git", projectPath: "/p" }),
    ).resolves.toBeNull()
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/datamate-project-bindings/by-remote",
      "/datamate-project-bindings/by-path",
    ])
    expect(events).toEqual([])
  })

  test("a declared status reports nothing; any other failure of the same call still does", async () => {
    replies = [{ status: 404, body: { detail: "gone" } }]
    await expect(
      altimateRequest("GET", "/x", { base: "/skills", expectedStatuses: [404] }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(events).toEqual([])

    replies = [{ status: 409, body: { detail: "taken" } }]
    await expect(
      altimateRequest("GET", "/x", { base: "/skills", expectedStatuses: [404] }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(of("workspace_api_error")).toEqual([expect.objectContaining({ status: 409, status_class: "4xx" })])
  })

  test("whoami is not a workspace call: its failures report no row", async () => {
    for (const status of [401, 403, 404, 500]) {
      replies = [{ status, body: { detail: "x" } }]
      await expect(WorkspaceApi.whoami()).rejects.toBeInstanceOf(Error)
    }
    replies = [{ throw: new Error("ECONNREFUSED") }]
    await expect(WorkspaceApi.whoami()).rejects.toBeInstanceOf(WorkspaceApiError)
    expect(events).toEqual([])
  })

  test("the 409 -> rebind fallback reports the failed bind, then the switch (rows as they are today)", async () => {
    // `link` with a failed pre-check: bindExisting answers 409, and the command retries as a rebind on
    // the identifier the conflict names. Pins the rows this sequence emits; the recovered conflict
    // still counts one link_failed (disclosed, follow-up).
    replies = [
      { status: 409, body: { detail: { message: "already linked", project_path: "/p" } } },
      { status: 200, body: binding(42) },
    ]
    await expect(WorkspaceApi.bindExisting(42, { projectPath: "/p" })).rejects.toBeInstanceOf(ConflictError)
    await WorkspaceApi.rebindByPath({ projectPath: "/p", targetDatamateId: 42 })
    expect(events.map((e) => e.type)).toEqual([
      "workspace_api_error",
      "workspace_link_failed",
      "workspace_switched",
      "workspace_linked",
    ])
    expect(of("workspace_api_error")[0]).toEqual(expect.objectContaining({ status: 409, workspace_id: 42 }))
    expect(of("workspace_link_failed")[0]).toEqual(
      expect.objectContaining({ how: "bind_existing", reason: "conflict", workspace_id: 42 }),
    )
    expect(of("workspace_switched")[0]).toEqual(expect.objectContaining({ to_workspace_id: 42, how: "rebind_path" }))
    expect("from_workspace_id" in of("workspace_switched")[0]).toBe(false)
    expect(of("workspace_linked")[0]).toEqual(expect.objectContaining({ workspace_id: 42, how: "rebind_path" }))
  })

  test("linkFailureReason classifies every error the client throws", () => {
    expect(linkFailureReason(new ForbiddenError("f"))).toBe("auth")
    expect(linkFailureReason(new WorkspaceApiError("unauthorized", 401))).toBe("auth")
    expect(linkFailureReason(new NotFoundError("n"))).toBe("not_found")
    expect(linkFailureReason(new ConflictError({ message: "c" }))).toBe("conflict")
    expect(linkFailureReason(new WorkspaceApiError("Cannot reach x: ECONNRESET"))).toBe("network")
    expect(linkFailureReason(new WorkspaceApiError("bad", 500))).toBe("other")
    expect(linkFailureReason(new Error("whatever"))).toBe("other")
  })
})
