import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { isUnboundedScanRoot } from "@opencode-ai/core/filesystem/scan-root"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Ripgrep.defaultLayer)

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make(path.join("src", "match.ts"))])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make(path.join("src", "match.ts")))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

// Regression: fff (the native file picker) aborts the process with SIGTRAP when basePath is an
// unbounded root (home dir / filesystem root), crashing the TUI when launched from ~. defaultLayer
// must route those roots to the bounded ripgrep layer. See packages/core/src/filesystem/search.ts.
describe("isUnboundedScanRoot (fff SIGTRAP guard)", () => {
  test("flags the home directory", () => {
    expect(isUnboundedScanRoot(os.homedir())).toBe(true)
  })
  test("flags the filesystem root", () => {
    expect(isUnboundedScanRoot(path.parse(process.cwd()).root)).toBe(true)
  })
  test("does not flag an ordinary project directory under home", () => {
    expect(isUnboundedScanRoot(path.join(os.homedir(), "code", "my-project"))).toBe(false)
  })
  test("does not flag a nested temp project directory", () => {
    expect(isUnboundedScanRoot(path.join(os.tmpdir(), "altimate-proj-xyz"))).toBe(false)
  })
})
