import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import path from "node:path"
import * as DriverResolve from "@altimateai/drivers/resolve"
import { WarehouseInstallDriverTool } from "../../src/altimate/tools/warehouse-install-driver"
import { initTool, type TestTool } from "./tool-fixture"

let tool: TestTool<typeof WarehouseInstallDriverTool>

beforeAll(async () => {
  tool = await initTool(WarehouseInstallDriverTool)
})

afterEach(() => {
  mock.restore()
})

function context(ask: (request: any) => Promise<void>) {
  return {
    sessionID: "ses_driver_permission",
    messageID: "msg_driver_permission",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask,
  }
}

describe("warehouse_install_driver permissions", () => {
  test("brokers external-directory and exact npm approvals before installing", async () => {
    const events: string[] = []
    const requests: any[] = []
    spyOn(DriverResolve, "isDriverInstalled").mockReturnValue(false)
    const install = spyOn(DriverResolve, "installOptionalDriver").mockImplementation(async (driver) => {
      events.push("install")
      return {
        driver,
        packages: DriverResolve.DRIVER_PACKAGES[driver],
        dir: DriverResolve.driverInstallDir(),
        installed: true,
        alreadyPresent: false,
      }
    })

    const result = await tool.execute(
      { driver: "postgres" },
      context(async (request) => {
        requests.push(request)
        events.push(`ask:${request.permission}`)
      }),
    )

    const dir = DriverResolve.driverInstallDir()
    // The cross-process install lock is a sibling of the managed directory, not
    // a child of it, so `<dir>/*` does not cover it. The tool creates, writes
    // and removes that directory, so it has to be approved explicitly rather
    // than mutated as an unapproved external path.
    const lockDir = DriverResolve.installLockPath(dir)
    expect(lockDir).toBe(`${dir}.lock`)
    expect(events).toEqual(["ask:external_directory", "ask:bash", "install"])
    expect(requests).toEqual([
      {
        permission: "external_directory",
        patterns: [path.join(dir, "*"), path.join(lockDir, "*")],
        always: [path.join(dir, "*"), path.join(lockDir, "*")],
        metadata: { driver: "postgres", dir, lockDir },
      },
      {
        permission: "bash",
        patterns: ["npm install --save --no-audit --no-fund --loglevel=error pg"],
        always: ["npm install --save --no-audit --no-fund --loglevel=error pg"],
        metadata: { driver: "postgres", dir, packages: ["pg"] },
      },
    ])
    expect(install).toHaveBeenCalledTimes(1)
    expect(result.metadata.installed).toBe(true)
  })

  for (const denied of ["external_directory", "bash"] as const) {
    test(`a denied ${denied} approval prevents installation`, async () => {
      spyOn(DriverResolve, "isDriverInstalled").mockReturnValue(false)
      const install = spyOn(DriverResolve, "installOptionalDriver").mockImplementation(async () => {
        throw new Error("install must not run")
      })

      await expect(
        tool.execute(
          { driver: "postgres" },
          context(async (request) => {
            if (request.permission === denied) throw new Error("permission denied")
          }),
        ),
      ).rejects.toThrow("permission denied")
      expect(install).not.toHaveBeenCalled()
    })
  }

  test("an already-usable driver does not request mutation permissions", async () => {
    spyOn(DriverResolve, "isDriverInstalled").mockReturnValue(true)
    spyOn(DriverResolve, "loadOptionalDriver").mockResolvedValue({})
    const install = spyOn(DriverResolve, "installOptionalDriver")
    const requests: any[] = []

    const result = await tool.execute(
      { driver: "postgres" },
      context(async (request) => {
        requests.push(request)
      }),
    )

    expect(requests).toEqual([])
    expect(install).not.toHaveBeenCalled()
    expect(result.metadata.alreadyPresent).toBe(true)
  })

  test("a broken installed driver brokers permissions and forces repair", async () => {
    const events: string[] = []
    const requests: any[] = []
    spyOn(DriverResolve, "isDriverInstalled").mockReturnValue(true)
    spyOn(DriverResolve, "loadOptionalDriver").mockRejectedValue(new Error("native addon is incompatible"))
    const install = spyOn(DriverResolve, "installOptionalDriver").mockImplementation(async (driver) => {
      events.push("install")
      return {
        driver,
        packages: DriverResolve.DRIVER_PACKAGES[driver],
        dir: DriverResolve.driverInstallDir(),
        installed: true,
        alreadyPresent: false,
      }
    })

    const result = await tool.execute(
      { driver: "postgres" },
      context(async (request) => {
        requests.push(request)
        events.push(`ask:${request.permission}`)
      }),
    )

    expect(events).toEqual(["ask:external_directory", "ask:bash", "install"])
    expect(requests.map((request) => request.permission)).toEqual(["external_directory", "bash"])
    expect(install).toHaveBeenCalledWith("postgres", { force: true })
    expect(result.metadata.installed).toBe(true)
    expect(result.metadata.alreadyPresent).toBe(false)
  })
})
