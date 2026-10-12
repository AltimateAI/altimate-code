// altimate_change start — canonical read rules for symlinked search results
import { expect, spyOn, test } from "bun:test"
import { symlinkSync, unlinkSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { readableSearchResults } from "@/altimate/search-read-permissions"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { GlobTool } from "@/tool/glob"
import { GrepTool } from "@/tool/grep"
import { ListTool } from "@/tool/ls"
import { Truncate } from "@/tool/truncate"
import { TestInstance, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    FSUtil.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
  ),
)

const isRoot = process.getuid?.() === 0
if (isRoot) console.warn("Skipping directory-permission test: root bypasses 0o400 restrictions.")

test.skipIf(process.platform === "win32" || isRoot)(
  "unrelated absolute rules do not require resolving allowed search paths",
  async () => {
    await using project = await tmpdir()
    const directory = path.join(project.path, "restricted")
    const file = path.join(directory, "visible.txt")
    await Bun.write(file, "needle public")
    await fs.chmod(directory, 0o400)
    try {
      const permissions = Permission.fromConfig({ read: "allow", edit: { "/unrelated/**": "deny" } })
      expect(readableSearchResults([file], project.path, permissions)).toEqual({
        allowed: new Set([file]),
        patterns: [],
      })
    } finally {
      await fs.chmod(directory, 0o700)
    }
  },
)

for (const action of ["deny", "ask"] as const) {
  for (const kind of ["directory", "file"] as const) {
    test(`absolute read ${action} resolves ${kind} symlink targets and preserves lexical rules`, async () => {
      await using project = await tmpdir()
      await using external = await tmpdir()
      const target = path.join(external.path, "private.txt")
      const link = path.join(project.path, "link")
      const file = kind === "directory" ? path.join(link, "private.txt") : link
      await Bun.write(target, "needle secret")
      await fs.symlink(kind === "directory" ? external.path : target, link, kind === "directory" ? "junction" : "file")

      for (const permission of ["read", "*", "r*"]) {
        const canonicalRules = [
          { permission: "read", pattern: "*", action: "allow" as const },
          { permission, pattern: target, action },
        ]
        expect(readableSearchResults([file], project.path, canonicalRules)).toEqual({
          allowed: new Set(action === "deny" ? [] : [file]),
          patterns: action === "ask" ? [target] : [],
        })
      }

      for (const pattern of [file, path.relative(project.path, file)]) {
        const lexicalRules = Permission.fromConfig({ read: { "*": "allow", [pattern]: action, [target]: "allow" } })
        expect(readableSearchResults([file], project.path, lexicalRules)).toEqual({
          allowed: new Set(action === "deny" ? [] : [file]),
          patterns: action === "ask" ? [pattern] : [],
        })
      }
    })
  }

  for (const name of ["grep", "glob", "list"] as const) {
    it.instance(`${name} applies absolute read ${action} after allowing an external symlink root`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const external = yield* tmpdirScoped()
        const target = path.join(external, "private.txt")
        const link = path.join(instance.directory, "link")
        yield* Effect.promise(async () => {
          await Bun.write(target, "needle secret")
          await Bun.write(path.join(external, "public.txt"), "needle public")
          await fs.symlink(external, link, "junction")
        })
        const requests: PermissionV1.Request["patterns"][] = []
        const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          { pattern: name === "grep" ? "needle" : "*.txt", path: link },
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            permissions: Permission.fromConfig({ "*": "allow", read: { "*": "allow", [target]: action } }),
            metadata: () => Effect.void,
            ask: (req) =>
              Effect.sync(() => {
                if (req.permission === "read") {
                  expect(req.always).toEqual(req.patterns)
                  requests.push(req.patterns)
                }
              }),
          },
        )
        expect(result.output).toContain("public.txt")
        expect(result.metadata.truncated).toBe(false)
        if (action === "deny") {
          expect(result.output).not.toContain("private.txt")
          expect(result.output).not.toContain("secret")
          expect(requests).toEqual([])
        } else {
          expect(result.output).toContain("private.txt")
          expect(requests).toEqual([[target]])
        }
      }),
    )
  }
}
for (const name of ["grep", "glob", "list"] as const) {
  it.instance(`${name} omits a candidate that becomes a symlink loop and returns ordinary files`, () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const bad = path.join(instance.directory, "loop.txt")
      yield* Effect.promise(async () => {
        await Bun.write(path.join(instance.directory, "first.txt"), "needle first")
        await Bun.write(bad, "needle unavailable")
        await Bun.write(path.join(instance.directory, "last.txt"), "needle last")
      })
      const info = name === "grep" ? yield* GrepTool : name === "glob" ? yield* GlobTool : yield* ListTool
      const tool = yield* info.init()
      const resolve = FSUtil.resolve
      let raced = false
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(FSUtil, "resolve").mockImplementation((file) => {
            if (file === bad && !raced) {
              // Change the discovered file before canonicalisation, as a filesystem race can.
              unlinkSync(bad)
              symlinkSync(bad, bad, "file")
              raced = true
            }
            return resolve(file)
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      const requests: PermissionV1.Request["patterns"][] = []
      const result = yield* tool.execute(
        { pattern: name === "grep" ? "needle" : "*.txt", path: instance.directory },
        {
          sessionID: SessionID.make("ses_test"),
          messageID: MessageID.make("msg_test"),
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          permissions: Permission.fromConfig({ "*": "allow", read: { "*": "allow", [bad]: "ask" } }),
          metadata: () => Effect.void,
          ask: (req) =>
            Effect.sync(() => {
              if (req.permission === "read") requests.push(req.patterns)
            }),
        },
      )
      expect(raced).toBe(true)
      expect(result.output).toContain("first.txt")
      expect(result.output).toContain("last.txt")
      expect(result.output).not.toContain("loop.txt")
      expect(result.output).not.toContain("unavailable")
      expect(result.metadata.truncated).toBe(false)
      expect(requests).toEqual([])
    }),
  )
}
// altimate_change end
