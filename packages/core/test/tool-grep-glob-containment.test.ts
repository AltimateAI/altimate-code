import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import os from "os"
import fsp from "fs/promises"
import nodePath from "path"
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

// Real-symlink containment (REAL realPath, no identity mock). The tests above mock realPath as
// identity, so they cannot catch a symlink bypass. This builds an actual symlink INSIDE the Location
// pointing OUTSIDE and asserts grep cannot read through it — the regression codex found: when
// `input.path = "<symlink-to-outside>/<missing-leaf>"`, realPath(target) failed on the missing leaf
// and fell back to the lexical in-project path, but ripgrep's cwd became dirname(target) = the
// external symlink. The fix contains the ACTUAL cwd via its real path.
describe("GrepTool real-symlink containment (real realPath)", () => {
  let base = ""
  let projectRoot = ""
  beforeAll(async () => {
    base = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "grep-symlink-"))
    projectRoot = nodePath.join(base, "project")
    const outside = nodePath.join(base, "outside")
    await fsp.mkdir(projectRoot)
    await fsp.mkdir(outside)
    await fsp.writeFile(nodePath.join(outside, "secret.txt"), "TOPSECRET-should-never-be-read")
    await fsp.symlink(outside, nodePath.join(projectRoot, "extlink"), "dir") // in-project dir symlink → outside
    await fsp.symlink(nodePath.join(outside, "secret.txt"), nodePath.join(projectRoot, "secretlink"), "file") // file symlink → outside
  })
  afterAll(async () => {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
  })

  // Same ripgrep/permission/registry as above, but REAL FSUtil (real realPath) + Location = the temp
  // project. Location reads projectRoot lazily (Effect.sync) so it's set by beforeAll at run time.
  const realInfra = Layer.mergeAll(
    FSUtil.defaultLayer,
    Layer.effect(
      Location.Service,
      Effect.sync(() => Location.Service.of(location({ directory: AbsolutePath.make(projectRoot) }))),
    ),
    Global.layerWith({ data: Global.Path.data }),
  )
  const realGrepLayer = GrepTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(permission),
    Layer.provide(ripgrep),
    Layer.provide(realInfra),
  )
  const realIt = testEffect(Layer.mergeAll(registry, permission, ripgrep, realInfra, realGrepLayer))

  realIt.effect("dies on <symlink-to-outside>/<missing-leaf> and never invokes ripgrep", () =>
    Effect.gen(function* () {
      grepCalls.length = 0
      const reg = yield* ToolRegistry.Service
      const exit = yield* executeTool(reg, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "g-symlink", name: "grep", input: { pattern: "TOPSECRET", path: "extlink/missing" } },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true) // contained → died
      expect(grepCalls.length).toBe(0) // ripgrep never ran → nothing outside was read
    }),
  )

  realIt.effect("dies when the search root IS an in-project symlink to outside", () =>
    Effect.gen(function* () {
      grepCalls.length = 0
      const reg = yield* ToolRegistry.Service
      const exit = yield* executeTool(reg, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "g-symlink-dir", name: "grep", input: { pattern: "TOPSECRET", path: "extlink" } },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(grepCalls.length).toBe(0)
    }),
  )

  // Single-FILE search through an in-project symlink file pointing outside. stat() follows the symlink
  // and reports "File", so cwd = the (in-project) parent dir and the cwd check passes — but ripgrep
  // would open the symlink and read its external target. The file-level containment must catch it.
  realIt.effect("dies on an in-project symlink FILE pointing outside (file-search bypass)", () =>
    Effect.gen(function* () {
      grepCalls.length = 0
      const reg = yield* ToolRegistry.Service
      const exit = yield* executeTool(reg, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "g-symlink-file", name: "grep", input: { pattern: "TOPSECRET", path: "secretlink" } },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(grepCalls.length).toBe(0)
    }),
  )
})
