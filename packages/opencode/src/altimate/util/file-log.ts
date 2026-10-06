// altimate_change start — synchronous lines in opencode.log from code outside the Effect runtime
/**
 * `opencode.log` is written by the Effect logger, which only code running inside
 * the app runtime reaches; `Log.create` in `./log` goes to stderr, and only with
 * print-logs on. Warehouse connections and debug tracing run outside both, so
 * nothing they did ever reached the file a user sends us. This appends lines in
 * the same `key=value` format, with the same per-thread run id. Synchronous on
 * purpose: a line written just before a hang or a crash must not sit in a buffer.
 */
import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { runID } from "@opencode-ai/core/observability/shared"

export type FileLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

function format(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  return /^[^\s="\\]+$/.test(text) ? text : JSON.stringify(text)
}

/** One log line; `service` is written first so lines are easy to find. Never throws. */
export function fileLog(level: FileLogLevel, service: string, message: string, fields: Record<string, unknown> = {}): void {
  try {
    const entries: Array<[string, unknown]> = [
      ["timestamp", new Date().toISOString()],
      ["level", level],
      ["run", runID],
      ["service", service],
      ["message", message],
      ...Object.entries(fields).filter(([, v]) => v !== undefined),
    ]
    fs.appendFileSync(path.join(Global.Path.log, "opencode.log"), entries.map(([k, v]) => `${k}=${format(v)}`).join(" ") + "\n")
  } catch {
    // logging must never break the caller
  }
}
// altimate_change end
