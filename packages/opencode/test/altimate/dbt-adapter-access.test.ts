// The tools the dbt Power User features call: their allow-list entries and placeholder answers, the
// one gate the new dbt-adapter-backed tools go through, and the API helper for new endpoint files. The
// dbt adapter is replaced through `dbtAdapterInternals`, so these tests need no Python or dbt.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import { dbtAdapterAccessInternals, dbtAdapterFor } from "@/altimate/tools/dbt-adapter-access"
import { resultFailed } from "@/altimate/mcp-server/adapter"
import { EXPOSED, MCP_OPEN_WRITE_TOOLS, WRITE_TOOLS } from "@/altimate/tool-cli/allow-list"
import { AltimateApi } from "@/altimate/api/client"
import { Instance } from "@/project/instance"
import { disposeInstance } from "@/effect/instance-registry"
import { initTool } from "./tool-fixture"

/** Each tool with the smallest arguments its parameters accept. */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  dbt_run_results: {},
  dbt_defer_state: { project_dir: "." },
  dbt_map_relations: { sql: "select 1" },
  docs_share_comments: { action: "list" },
  dbt_cost_estimate: {},
  dbt_health: {},
  dbt_sql_graph: { model: "customers" },
  dbt_docs_coverage: { model: "customers" },
  dbt_cte_profile: { model: "customers" },
}
const FEATURE_TOOLS = Object.keys(MINIMAL_ARGS)
// Tools that have their own implementation and test: they no longer answer as placeholders.
const IMPLEMENTED = new Set(["dbt_defer_state"])

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_adapter_access"),
  messageID: MessageID.make("msg_dbt_adapter_access"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

let project: string

function useConfig() {
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot: project,
    pythonPath: "python3",
    dbtIntegration: "corecommand",
    queryLimit: 500,
  })
}

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-adapter-access-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: jaffle_shop\n")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

beforeEach(() => resetDbtAdapter())

afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
})

describe("feature tools in the allow-list", () => {
  test("all nine are exposed, in the map's alphabetical order, and none is a write tool", () => {
    const ids = Object.keys(EXPOSED)
    for (const id of FEATURE_TOOLS) {
      expect(ids).toContain(id)
      expect(WRITE_TOOLS.has(id)).toBe(false)
      expect(MCP_OPEN_WRITE_TOOLS.has(id)).toBe(false)
    }
    const listed = ids.filter((id) => id.startsWith("dbt_") || id.startsWith("docs_"))
    expect(listed).toEqual([...listed].sort())
  })

  test("each placeholder answers that it isn't implemented, as a failure", async () => {
    for (const id of FEATURE_TOOLS.filter((id) => !IMPLEMENTED.has(id))) {
      const tool = await initTool(EXPOSED[id] as any)
      expect(tool.id).toBe(id)
      const result = await tool.execute(MINIMAL_ARGS[id], ctx)
      expect(result.title).toBe(`${id}: not implemented`)
      expect(result.metadata).toEqual({ success: false, error: "not implemented", truncated: false })
      expect(result.output).toContain(id)
      expect(resultFailed(result)).toBe(true)
    }
  })

  test("each placeholder still checks its arguments before it refuses", async () => {
    for (const id of FEATURE_TOOLS) {
      const tool = await initTool(EXPOSED[id] as any)
      // A string where an object is expected fails every schema, whatever its required fields.
      const failed = await Promise.resolve()
        .then(() => tool.execute("not an object" as any, ctx))
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
      if ("result" in failed) {
        expect(failed.result.title).not.toBe(`${id}: not implemented`)
        expect(resultFailed(failed.result)).toBe(true)
      } else {
        expect(String(failed.error)).toContain("invalid arguments")
      }
    }
  })
})

describe("dbtAdapterFor abort", () => {
  test("a read-only call that is already cancelled is cancelled, not refused", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(dbtAdapterFor({ abort: ac.signal, agent: "plan", extra: { forceReadOnly: true } } as any)).rejects.toBeDefined()
  })
})

describe("dbtAdapterFor", () => {
  let created: number
  beforeEach(() => {
    created = 0
    useConfig()
    dbtAdapterInternals.create = async () => {
      created += 1
      return { isInitialized: () => true, dispose: async () => {} }
    }
  })

  test("refuses a read-only call and never creates the adapter", async () => {
    const access = await dbtAdapterFor({ ...ctx, extra: { forceReadOnly: true } })
    expect(access.adapter).toBeUndefined()
    expect(access.refusal).toBe("read_only")
    expect(access.reason).toContain("--allow-write")
    expect(created).toBe(0)
  })

  test("refuses a plan-mode call", async () => {
    const access = await dbtAdapterFor({ ...ctx, agent: "plan" })
    expect(access.refusal).toBe("read_only")
    expect(created).toBe(0)
  })

  test("returns the adapter where writes are allowed", async () => {
    const access = await dbtAdapterFor(ctx)
    expect(access.refusal).toBeUndefined()
    expect(access.adapter?.isInitialized()).toBe(true)
    expect(created).toBe(1)
  })

  test("returns the adapter to a session inside the adapter's own project", async () => {
    try {
      const access = await Instance.provide({ directory: project, fn: () => dbtAdapterFor(ctx) })
      expect(access.refusal).toBeUndefined()
      expect(access.reason).toBeUndefined()
      expect(access.adapter?.isInitialized()).toBe(true)
      expect(created).toBe(1)
    } finally {
      await disposeInstance(project)
    }
  })

  test("says when the adapter didn't load the project", async () => {
    dbtAdapterInternals.create = async () => ({ isInitialized: () => false, dispose: async () => {} })
    const access = await dbtAdapterFor(ctx)
    expect(access).toEqual({ refusal: "not_loaded", reason: "the dbt adapter didn't load the project" })
  })

  test("says there is no dbt project when the config finds none", async () => {
    dbtAdapterInternals.readConfig = async () => null
    const access = await dbtAdapterFor(ctx)
    expect(access).toEqual({ refusal: "no_project", reason: "no dbt project here" })
  })

  test("says when the adapter doesn't start in time", async () => {
    dbtAdapterInternals.create = () => new Promise(() => {})
    const saved = dbtAdapterAccessInternals.adapterStartTimeoutMs
    dbtAdapterAccessInternals.adapterStartTimeoutMs = 20
    try {
      const access = await dbtAdapterFor(ctx)
      expect(access).toEqual({ refusal: "not_started", reason: "the dbt adapter wasn't ready within 0.02 s" })
    } finally {
      dbtAdapterAccessInternals.adapterStartTimeoutMs = saved
    }
  })

  test("says the adapter didn't start when the project exists but creating it fails", async () => {
    dbtAdapterInternals.create = async () => {
      created += 1
      throw new Error("dbt-integration missing")
    }
    const access = await dbtAdapterFor(ctx)
    expect(access).toEqual({ refusal: "not_started", reason: "the dbt adapter didn't start" })
    expect(created).toBe(1)
  })

  test("a call cancelled while the adapter starts throws and stops waiting", async () => {
    let entered = () => {}
    const starting = new Promise<void>((resolve) => (entered = resolve))
    dbtAdapterInternals.create = () => {
      entered()
      return new Promise(() => {})
    }
    const controller = new AbortController()
    const pending = dbtAdapterFor({ ...ctx, abort: controller.signal })
    await starting
    controller.abort(new Error("cancelled"))
    await expect(pending).rejects.toThrow("cancelled")
  })

  test("a cancelled call throws rather than answering", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(dbtAdapterFor({ ...ctx, abort: controller.signal })).rejects.toThrow()
    expect(created).toBe(0)
  })

  test("a cancelled read-only or plan-mode call throws rather than being refused", async () => {
    const controller = new AbortController()
    controller.abort()
    const abort = controller.signal
    await expect(dbtAdapterFor({ ...ctx, abort, extra: { forceReadOnly: true } })).rejects.toThrow()
    await expect(dbtAdapterFor({ ...ctx, abort, agent: "plan" })).rejects.toThrow()
    expect(created).toBe(0)
  })

  test("a session in a dbt project the adapter isn't set up for says so", async () => {
    dbtAdapterInternals.readConfig = async () => null
    try {
      const access = await Instance.provide({ directory: project, fn: () => dbtAdapterFor(ctx) })
      expect(access).toEqual({
        refusal: "other_project",
        reason: `the dbt adapter isn't set up for ${realpathSync(project)}`,
      })
      expect(created).toBe(0)
    } finally {
      await disposeInstance(project)
    }
  })

  test("a stalled dbt config read gives up at the start timeout", async () => {
    let release = () => {}
    dbtAdapterInternals.readConfig = () => new Promise((resolve) => (release = () => resolve(null)))
    const saved = dbtAdapterAccessInternals.adapterStartTimeoutMs
    dbtAdapterAccessInternals.adapterStartTimeoutMs = 20
    try {
      const access = await Instance.provide({ directory: project, fn: () => dbtAdapterFor(ctx) })
      expect(access).toEqual({ refusal: "not_started", reason: "the dbt adapter wasn't ready within 0.02 s" })
      expect(created).toBe(0)
    } finally {
      release()
      dbtAdapterAccessInternals.adapterStartTimeoutMs = saved
      await disposeInstance(project)
    }
  })

  test("a call cancelled during a stalled dbt config read throws at once", async () => {
    let release = () => {}
    let entered = () => {}
    const reading = new Promise<void>((resolve) => (entered = resolve))
    dbtAdapterInternals.readConfig = () => {
      entered()
      return new Promise((resolve) => (release = () => resolve(null)))
    }
    const controller = new AbortController()
    try {
      const pending = Instance.provide({
        directory: project,
        fn: () => dbtAdapterFor({ ...ctx, abort: controller.signal }),
      })
      await reading
      controller.abort(new Error("cancelled"))
      await expect(pending).rejects.toThrow("cancelled")
    } finally {
      release()
      await disposeInstance(project)
    }
  })

  test("removes its abort listener and its timer whatever the outcome", async () => {
    /** A signal that counts the abort listeners still attached to it. */
    const tracked = () => {
      const controller = new AbortController()
      const signal = controller.signal
      const state = { controller, signal, listening: 0 }
      const add = signal.addEventListener.bind(signal)
      const remove = signal.removeEventListener.bind(signal)
      signal.addEventListener = ((...a: Parameters<typeof add>) => {
        if (a[0] === "abort") state.listening += 1
        return add(...a)
      }) as typeof signal.addEventListener
      signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
        if (a[0] === "abort") state.listening -= 1
        return remove(...a)
      }) as typeof signal.removeEventListener
      return state
    }
    const settled = tracked()
    const cancelled = tracked()
    const signal = settled.signal
    const timers = new Set<unknown>()
    const set = globalThis.setTimeout
    const clear = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const t = set(fn, ms)
      timers.add(t)
      return t
    }) as typeof setTimeout
    globalThis.clearTimeout = ((t: ReturnType<typeof setTimeout>) => {
      timers.delete(t)
      return clear(t)
    }) as typeof clearTimeout
    try {
      expect((await dbtAdapterFor({ ...ctx, abort: signal })).adapter).toBeDefined()
      dbtAdapterInternals.create = async () => {
        throw new Error("dbt-integration missing")
      }
      resetDbtAdapter()
      expect((await dbtAdapterFor({ ...ctx, abort: signal })).refusal).toBe("not_started")
      // Timed out.
      dbtAdapterInternals.create = () => new Promise(() => {})
      resetDbtAdapter()
      const saved = dbtAdapterAccessInternals.adapterStartTimeoutMs
      dbtAdapterAccessInternals.adapterStartTimeoutMs = 20
      try {
        expect(await dbtAdapterFor({ ...ctx, abort: signal })).toEqual({
          refusal: "not_started",
          reason: "the dbt adapter wasn't ready within 0.02 s",
        })
      } finally {
        dbtAdapterAccessInternals.adapterStartTimeoutMs = saved
      }
      // Cancelled while waiting.
      let entered = () => {}
      const starting = new Promise<void>((resolve) => (entered = resolve))
      dbtAdapterInternals.create = () => {
        entered()
        return new Promise(() => {})
      }
      resetDbtAdapter()
      const pending = dbtAdapterFor({ ...ctx, abort: cancelled.signal })
      await starting
      cancelled.controller.abort(new Error("cancelled"))
      await expect(pending).rejects.toThrow("cancelled")
    } finally {
      globalThis.setTimeout = set
      globalThis.clearTimeout = clear
    }
    expect(settled.listening).toBe(0)
    expect(cancelled.listening).toBe(0)
    expect(timers.size).toBe(0)
  })

  test("a session in another dbt project than the adapter's says which", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "dbt-adapter-other-"))
    await writeFile(path.join(other, "dbt_project.yml"), "name: other\n")
    dbtAdapterInternals.readConfig = async () => ({
      projectRoot: other,
      pythonPath: "python3",
      dbtIntegration: "corecommand",
      queryLimit: 500,
    })
    try {
      const access = await Instance.provide({ directory: project, fn: () => dbtAdapterFor(ctx) })
      expect(access).toEqual({
        refusal: "other_project",
        reason: `the dbt adapter is set up for ${realpathSync(other)}, not ${realpathSync(project)}`,
      })
      expect(created).toBe(0)
    } finally {
      await disposeInstance(project)
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe("AltimateApi.apiRequest", () => {
  let home: string
  let saved: string | undefined
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "altimate-api-home-"))
    saved = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home
  })
  afterEach(async () => {
    if (saved === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = saved
    await rm(home, { recursive: true, force: true })
  })

  test("fails with a clear message when no credentials are stored", async () => {
    await expect(AltimateApi.apiRequest("GET", "/dbt/v1/x")).rejects.toThrow(
      `No Altimate credentials are stored: sign in to Altimate in altimate-code first (they are saved to ${path.join(home, ".altimate", "altimate.json")}).`,
    )
  })

  test("sends the stored key and tenant and returns the JSON body", async () => {
    await Bun.write(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: "https://api.example.test/", altimateInstanceName: "acme", altimateApiKey: "k1" }),
    )
    const original = globalThis.fetch
    const seen: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      expect(await AltimateApi.apiRequest("POST", "/dbt/v1/x", { a: 1 })).toEqual({ ok: 1 })
      expect(seen[0].url).toBe("https://api.example.test/dbt/v1/x")
      const headers = seen[0].init.headers as Record<string, string>
      expect(headers.Authorization).toBe("Bearer k1")
      expect(headers["x-tenant"]).toBe("acme")
      expect(seen[0].init.body).toBe(JSON.stringify({ a: 1 }))
    } finally {
      globalThis.fetch = original
    }
  })

  test("sends a falsy JSON body rather than dropping it", async () => {
    await Bun.write(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: "https://api.example.test", altimateInstanceName: "acme", altimateApiKey: "k1" }),
    )
    const original = globalThis.fetch
    const bodies: unknown[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(init.body)
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    try {
      for (const body of [null, false, 0, ""]) await AltimateApi.apiRequest("POST", "/dbt/v1/x", body)
      await AltimateApi.apiRequest("GET", "/dbt/v1/x")
      expect(bodies).toEqual(["null", "false", "0", '""', undefined])
    } finally {
      globalThis.fetch = original
    }
  })

  test("a cancelled call stops the request", async () => {
    await Bun.write(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: "https://api.example.test", altimateInstanceName: "acme", altimateApiKey: "k1" }),
    )
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        // Like fetch: a signal already aborted rejects at once, else the abort does.
        if (init.signal?.aborted) return reject(init.signal.reason)
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })) as unknown as typeof fetch
    const controller = new AbortController()
    try {
      const pending = AltimateApi.apiRequest("GET", "/dbt/v1/x", undefined, controller.signal)
      controller.abort(new Error("cancelled by the user"))
      await expect(pending).rejects.toThrow("cancelled by the user")
    } finally {
      globalThis.fetch = original
    }
  })

  test("names the file and the failure, never the file's text, when the credentials aren't valid JSON", async () => {
    const file = path.join(home, ".altimate", "altimate.json")
    await Bun.write(
      file,
      '{"altimateUrl":"https://x.test","altimateInstanceName":"acme","altimateApiKey": sk_SECRET123}',
    )
    const error = await AltimateApi.apiRequest("GET", "/dbt/v1/x").catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(`The Altimate credentials in ${file} can't be used: the file is not valid JSON.`)
    expect(error.message).not.toContain("sk_SECRET123")
  })

  test("names the missing field, never a value, when the credentials are incomplete", async () => {
    const file = path.join(home, ".altimate", "altimate.json")
    await Bun.write(file, JSON.stringify({ altimateUrl: "https://x.test", altimateApiKey: "sk_SECRET123" }))
    const error = await AltimateApi.apiRequest("GET", "/dbt/v1/x").catch((e: Error) => e)
    expect(error.message).toBe(
      `The Altimate credentials in ${file} can't be used: altimateInstanceName is missing or not valid.`,
    )
    expect(error.message).not.toContain("sk_SECRET123")
  })

  const HEADER_REFUSED =
    "could not be sent: the request was refused before it was sent (TypeError): the stored API key or tenant name may not be a valid header value."

  /** Every substring of `key` long enough to identify it, so a trimmed or split copy is caught too. */
  function expectNoPartOf(text: string, key: string) {
    for (const part of key.split(/\s+/).filter((p) => p.length >= 4)) expect(text).not.toContain(part)
    expect(text).not.toContain("Bearer")
  }

  // The real fetch: Bun refuses a header value with CR/LF, quoting it after trimming its whitespace.
  for (const key of [
    "sk_SECRET123\r\nX: y",
    "sk_SECRET123ABCDEFGH\nPART2\n",
    "sk_SECRET123ABCDEFGH\r\nX \t",
    " sk_SECRET123ABCDEFGH\nPART2 ",
  ]) {
    test(`never shows any part of a key that isn't a valid header value: ${JSON.stringify(key)}`, async () => {
      await Bun.write(
        path.join(home, ".altimate", "altimate.json"),
        JSON.stringify({ altimateUrl: "http://127.0.0.1:9", altimateInstanceName: "acme", altimateApiKey: key }),
      )
      const viaRequest = await AltimateApi.apiRequest("GET", "/dbt/v1/x").catch((e: Error) => e)
      expect(viaRequest).toBeInstanceOf(Error)
      expect(viaRequest.message).toBe(`API GET /dbt/v1/x ${HEADER_REFUSED}`)
      expectNoPartOf(`${viaRequest.message}\n${viaRequest.stack}`, key)
      const viaList = (await AltimateApi.listDatamates().catch((e: Error) => e)) as Error
      expect(viaList).toBeInstanceOf(Error)
      expect(viaList.message).toBe(`API GET /datamates/ ${HEADER_REFUSED}`)
      expectNoPartOf(`${viaList.message}\n${viaList.stack}`, key)
    })
  }

  test("a fetch that rejects with no reason is a send failure, not taken for an abort", async () => {
    await Bun.write(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: "http://127.0.0.1:9", altimateInstanceName: "acme", altimateApiKey: "k1" }),
    )
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(undefined)) as unknown as typeof fetch
    try {
      const error = await AltimateApi.apiRequest("GET", "/dbt/v1/x", undefined, new AbortController().signal).catch(
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("API GET /dbt/v1/x could not be sent: Error.")
    } finally {
      globalThis.fetch = original
    }
  })

  test("names a network failure by its code, never by the error's text", async () => {
    await Bun.write(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: "http://127.0.0.1:9", altimateInstanceName: "acme", altimateApiKey: "k1" }),
    )
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("Unable to connect: Bearer k1"), { code: "ConnectionRefused" })
    }) as unknown as typeof fetch
    try {
      const error = await AltimateApi.apiRequest("GET", "/dbt/v1/x").catch((e: Error) => e)
      expect(error.message).toBe("API GET /dbt/v1/x could not be sent: Error (ConnectionRefused).")
    } finally {
      globalThis.fetch = original
    }
  })

  test("never shows the stored key when a header refusal races the caller's abort", async () => {
    await Bun.write(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.example.test",
        altimateInstanceName: "acme",
        altimateApiKey: "sk_SECRET123",
      }),
    )
    const original = globalThis.fetch
    const controller = new AbortController()
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      controller.abort(new Error("cancelled by the user"))
      throw new TypeError(`bad header: '${(init.headers as Record<string, string>).Authorization}'`)
    }) as unknown as typeof fetch
    try {
      const error = await AltimateApi.apiRequest("GET", "/dbt/v1/x", undefined, controller.signal).catch(
        (e: Error) => e,
      )
      expect(error.message).toBe(`API GET /dbt/v1/x ${HEADER_REFUSED}`)
    } finally {
      globalThis.fetch = original
    }
  })

  test("never quotes the credentials file when an ${env:…} variable it names isn't set", async () => {
    const file = path.join(home, ".altimate", "altimate.json")
    await Bun.write(
      file,
      JSON.stringify({
        altimateUrl: "https://x.test",
        altimateInstanceName: "acme",
        altimateApiKey: "${env:sk_SECRET123_UNSET}",
      }),
    )
    const error = await AltimateApi.apiRequest("GET", "/dbt/v1/x").catch((e: Error) => e)
    expect(error.message).toBe(
      `The Altimate credentials in ${file} can't be used: an \${env:…} variable it refers to is not set.`,
    )
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says the credentials can't be read, not that none are stored, when their directory can't be searched",
    async () => {
      const dir = path.join(home, ".altimate")
      const file = path.join(dir, "altimate.json")
      await Bun.write(
        file,
        JSON.stringify({ altimateUrl: "https://x.test", altimateInstanceName: "a", altimateApiKey: "k" }),
      )
      await chmod(dir, 0o600)
      try {
        const error = await AltimateApi.apiRequest("GET", "/dbt/v1/x").catch((e: Error) => e)
        expect(error.message).toBe(`The Altimate credentials in ${file} can't be read (EACCES).`)
      } finally {
        await chmod(dir, 0o700)
      }
    },
  )

  test("a timed-out request says it timed out", async () => {
    await Bun.write(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: "https://api.example.test", altimateInstanceName: "acme", altimateApiKey: "k1" }),
    )
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })) as unknown as typeof fetch
    const saved = AltimateApi.requestInternals.timeoutMs
    AltimateApi.requestInternals.timeoutMs = 10
    try {
      await expect(AltimateApi.apiRequest("GET", "/dbt/v1/x")).rejects.toThrow(
        "API GET /dbt/v1/x timed out after 0.01 s",
      )
    } finally {
      AltimateApi.requestInternals.timeoutMs = saved
      globalThis.fetch = original
    }
  })

  test("a call cancelled before it starts reads no credentials and sends nothing", async () => {
    const original = globalThis.fetch
    let sent = 0
    globalThis.fetch = (async () => {
      sent += 1
      return new Response("{}")
    }) as unknown as typeof fetch
    const controller = new AbortController()
    controller.abort(new Error("cancelled by the user"))
    try {
      // No credentials are stored: reading them would fail with another message.
      await expect(AltimateApi.apiRequest("GET", "/dbt/v1/x", undefined, controller.signal)).rejects.toThrow(
        "cancelled by the user",
      )
      expect(sent).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })
})
