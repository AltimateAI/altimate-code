import { z } from "zod"
// altimate_change start — upstream_fix: route validation-failure logging through the quiet Log shim.
// The raw console.trace/console.error here dumped a stack trace + full issue JSON to the terminal on
// EVERY Zod validation failure. In the TUI that corrupts the render (in Bun, console.* bypasses the
// worker stdout guard); in run/serve it floods output. The error is re-thrown with full detail, so
// the console output is debug-only — gate it behind the Log shim (quiet unless --print-logs).
import { Log } from "@/altimate/util/log"
const log = Log.create({ service: "fn" })
// altimate_change end

export function fn<T extends z.ZodType, Result>(schema: T, cb: (input: z.infer<T>) => Result) {
  const result = (input: z.infer<T>) => {
    let parsed
    try {
      parsed = schema.parse(input)
    } catch (e) {
      // altimate_change start — upstream_fix: quiet, gated logging instead of raw console.* (see import note)
      if (e instanceof z.ZodError) {
        log.error("schema validation failure", { issues: JSON.stringify(e.issues) })
      } else {
        log.error("schema validation failure", { error: e })
      }
      // altimate_change end
      throw e
    }

    return cb(parsed)
  }
  result.force = (input: z.infer<T>) => cb(input)
  result.schema = schema
  return result
}
