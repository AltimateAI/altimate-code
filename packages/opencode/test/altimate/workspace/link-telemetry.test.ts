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

const { WorkspaceApi, linkFailureReason, WorkspaceApiError, NotFoundError, ForbiddenError, ConflictError } =
  await import("../../../src/altimate/workspace/api-client")
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
    expect(of("workspace_api_error")).toEqual([
      expect.objectContaining({ endpoint: "DELETE /datamate-project-bindings/", status: 404, status_class: "4xx" }),
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
    expect(of("workspace_auth_expired")).toEqual([expect.objectContaining({ status: 403, workspace_id: 42 })])
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
    replies = [{ status: 404, body: { detail: "x" } }]
    await expect(WorkspaceApi.getBindingForRemote("git@x:y.git")).resolves.toBeNull()
    // 404 on a lookup is an answer, not a failure of the link flow: no link_failed, but the API error row stays.
    expect(of("workspace_link_failed")).toHaveLength(0)
    expect(of("workspace_api_error")[0].endpoint).toMatch(/^GET \/datamate-project-bindings\//)

    events = []
    replies = [{ hang: true }]
    const r = WorkspaceApi.listDatamates()
    await expect(r).rejects.toThrow(/timed out/)
    expect(of("workspace_api_error")[0]).toEqual(expect.objectContaining({ status_class: "timeout" }))
  }, 40_000)

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
