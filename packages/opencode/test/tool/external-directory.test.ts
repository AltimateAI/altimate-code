import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect, assertExternalDirectoryLegacy } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Instance } from "../../src/project/instance"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("no-ops for paths inside the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "file.txt"))

      expect(requests.length).toBe(0)
    }),
  )

  if (process.platform !== "win32") {
    it.instance("asks when '..' after a link inside the project leads outside it", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const outside = fs.realpathSync(yield* tmpdirScoped())
        fs.mkdirSync(path.join(outside, "deep"))
        fs.symlinkSync(path.join(outside, "deep"), path.join(test.directory, "link"))
        // Written by hand so ".." follows the link, as the kernel does. The lexical spelling
        // (<project>/file.txt) exists, which is what made whole-path realpath call it in-project.
        fs.writeFileSync(path.join(test.directory, "file.txt"), "decoy")
        fs.writeFileSync(path.join(outside, "file.txt"), "outside")
        const target = `${test.directory}/link/../file.txt`
        const expected = glob(path.join(outside, "*"))

        const { requests, ctx } = makeCtx()
        yield* assertExternalDirectoryEffect(ctx, target)
        expect(requests[0]?.patterns.at(-1)).toBe(expected)

        const legacy: string[][] = []
        const instance = yield* InstanceState.context
        yield* Effect.promise(() =>
          Instance.restore(instance, () =>
            assertExternalDirectoryLegacy(
              { ...baseCtx, metadata: () => {}, ask: async (req) => void legacy.push([...req.patterns]) },
              target,
            ),
          ),
        )
        expect(legacy[0]?.at(-1)).toBe(expected)

        // A link in the project whose target does not exist yet: a write through it lands outside.
        fs.symlinkSync(path.join(outside, "new.txt"), path.join(test.directory, "dangling"))
        const dangling = makeCtx()
        yield* assertExternalDirectoryEffect(dangling.ctx, path.join(test.directory, "dangling"))
        expect(dangling.requests[0]?.patterns.at(-1)).toBe(expected)
      }),
    )
  }

  it.instance("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside", "file.txt")
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* assertExternalDirectoryEffect(ctx, target)

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.instance("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside")
      const expected = glob(path.join(target, "*"))

      yield* assertExternalDirectoryEffect(ctx, target, { kind: "directory" })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

      expect(requests.length).toBe(0)
    }),
  )

  if (process.platform !== "win32") {
    it.instance("also asks for the resolved directory of a symlink that points elsewhere", () =>
      Effect.gen(function* () {
        const outerTmp = fs.realpathSync(yield* tmpdirScoped())
        const allowed = path.join(outerTmp, "allowed")
        const elsewhere = path.join(outerTmp, "elsewhere")
        fs.mkdirSync(allowed)
        fs.mkdirSync(elsewhere)
        fs.writeFileSync(path.join(elsewhere, "secret.txt"), "x")
        fs.symlinkSync(elsewhere, path.join(allowed, "linked-dir"))
        fs.symlinkSync(path.join(elsewhere, "secret.txt"), path.join(allowed, "linked-file.txt"))
        fs.symlinkSync(path.join(elsewhere, "not-yet.txt"), path.join(allowed, "dangling.txt"))

        for (const target of [path.join(allowed, "linked-dir", "secret.txt"), path.join(allowed, "linked-file.txt")]) {
          const { requests, ctx } = makeCtx()
          yield* assertExternalDirectoryEffect(ctx, target)
          const expected = [glob(path.join(path.dirname(target), "*")), glob(path.join(elsewhere, "*"))]
          expect(requests[0]!.patterns, target).toEqual(expected)
          expect(requests[0]!.always, target).toEqual(expected)
        }

        // A directory reached through the link (grep), a file in a subdirectory that does not exist
        // yet (write), and ".." after the link all resolve to where the kernel would go.
        const cases: Array<[string, "file" | "directory", string]> = [
          [path.join(allowed, "linked-dir"), "directory", elsewhere],
          [
            path.join(allowed, "linked-dir", "new", "deeper", "file.txt"),
            "file",
            path.join(elsewhere, "new", "deeper"),
          ],
          // Written by hand: path.join would collapse the ".." before the link is followed.
          [`${allowed}/linked-dir/../file.txt`, "file", outerTmp],
          // A link whose target does not exist yet: a write through it lands in the target's directory.
          [path.join(allowed, "dangling.txt"), "file", elsewhere],
        ]
        for (const [target, kind, real] of cases) {
          const { requests, ctx } = makeCtx()
          yield* assertExternalDirectoryEffect(ctx, target, { kind })
          expect(requests[0]!.patterns.at(-1), target).toBe(glob(path.join(real, "*")))
        }

        // glob and ls use the Promise-based variant; it asks for the resolved directory too.
        const legacy: string[][] = []
        const instance = yield* InstanceState.context
        yield* Effect.promise(() =>
          Instance.restore(instance, () =>
            assertExternalDirectoryLegacy(
              { ...baseCtx, metadata: () => {}, ask: async (req) => void legacy.push([...req.patterns]) },
              path.join(allowed, "linked-dir"),
              { kind: "directory" },
            ),
          ),
        )
        expect(legacy).toEqual([[glob(path.join(allowed, "linked-dir", "*")), glob(path.join(elsewhere, "*"))]])

        // A plain file in the allowed directory asks only for that directory.
        fs.writeFileSync(path.join(allowed, "plain.txt"), "x")
        const { requests, ctx } = makeCtx()
        yield* assertExternalDirectoryEffect(ctx, path.join(allowed, "plain.txt"))
        expect(requests[0]!.patterns).toEqual([glob(path.join(allowed, "*"))])
      }),
    )
  }

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})
