import path from "path"
import { Effect, FileSystem } from "effect"

export const writeFileStringScoped = Effect.fn("test.writeFileStringScoped")(function* (file: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, text)
  yield* Effect.addFinalizer(() => fs.remove(file, { force: true }).pipe(Effect.orDie))
  return file
})

/** Create a symlink whose removal is guaranteed by the test scope, even when
 *  an assertion fails mid-test (finalizers run on scope close regardless). */
export const symlinkScoped = Effect.fn("test.symlinkScoped")(function* (target: string, link: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.symlink(target, link)
  yield* Effect.addFinalizer(() => fs.remove(link, { force: true }).pipe(Effect.orDie))
  return link
})
