import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const WarehouseTestTool = Tool.define("warehouse_test", {
  description:
    "Test connectivity to a named warehouse connection. Verifies the connection is reachable and credentials are valid.",
  parameters: z.object({
    name: z.string().describe("Name of the warehouse connection to test"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("warehouse.test", { name: args.name })

      if (result.connected) {
        return {
          title: `Connection '${args.name}': OK`,
          metadata: { connected: true },
          output: `Successfully connected to warehouse '${args.name}'.`,
        }
      }

      // altimate_change start — never let a broken client look like a bad connection
      // A driver that will not load, or an open that never completed, is a
      // fault in this machine's install. Reporting it with the same wording as
      // a wrong password invites both the model and anyone reading the
      // transcript to treat broken infrastructure as a task or config failure.
      // A locked store is infrastructure too — nothing about the connection's
      // config is wrong — but it is the one category that clears itself once
      // the other process lets go, and the driver's own message names the PID
      // holding the lock. Telling the model to stop and report would be wrong
      // advice for the one fault it can actually act on.
      if (result.recoverable) {
        return {
          title: `Connection '${args.name}': STORE LOCKED`,
          metadata: {
            connected: false,
            error: result.error,
            error_category: result.error_category,
            infrastructure: true,
            recoverable: true,
          },
          output:
            `STORE LOCKED — another process holds this store open, so it could not be ` +
            `opened here. This is NOT a problem with the connection's configuration and ` +
            `NOT a credentials failure.\n` +
            `Category: ${result.error_category}\n` +
            `Error: ${result.error ?? "Unknown error"}\n\n` +
            `The error above names the process holding the lock. Close that connection ` +
            `and try again. Do not work around this by querying something else — until ` +
            `the lock clears, no result here comes from warehouse '${args.name}'.`,
        }
      }

      if (result.infrastructure) {
        return {
          title: `Connection '${args.name}': INFRASTRUCTURE FAILURE`,
          metadata: {
            connected: false,
            error: result.error,
            error_category: result.error_category,
            infrastructure: true,
          },
          output:
            `INFRASTRUCTURE FAILURE — the warehouse client on this machine is broken. ` +
            `This is NOT a problem with the connection's configuration, and NOT something ` +
            `to work around by trying a different query or a different tool.\n` +
            `Category: ${result.error_category}\n` +
            `Error: ${result.error ?? "Unknown error"}\n\n` +
            `Stop and report this rather than continuing — results produced after this ` +
            `point did not come from warehouse '${args.name}'.`,
        }
      }
      // altimate_change end

      return {
        title: `Connection '${args.name}': FAILED`,
        metadata: { connected: false, error: result.error, error_category: result.error_category },
        output: `Failed to connect to warehouse '${args.name}'.\nError: ${result.error ?? "Unknown error"}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `Connection '${args.name}': ERROR`,
        metadata: { connected: false, error: msg },
        output: `Failed to test connection: ${msg}\n\nCheck your connection configuration and try again.`,
      }
    }
  },
})
