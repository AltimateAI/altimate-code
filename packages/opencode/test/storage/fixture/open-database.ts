// Child process for concurrent-open.test.ts: opens both database layers against the shared data directory.
import { Effect } from "effect"
import { Database } from "../../../src/storage/db"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"

try {
  Database.Client()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* CoreDatabase.Service
      }).pipe(Effect.provide(CoreDatabase.layerFromPath(Database.Path))),
    ),
  )
  console.log("opened")
} catch (error) {
  console.log("FAILED: " + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}
