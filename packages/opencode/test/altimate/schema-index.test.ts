import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Connector } from "@altimateai/drivers"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import * as Registry from "../../src/altimate/native/connections/registry"
import * as SchemaCache from "../../src/altimate/native/schema/cache"
import { registerAll } from "../../src/altimate/native/schema/register"
import { SchemaIndexTool } from "../../src/altimate/tools/schema-index"
import { PostConnectSuggestions } from "../../src/altimate/tools/post-connect-suggestions"
import { MessageID, SessionID } from "../../src/session/schema"
import { initTool } from "./tool-fixture"

const completeResult = {
  warehouse: "inventory",
  type: "duckdb",
  schemas_indexed: 1,
  tables_indexed: 2,
  columns_indexed: 4,
  timestamp: "2026-01-01T00:00:00.000Z",
}

function context(signal: AbortSignal) {
  return {
    sessionID: SessionID.make("ses_schema"),
    messageID: MessageID.make("msg_schema"),
    agent: "build",
    abort: signal,
    messages: [],
  }
}

beforeEach(() => {
  Dispatcher.setRegistrationHook(async () => registerAll())
  PostConnectSuggestions.resetShownSuggestions()
})

afterEach(() => {
  mock.restore()
  PostConnectSuggestions.resetShownSuggestions()
})

describe("schema_index tool", () => {
  test("forwards session cancellation to native indexing", async () => {
    const call = spyOn(Dispatcher, "call").mockResolvedValue(completeResult)
    const controller = new AbortController()
    const tool = await initTool(SchemaIndexTool)

    await tool.execute({ warehouse: "inventory" }, context(controller.signal))

    expect(call).toHaveBeenCalledWith("schema.index", {
      warehouse: "inventory",
      signal: controller.signal,
    })
  })

  test("reports partial results without suggesting a completed cache", async () => {
    spyOn(Dispatcher, "call").mockResolvedValue({
      ...completeResult,
      partial: true,
      note: "Schema indexing deadline exceeded.",
    })
    const tool = await initTool(SchemaIndexTool)

    const result = await tool.execute({ warehouse: "inventory" }, context(new AbortController().signal))

    expect(result.title).toContain("Partial")
    expect(result.metadata.partial).toBe(true)
    expect(result.metadata.note).toBe("Schema indexing deadline exceeded.")
    expect(result.output).toContain("Schema indexing deadline exceeded.")
    expect(result.output).not.toContain("Schema cache is now ready")
    expect(result.output).not.toContain("sql_analyze")
  })
})

describe("schema.index native handler", () => {
  test("passes the cancellation signal into schema caching", async () => {
    const connector = {} as Connector
    spyOn(Registry, "get").mockResolvedValue(connector)
    spyOn(Registry, "getConfig").mockReturnValue({ type: "duckdb" })
    const started = Promise.withResolvers<void>()
    const indexWarehouse = mock(async (_name: string, _type: string, _connector: Connector, options: { signal: AbortSignal }) => {
      started.resolve()
      return new Promise<typeof completeResult & { partial: boolean; note: string }>((resolve) => {
        options.signal.addEventListener("abort", () => resolve({
          ...completeResult,
          partial: true,
          note: "Session cancelled.",
        }), { once: true })
      })
    })
    spyOn(SchemaCache, "getCache").mockResolvedValue({ indexWarehouse } as any)
    const controller = new AbortController()

    const pending = Dispatcher.call("schema.index", { warehouse: "inventory", signal: controller.signal })
    await started.promise
    controller.abort()
    const result = await pending

    const args = indexWarehouse.mock.calls[0]!
    expect(args[0]).toBe("inventory")
    expect(args[1]).toBe("duckdb")
    expect(args[2]).toBe(connector)
    expect(args[3]?.signal).toBeInstanceOf(AbortSignal)
    expect(result).toMatchObject({ ...completeResult, partial: true, note: "Session cancelled." })
  })

  test("cancels while waiting for a warehouse connection", async () => {
    const started = Promise.withResolvers<void>()
    const connection = Promise.withResolvers<Connector>()
    spyOn(Registry, "get").mockImplementation(() => {
      started.resolve()
      return connection.promise
    })
    spyOn(Registry, "getConfig").mockReturnValue({ type: "duckdb" })
    const cache = spyOn(SchemaCache, "getCache")
    const controller = new AbortController()
    const pending = Dispatcher.call("schema.index", {
      warehouse: "inventory",
      signal: controller.signal,
    })
    await started.promise

    controller.abort(new Error("Session cancelled."))
    const result = await pending

    expect(result).toMatchObject({
      warehouse: "inventory",
      partial: true,
      tables_indexed: 0,
      note: "Session cancelled.",
    })
    expect(cache).not.toHaveBeenCalled()
    connection.resolve({} as Connector)
    await connection.promise
    await Promise.resolve()
    expect(cache).not.toHaveBeenCalled()
  }, 1_000)

  test("applies the indexing deadline to warehouse connection acquisition", async () => {
    spyOn(Registry, "get").mockImplementation(() => new Promise<Connector>(() => {}))
    spyOn(Registry, "getConfig").mockReturnValue({ type: "duckdb" })

    const result = await Dispatcher.call("schema.index", {
      warehouse: "inventory",
      timeout_ms: 5,
    })

    expect(result).toMatchObject({ partial: true, tables_indexed: 0 })
    expect(result.note).toContain("deadline")
  }, 1_000)
})
