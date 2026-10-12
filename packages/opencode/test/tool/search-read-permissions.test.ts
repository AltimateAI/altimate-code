// altimate_change start — search result read-permission regressions
import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { ListTool } from "@/tool/ls"
import { readableSearchResults } from "@/altimate/search-read-permissions"
import { GlobTool } from "@/tool/glob"
import { GrepTool } from "@/tool/grep"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer, Ripgrep.defaultLayer,
  Truncate.defaultLayer, Agent.defaultLayer, Git.defaultLayer,
))

const baseContext = {
  sessionID: SessionID.make("ses_test"), messageID: MessageID.make("msg_test"),
  agent: "build", abort: AbortSignal.any([]), messages: [],
  metadata: () => Effect.void,
  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => Effect.sync(() => {
    if (req.permission === "read") throw new Error("Unexpected read approval")
  }),
}

it.effect("unresolved permissions fail closed without prompting", () => Effect.sync(() => {
  expect(readableSearchResults(["/workspace/secret.txt"], "/workspace")).toEqual({
    allowed: new Set(), patterns: [],
  })
}))

it.effect("an absolute allow cannot override the read tool's relative deny or ask", () => Effect.sync(() => {
  for (const action of ["deny", "ask"] as const) {
    const permissions = Permission.fromConfig({ read: {
      "*": "allow", "*.env": action, "/Users/me/proj/*": "allow",
    } })
    expect(Permission.evaluate("read", ".env", permissions).action).toBe(action)
    expect(readableSearchResults(["/Users/me/proj/.env"], "/Users/me/proj", permissions)).toEqual({
      allowed: new Set(action === "deny" ? [] : ["/Users/me/proj/.env"]),
      patterns: action === "ask" ? [".env"] : [],
    })
  }
}))

for (const read of ["allow", "deny"] as const) {
  it.instance(`grep bounds streamed filtering with 20,000 ${read} matches`, () => Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, "many.txt")
    yield* Effect.promise(() => Bun.write(file, "needle\n".repeat(20_000)))
    const ripgrep = yield* Ripgrep.Service
    let filtered = 0
    const info = yield* GrepTool.pipe(Effect.provideService(Ripgrep.Service, {
      ...ripgrep,
      grep: (input) => {
        expect(input.limit).toBe(100)
        expect(input.scanLimit).toBe(10_000)
        expect(input.filterPath).toBeDefined()
        return ripgrep.grep({
          ...input,
          filterPath: (relative) => {
            filtered++
            return input.filterPath!(relative)
          },
        })
      },
    }))
    const tool = yield* info.init()
    const result = yield* tool.execute({ pattern: "needle", path: file }, {
      ...baseContext, permissions: Permission.fromConfig({ "*": "allow", read }),
    })
    expect(filtered).toBe(read === "allow" ? 101 : 10_000)
    expect(result.metadata).toEqual({ matches: read === "allow" ? 100 : 0, truncated: true })
    expect(result.output).toContain("Results truncated")
    if (read === "deny") {
      expect(result.output).toContain("scan limit")
      expect(result.output).not.toContain("many.txt")
      expect(result.output).not.toContain("needle")
    }
  }))
}

for (const name of ["grep", "glob", "list"] as const) {
  describe(`${name} read permissions`, () => {
    for (const count of name === "grep" ? [2, 101] : [2]) {
      it.instance(`allow-everything preserves the pre-filter output bytes (${count} results)`, () => Effect.gen(function* () {
        const instance = yield* TestInstance
        const search = path.join(instance.directory, "matches")
        const file = path.join(search, "visible.txt")
        const other = path.join(search, "other.txt")
        yield* Effect.promise(async () => {
          await Bun.write(file, count === 2 ? "needle visible\nneedle second line"
            : Array.from({ length: count }, (_, n) => `needle ${n + 1}`).join("\n"))
          await Bun.write(other, "unmatched content")
          // Distinct fixed mtimes make glob's newest-first ordering deterministic.
          await fs.utimes(file, 1000, 1000)
          await fs.utimes(other, 2000, 2000)
        })
        const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "*.txt", path: search }, {
          ...baseContext, permissions: Permission.fromConfig({ "*": "allow" }),
        })
        // Captured by executing the pre-v8 tools at f0f3c8ff8427 against this fixture
        // and comparing their output bytes and metadata with the current tools.
        // Ripgrep retains matched-line newlines, including the blank lines below.
        const before = name === "grep"
          ? count === 2
            ? `Found 2 matches\n${file}:\n  Line 1: needle visible\n\n  Line 2: needle second line`
            : `Found 100 matches (more matches available)\n${file}:\n`
              + Array.from({ length: 100 }, (_, n) => `  Line ${n + 1}: needle ${n + 1}`).join("\n\n")
              + "\n\n\n(Results truncated. Consider using a more specific path or pattern.)"
          : name === "glob" ? `${other}\n${file}` : `${search}/\n  other.txt\n  visible.txt\n`
        expect(Buffer.from(result.output)).toEqual(Buffer.from(before))
        expect(result.metadata).toEqual(name === "grep"
          ? { matches: Math.min(count, 100), truncated: count > 100 }
          : { count: 2, truncated: false })
        expect(result.title).toBe(name === "grep" ? "Searching needle" : name === "glob" ? "Searching *.txt" : "Listing matches")
      }))
    }

    it.instance("over 100 denied results cannot starve allowed rows or reveal truncation", () => Effect.gen(function* () {
      const instance = yield* TestInstance
      const search = path.join(instance.directory, "matches")
      yield* Effect.promise(() => Promise.all([
        ...Array.from({ length: 120 }, (_, n) => Bun.write(path.join(search, `denied-${n}.txt`), "needle secret")),
        Bun.write(path.join(search, "visible.txt"), "needle visible\nneedle second line"),
      ]))
      const permissions = Permission.fromConfig({ "*": "allow", read: {
        "*": "allow", [path.join(search, "denied-*")]: "deny",
      } })
      const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "*.txt", path: search }, { ...baseContext, permissions })
      expect(result.output).toContain("visible.txt")
      expect(result.output).not.toContain("denied-")
      expect(result.output).not.toContain("secret")
      expect(result.output).not.toContain("more matches")
      expect(result.output).not.toContain("truncated")
      expect(result.metadata.truncated).toBe(false)
      expect(result.metadata).toEqual(name === "grep" ? { matches: 2, truncated: false } : { count: 1, truncated: false })
    }))

    for (const count of [100, 101]) {
      it.instance(`${count} allowed results determines the cap exactly`, () => Effect.gen(function* () {
        const instance = yield* TestInstance
        const search = path.join(instance.directory, "matches")
        yield* Effect.promise(() => Promise.all(Array.from({ length: count }, (_, n) =>
          Bun.write(path.join(search, `match-${n}.txt`), "needle"),
        )))
        const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "*.txt", path: search }, {
          ...baseContext, permissions: Permission.fromConfig({ "*": "allow" }),
        })
        expect(result.metadata.truncated).toBe(count > 100)
        expect(result.metadata).toEqual(name === "grep"
          ? { matches: 100, truncated: count > 100 }
          : { count: 100, truncated: count > 100 })
      }))
    }

    for (const permissions of [undefined, []]) {
      for (const config of ["allow", "deny"] as const) {
        it.instance(`${permissions ? "empty" : "undefined"} permissions use the agent's ${config} config`, () => Effect.gen(function* () {
          const instance = yield* TestInstance
          const search = path.join(instance.directory, "matches")
          yield* Effect.promise(() => Bun.write(path.join(search, "visible.txt"), "needle"))
          const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
          const tool = yield* info.init()
          const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "*.txt", path: search }, { ...baseContext, permissions })
          expect(result.output.includes("visible.txt")).toBe(config === "allow")
        }), { config: { permission: { "*": "allow", read: config } } })
      }
    }

    it.instance("unknown agent and absent permissions fail closed", () => Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(instance.directory, "hidden.txt"), "needle"))
      const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "*.txt", path: instance.directory }, { ...baseContext, agent: "missing-agent" })
      expect(result.output).not.toContain("hidden.txt")
      expect(result.metadata.truncated).toBe(false)
    }))

    it.instance("batched approval contains only ask paths and persists those exact paths", () => Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.promise(() => Promise.all(["allowed", "ask", "denied"].map((file) =>
        Bun.write(path.join(instance.directory, `${file}.txt`), "needle"),
      )))
      const requested: PermissionV1.Request["patterns"][] = []
      const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "*.txt", path: instance.directory }, {
        ...baseContext,
        permissions: Permission.fromConfig({ "*": "allow", read: {
          "*": "allow", [path.join(instance.directory, "ask.txt")]: "ask", [path.join(instance.directory, "denied.txt")]: "deny",
        } }),
        ask: (req) => Effect.sync(() => {
          if (req.permission !== "read") return
          expect(req.always).toEqual(req.patterns)
          requested.push(req.patterns)
        }),
      })
      expect(requested).toEqual([[path.join(instance.directory, "ask.txt")]])
      expect(result.output).toContain("allowed.txt")
      expect(result.output).toContain("ask.txt")
      expect(result.output).not.toContain("denied.txt")
    }))

    it.instance("batched approval excludes lookahead paths and rows beyond the result cap", () => Effect.gen(function* () {
      const instance = yield* TestInstance
      const search = path.join(instance.directory, "matches")
      const files = Array.from({ length: 150 }, (_, n) => path.join(search, `match-${n}.txt`))
      yield* Effect.promise(() => Promise.all(files.map((file) => Bun.write(file, "needle"))))
      const requested: PermissionV1.Request["patterns"][] = []
      const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "*.txt", path: search }, {
        ...baseContext,
        permissions: Permission.fromConfig({ "*": "allow", read: { [path.join(search, "*")]: "ask" } }),
        ask: (req) => Effect.sync(() => {
          if (req.permission !== "read") return
          expect(req.always).toEqual(req.patterns)
          requested.push(req.patterns)
        }),
      })
      const returned = files.filter((file) => result.output.includes(name === "list" ? path.basename(file) : file))
      expect(returned).toHaveLength(100)
      expect(result.metadata.truncated).toBe(true)
      expect(requested).toHaveLength(1)
      expect(requested[0]!.toSorted()).toEqual(returned.toSorted())
    }))

    for (const mode of ["deny", "relative-deny", "allow", "ask", "all-denied"] as const) {
      it.instance(`${mode} applies to each result path`, () => Effect.gen(function* () {
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const mine = path.join(instance.directory, "mine", "visible.txt")
        const other = path.join(instance.directory, "other-run", "hidden.txt")
        yield* Effect.promise(() => Promise.all([
          Bun.write(mine, "needle visible\nneedle second line"),
          Bun.write(other, "needle secret"),
        ]))
        const permissions = Permission.fromConfig({
          "*": "allow",
          read: mode === "allow" ? "allow" : mode === "all-denied" ? "deny" : {
            "*": mode === "ask" ? "ask" : "allow",
            [mode === "relative-deny" ? path.relative(context.worktree, path.join(instance.directory, "other-run", "**")) : path.join(instance.directory, "other-run", "**")]: "deny",
          },
        })
        const requests: PermissionV1.Request["patterns"][] = []
        const ctx = {
          sessionID: SessionID.make("ses_test"), messageID: MessageID.make("msg_test"),
          agent: "build", abort: AbortSignal.any([]), messages: [], permissions,
          metadata: () => Effect.void,
          ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => Effect.sync(() => {
            if (req.permission !== "read") return
            expect(req.always).toEqual(req.patterns)
            requests.push(req.patterns)
            for (const pattern of req.patterns) {
              expect(Permission.evaluate("read", pattern, permissions).action).toBe("ask")
            }
          }),
        }
        const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "**/*.txt", path: instance.directory }, ctx)
        if (mode === "all-denied") {
          expect(result.output).toBe(name === "list" ? `${instance.directory}/\n` : "No files found")
          expect(requests).toHaveLength(0)
          return
        }
        expect(result.output).toContain(name === "list" ? "visible.txt" : mine)
        if (mode === "allow") expect(result.output).toContain(name === "list" ? "hidden.txt" : other)
        else {
          expect(result.output).not.toContain(name === "list" ? "hidden.txt" : other)
          expect(result.output).not.toContain("needle secret")
        }
        expect(requests).toHaveLength(mode === "ask" ? 1 : 0)
        if (mode === "ask") {
          expect(requests[0]).toEqual([path.relative(context.worktree, mine)])
        }
      }))
    }

    for (const allowForm of ["relative", "absolute"] as const) {
      it.instance(`later ${allowForm} allow cannot override the other path form's deny`, () => Effect.gen(function* () {
        const instance = yield* TestInstance
        const context = yield* InstanceState.context
        const visible = path.join(instance.directory, "restricted", "visible.txt")
        const hidden = path.join(instance.directory, "restricted", "hidden.txt")
        yield* Effect.promise(() => Promise.all([
          Bun.write(visible, "needle restored"),
          Bun.write(hidden, "needle hidden"),
        ]))
        const absoluteDeny = path.join(instance.directory, "restricted", "**")
        const denied = allowForm === "relative" ? absoluteDeny : path.relative(context.worktree, absoluteDeny)
        const allowed = allowForm === "relative" ? path.relative(context.worktree, visible) : visible
        const permissions = Permission.fromConfig({
          "*": "allow",
          read: { "*": "allow", [denied]: "deny", [allowed]: "allow" },
        })
        const requests: PermissionV1.Request["patterns"][] = []
        const ctx = {
          sessionID: SessionID.make("ses_test"), messageID: MessageID.make("msg_test"),
          agent: "build", abort: AbortSignal.any([]), messages: [], permissions,
          metadata: () => Effect.void,
          ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => Effect.sync(() => {
            if (req.permission !== "read") return
            expect(req.always).toEqual(req.patterns)
            requests.push(req.patterns)
            for (const pattern of req.patterns) {
              expect(Permission.evaluate("read", pattern, permissions).action).toBe("allow")
            }
          }),
        }
        const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ pattern: name === "grep" ? "needle" : "**/*.txt", path: instance.directory }, ctx)

        expect(result.output).not.toContain(name === "list" ? "visible.txt" : visible)
        expect(result.output).not.toContain(name === "list" ? "hidden.txt" : hidden)
        expect(result.output).not.toContain("needle hidden")
        expect(requests).toEqual([])
      }))
    }
  })
}
// altimate_change end
