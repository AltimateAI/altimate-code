import { EOL } from "os"
import { Effect } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { InstanceRef } from "@/effect/instance-ref"
// altimate_change start — upstream_fix: restore debug rg tree command
import { Ripgrep as AppRipgrep } from "@/file/ripgrep"
// altimate_change end

export const RipgrepCommand = cmd({
  command: "rg",
  describe: "ripgrep debugging utilities",
  // altimate_change start — upstream_fix: restore debug rg tree command
  builder: (yargs) =>
    yargs
      .command(TreeCommand)
      .command(FilesCommand)
      .command(SearchCommand)
      .demandCommand(),
  // altimate_change end
  async handler() {},
})

// altimate_change start — upstream_fix: restore debug rg tree command
const TreeCommand = effectCmd({
  command: "tree",
  describe: "show file tree using ripgrep",
  builder: (yargs) =>
    yargs.option("limit", {
      type: "number",
    }),
  handler: Effect.fn("Cli.debug.rg.tree")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const tree = yield* Effect.promise(() => AppRipgrep.tree({ cwd: ctx.directory, limit: args.limit }))
    process.stdout.write(tree + EOL)
  }),
})
// altimate_change end

const FilesCommand = effectCmd({
  command: "files",
  describe: "list files using ripgrep",
  builder: (yargs) =>
    yargs
      .option("query", {
        type: "string",
        description: "Filter files by query",
      })
      .option("glob", {
        type: "string",
        description: "Glob pattern to match files",
      })
      .option("limit", {
        type: "number",
        description: "Limit number of results",
      }),
  handler: Effect.fn("Cli.debug.rg.files")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const ripgrep = yield* Ripgrep.Service
    const files = yield* ripgrep
      .glob({
        cwd: ctx.directory,
        pattern: args.glob ?? "**/*",
        limit: args.limit ?? 10_000,
      })
      .pipe(Effect.orDie)
    process.stdout.write(files.map((file) => file.path).join(EOL) + EOL)
  }),
})

const SearchCommand = effectCmd({
  command: "search <pattern>",
  describe: "search file contents using ripgrep",
  builder: (yargs) =>
    yargs
      .positional("pattern", {
        type: "string",
        demandOption: true,
        description: "Search pattern",
      })
      .option("glob", {
        type: "array",
        description: "File glob patterns",
      })
      .option("limit", {
        type: "number",
        description: "Limit number of results",
      }),
  handler: Effect.fn("Cli.debug.rg.search")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const ripgrep = yield* Ripgrep.Service
    // altimate_change start — upstream_fix: preserve all debug rg search --glob entries
    const include = args.glob?.map(String).filter(Boolean)
    // altimate_change end
    const results = yield* ripgrep
      .grep({
        cwd: ctx.directory,
        pattern: args.pattern,
        // altimate_change start — upstream_fix: preserve all debug rg search --glob entries
        include: include && include.length > 0 ? include : undefined,
        // altimate_change end
        limit: args.limit ?? 10_000,
      })
      .pipe(Effect.orDie)
    process.stdout.write(JSON.stringify(results, null, 2) + EOL)
  }),
})
