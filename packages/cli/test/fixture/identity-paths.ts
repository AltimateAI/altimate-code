// altimate: ALT-F01
import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { Effect, Logger } from "effect"
import { Git } from "../../../core/src/git"
import { AbsolutePath } from "../../../core/src/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Env } from "@opencode/util/env"
import { Identity } from "@opencode/util/identity"
import { Logging } from "@opencode/util/observability/logging"
import { databasePath } from "../../src/database-path"

const root = process.argv[2]
const suffix = process.argv[3]
const names = ["fresh", "legacy", "v1", "both"]
await Promise.all(names.map((name) => mkdir(path.join(root, name), { recursive: true })))
const legacy = new Database(path.join(root, "legacy", `opencode${suffix}.db`))
legacy.exec("PRAGMA journal_mode=WAL; CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('legacy sentinel')")
const legacyFiles = await readdir(path.join(root, "legacy"))
const before = await Promise.all(legacyFiles.map((file) => Bun.file(path.join(root, "legacy", file)).bytes()))
await Bun.write(path.join(root, "v1", "opencode.db"), "v1 sentinel")
await Bun.write(path.join(root, "both", `opencode${suffix}.db`), "legacy sentinel")
await Bun.write(path.join(root, "both", `${Identity.app}${suffix}.db`), "selected sentinel")

const databases = Object.fromEntries(names.map((name) => [name, inspect(path.join(root, name))]))
process.env[Env.keys("OPENCODE_DB")[0]] = `opencode${suffix}.db`
const explicitLegacy = databasePath(path.join(root, "legacy"))
process.env[Env.keys("OPENCODE_DB")[0]] = path.join(root, "absolute.db")
const absolute = databasePath(root)
process.env[Env.keys("OPENCODE_DB")[0]] = ":memory:"
const memory = databasePath(path.join(root, "legacy"))
delete process.env[Env.keys("OPENCODE_DB")[0]]
const disabled = ["1", "true"].map((value) => {
  process.env[Env.keys("OPENCODE_DISABLE_CHANNEL_DB")[0]] = value
  return databasePath(path.join(root, "fresh"))
})

const storage = path.join(root, "snapshot")
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const git = yield* Git.Service
      yield* git.repo.create({ worktree: AbsolutePath.make(root), gitDirectory: AbsolutePath.make(storage) })
      yield* git.repo.create({ worktree: AbsolutePath.make(root), gitDirectory: AbsolutePath.make(storage) })
    }).pipe(Effect.provide(LayerNode.compile(Git.node)), Effect.provide(Logger.layer([]))),
  ),
)

const after = await Promise.all(legacyFiles.map((file) => Bun.file(path.join(root, "legacy", file)).bytes()))
console.log(
  JSON.stringify({
    databases,
    explicitLegacy,
    absolute,
    memory,
    disabled,
    preserved: legacy.query<{ value: string }, []>("SELECT value FROM sentinel").get()?.value,
    legacyUnchanged: after.every((bytes, index) => Buffer.from(bytes).equals(before[index])),
    legacyFiles: await readdir(path.join(root, "legacy")),
    logs: [Logging.file(false), Logging.file(true, "local"), Logging.file(true, "preview/branch")],
    snapshotFiles: await readdir(storage),
    snapshotConfig: await Bun.file(path.join(storage, "config")).text(),
  }),
)
legacy.close()

function inspect(data: string) {
  try {
    return { path: databasePath(data) }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { error: error.message }
  }
}
