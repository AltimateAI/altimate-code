import { describe, expect, spyOn, test } from "bun:test"
import { Dispatcher } from "../../../src/altimate/native"
import { WarehouseTestTool } from "../../../src/altimate/tools/warehouse-test"
import { Tool } from "../../../src/tool/tool"
import { initTool } from "../tool-fixture"

describe("warehouse_test diagnostic results", () => {
  test.each([
    {
      title: "STORE LOCKED",
      error_category: "store_locked",
      recoverable: true,
      guidance: "Close that connection and try again",
    },
    {
      title: "INFRASTRUCTURE FAILURE",
      error_category: "driver_open_timeout",
      recoverable: false,
      guidance: "Stop and report this",
    },
  ])("returns $title guidance as a successful diagnostic", async ({ title, error_category, recoverable, guidance }) => {
    const dispatcher = spyOn(Dispatcher, "call").mockResolvedValue({
      connected: false,
      error: "Store could not be opened",
      error_category,
      infrastructure: true,
      recoverable,
    } as any)
    try {
      const tool = await initTool(WarehouseTestTool)
      const result = await tool.execute({ name: "local" }, {
        sessionID: "ses_warehouse_diagnostics",
        messageID: "msg_warehouse_diagnostics",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
      })
      expect(result.title).toContain(title)
      expect(result.output).toContain(guidance)
      expect(result.metadata).toMatchObject({
        success: true,
        connected: false,
        error: "Store could not be opened",
        error_category,
        infrastructure: true,
      })
      expect(result.status).not.toBe("error")
      expect(() => Tool.assertSuccess(result)).not.toThrow()
    } finally {
      dispatcher.mockRestore()
    }
  })

  test.each(["failed connectivity", "dispatcher exception"])("preserves %s as an SDK error", async (kind) => {
    const dispatcher = spyOn(Dispatcher, "call").mockImplementation(async () => {
      if (kind === "dispatcher exception") throw new Error("Connection rejected")
      return { connected: false, error: "Connection rejected", error_category: "config_error" } as any
    })
    try {
      const tool = await initTool(WarehouseTestTool)
      const result = await tool.execute({ name: "local" }, {
        sessionID: "ses_warehouse_diagnostics",
        messageID: "msg_warehouse_diagnostics",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
      })
      expect(result.metadata.success).toBe(false)
      expect(result.status).toBe("error")
      expect(() => Tool.assertSuccess(result)).toThrow("Connection rejected")
    } finally {
      dispatcher.mockRestore()
    }
  })
})
