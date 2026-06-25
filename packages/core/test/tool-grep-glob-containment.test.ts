import { beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { location } from "./fixture/location"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

// Regression guard for the Kilo CRITICAL on grep.ts (+ its glob.ts twin): a model-controlled
// `input.path` flowed straight into `path.resolve(location.directory, input.path)` and then into
// ripgrep's `cwd`, with NO containment — so an absolute path, a `..` traversal, or a symlink let the
// model read file CONTENTS (grep) or enumerate file NAMES (glob) anywhere on disk, outside the
// Location. The fix rejects any search root whose real (symlink-resolved) path escapes the Location.
// These tests assert the escape DIES before ripgrep is ever invoked, and that in-Location searches
// still reach ripgrep.

const ROOT = AbsolutePath.make(process.cwd())

const grepCalls: string[] = []
const globCalls: string[] = []
const ripgrep = Layer.succeed(
  Ripgrep.Service,
  Ripgrep.Service.of({
    find: () => Effect.succeed([]),
    glob: (input) =>
      Effect.sync(() => {
        globCalls.push(input.cwd)
        return []
      }),
    grep: (input) =>
      Effect.sync(() => {
        grepCalls.push(input.cwd)
        return []
      }),
  }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
// realPath as identity (no symlinks on the test paths) — still exercises the FSUtil.contains rejection.
const testFileSystem = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.use((fs) => Effect.succeed(FSUtil.Service.of({ ...fs, realPath: (path) => Effect.succeed(path) }))),
).pipe(Layer.provide(FSUtil.defaultLayer))
const infrastructure = Layer.mergeAll(
  testFileSystem,
  Layer.succeed(Location.Service, Location.Service.of(location({ directory: ROOT }))),
  Global.layerWith({ data: Global.Path.data }),
)
const grepLayer = GrepTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(ripgrep),
  Layer.provide(infrastructure),
)
const globLayer = GlobTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(ripgrep),
  Layer.provide(infrastructure),
)
const it = testEffect(Layer.mergeAll(registry, permission, ripgrep, infrastructure, grepLayer, globLayer))
const sessionID = SessionV2.ID.make("ses_grep_glob_containment")

const grep = (id: string, input: { pattern: string; path?: string }) =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry.Service
    return yield* executeTool(reg, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id, name: "grep", input },
    }).pipe(Effect.exit)
  })

const glob = (id: string, input: { pattern: string; path?: string }) =>
  Effect.gen(function* () {
    const reg = yield* ToolRegistry.Service
    return yield* executeTool(reg, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id, name: "glob", input },
    }).pipe(Effect.exit)
  })

describe("GrepTool Location containment", () => {
  beforeEach(() => {
    grepCalls.length = 0
  })

  it.effect("searches the Location root when no path is given", () =>
    Effect.gen(function* () {
      const exit = yield* grep("g-default", { pattern: "x" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(grepCalls.length).toBe(1)
      expect(grepCalls[0]!.startsWith(ROOT)).toBe(true)
    }),
  )

  it.effect("searches an in-Location relative subdirectory", () =>
    Effect.gen(function* () {
      const exit = yield* grep("g-sub", { pattern: "x", path: "src" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(grepCalls.length).toBe(1)
      expect(grepCalls[0]!.startsWith(ROOT)).toBe(true)
    }),
  )

  it.effect("dies and never searches when an absolute path escapes the Location", () =>
    Effect.gen(function* () {
      const exit = yield* grep("g-abs", { pattern: "x", path: "/etc" })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(grepCalls.length).toBe(0)
    }),
  )

  it.effect("dies and never searches on a parent-traversal escape", () =>
    Effect.gen(function* () {
      const exit = yield* grep("g-traversal", { pattern: "x", path: "../../../../../../../../etc" })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(grepCalls.length).toBe(0)
    }),
  )
})

describe("GlobTool Location containment", () => {
  beforeEach(() => {
    globCalls.length = 0
  })

  it.effect("globs the Location root when no path is given", () =>
    Effect.gen(function* () {
      const exit = yield* glob("gl-default", { pattern: "*" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(globCalls.length).toBe(1)
      expect(globCalls[0]!.startsWith(ROOT)).toBe(true)
    }),
  )

  it.effect("dies and never globs when an absolute path escapes the Location", () =>
    Effect.gen(function* () {
      const exit = yield* glob("gl-abs", { pattern: "*", path: "/etc" })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(globCalls.length).toBe(0)
    }),
  )

  it.effect("dies and never globs on a parent-traversal escape", () =>
    Effect.gen(function* () {
      const exit = yield* glob("gl-traversal", { pattern: "*", path: "../../../../../../../../etc" })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(globCalls.length).toBe(0)
    }),
  )
})
