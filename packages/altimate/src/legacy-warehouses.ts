import { isLocalFilePath } from "@altimateai/drivers/file-store"
import { Option, Schema } from "effect"
import { homedir } from "node:os"
import path from "node:path"
import { Warehouse } from "./rpc"

const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
const decodeEntry = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.String, path: Schema.optional(Schema.Unknown) }),
)

// H4 feasibility adapter: only the existing DuckDB registry is executable.
// Never resolve legacy keychain credentials or copy arbitrary config into RPC/storage.
export async function readLegacyWarehouses(input: {
  directory: string
  home?: string
  env?: NodeJS.ProcessEnv
  files?: boolean
}) {
  const env = input.env ?? process.env
  const home = input.home ?? env.OPENCODE_TEST_HOME ?? process.env.OPENCODE_TEST_HOME ?? homedir()
  const issues: { source: string; name?: string; reason: string }[] = []
  const sources: string[] = []
  const entries = new Map<string, { type: string; path: unknown; source: string; base: string }>()

  function add(name: string, raw: unknown, source: string, base: string) {
    const entry = Option.getOrUndefined(decodeEntry(raw))
    if (!entry || !entry.type.trim() || !name.trim()) {
      issues.push({ source, name, reason: "invalid-entry" })
      return
    }
    entries.set(name, { type: entry.type.toLowerCase(), path: entry.path, source, base })
  }

  for (const [source, base] of input.files === false
    ? []
    : [
        [path.join(home, ".altimate-code", "connections.json"), path.join(home, ".altimate-code")],
        [path.join(input.directory, ".altimate-code", "connections.json"), input.directory],
      ]) {
    const content = await Bun.file(source)
      .text()
      .catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          issues.push({ source, reason: "unreadable-file" })
        return undefined
      })
    if (content === undefined) continue
    sources.push(source)
    const parsed = Option.getOrUndefined(decodeFile(content))
    if (!parsed) {
      issues.push({ source, reason: "invalid-json-object" })
      continue
    }
    Object.entries(parsed).forEach(([name, raw]) => add(name, raw, source, base))
  }
  Object.entries(env).forEach(([source, value]) => {
    if (!source.startsWith("ALTIMATE_CODE_CONN_") || !value) return
    const raw = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(value))
    add(source.slice("ALTIMATE_CODE_CONN_".length).toLowerCase(), raw, source, input.directory)
  })

  const warehouses: (typeof Warehouse.Type)[] = []
  const inventory = Array.from(entries, ([name, entry]) => {
    if (entry.type !== "duckdb") {
      issues.push({ source: entry.source, name, reason: `unsupported-type:${entry.type}` })
      return { name, type: entry.type }
    }
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      issues.push({ source: entry.source, name, reason: "missing-duckdb-path" })
      return { name, type: entry.type }
    }
    warehouses.push({
      name,
      type: "duckdb",
      path:
        isLocalFilePath(entry.path) && !path.isAbsolute(entry.path) && !path.win32.isAbsolute(entry.path)
          ? path.resolve(entry.base, entry.path)
          : entry.path,
    })
    return { name, type: entry.type }
  })
  return { warehouses, inventory, issues, sources }
}
