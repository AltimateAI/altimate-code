import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { Database as BunDatabase } from "bun:sqlite"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      // altimate_change start — upstream_fix: run one-shot diagnostic queries on a READ-ONLY
      // connection so `db "DELETE ..."` / DROP can't corrupt user session data. The merge routed
      // this through the writable Database.Service; main used a readonly bun:sqlite connection.
      const db = new BunDatabase(Database.path(), { readonly: true })
      try {
        const result = db.query(query).all() as Record<string, unknown>[]
        if (args.format === "json") console.log(JSON.stringify(result, null, 2))
        else if (result.length > 0) {
          const keys = Object.keys(result[0])
          console.log(keys.join("\t"))
          for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
        }
      } catch (e) {
        // Clean CLI error (e.g. "attempt to write a readonly database") instead of an orDie defect.
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        db.close()
      }
      return
      // altimate_change end
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
