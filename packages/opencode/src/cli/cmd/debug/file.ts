import { EOL } from "os"
import { Effect } from "effect"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
// altimate_change start — upstream_fix: restore debug file status/tree commands
import { File } from "@/file"
import { Ripgrep as AppRipgrep } from "@/file/ripgrep"
// altimate_change end

const filesystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }))),
    Effect.provide(locationServiceMapLayer),
  )

const FileSearchCommand = effectCmd({
  command: "search <query>",
  describe: "search files by query",
  builder: (yargs) =>
    yargs.positional("query", {
      type: "string",
      demandOption: true,
      description: "Search query",
    }),
  handler: Effect.fn("Cli.debug.file.search")(function* (args) {
    const results = yield* Effect.orDie(filesystem(FileSystem.Service.use((svc) => svc.find({ query: args.query }))))
    process.stdout.write(results.map((item) => item.path).join(EOL) + EOL)
  }),
})

const FileReadCommand = effectCmd({
  command: "read <path>",
  describe: "read file contents as JSON",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "File path to read",
    }),
  handler: Effect.fn("Cli.debug.file.read")(function* (args) {
    const file = yield* filesystem(FileSystem.Service.use((svc) => svc.read({ path: RelativePath.make(args.path) })))
    process.stdout.write(
      JSON.stringify(
        { content: Buffer.from(file.content).toString("base64"), encoding: "base64", mime: file.mime },
        null,
        2,
      ) + EOL,
    )
  }),
})

// altimate_change start — upstream_fix: restore debug file status/tree commands
const FileStatusCommand = effectCmd({
  command: "status",
  describe: "show file status information",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.file.status")(function* () {
    const status = yield* Effect.promise(() => File.status())
    process.stdout.write(JSON.stringify(status, null, 2) + EOL)
  }),
})
// altimate_change end

const FileListCommand = effectCmd({
  command: "list <path>",
  describe: "list files in a directory",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      demandOption: true,
      description: "File path to list",
    }),
  handler: Effect.fn("Cli.debug.file.list")(function* (args) {
    const files = yield* filesystem(FileSystem.Service.use((svc) => svc.list({ path: RelativePath.make(args.path) })))
    process.stdout.write(JSON.stringify(files, null, 2) + EOL)
  }),
})

// altimate_change start — upstream_fix: restore debug file status/tree commands
const FileTreeCommand = effectCmd({
  command: "tree [dir]",
  describe: "show directory tree",
  builder: (yargs) =>
    yargs.positional("dir", {
      type: "string",
      description: "Directory to tree",
      default: process.cwd(),
    }),
  handler: Effect.fn("Cli.debug.file.tree")(function* (args) {
    const files = yield* Effect.promise(() => AppRipgrep.tree({ cwd: args.dir ?? process.cwd(), limit: 200 }))
    process.stdout.write(JSON.stringify(files, null, 2) + EOL)
  }),
})
// altimate_change end

export const FileCommand = cmd({
  command: "file",
  describe: "file system debugging utilities",
  // altimate_change start — upstream_fix: restore debug file status/tree commands
  builder: (yargs) =>
    yargs
      .command(FileReadCommand)
      .command(FileStatusCommand)
      .command(FileListCommand)
      .command(FileSearchCommand)
      .command(FileTreeCommand)
      .demandCommand(),
  // altimate_change end
  async handler() {},
})
