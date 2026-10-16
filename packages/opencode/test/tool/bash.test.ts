import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir, provideTestInstance, provideTmpdirInstance } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"
import { Truncate } from "../../src/tool/truncation"
import { SessionID, MessageID } from "../../src/session/schema"
import { initTool } from "../altimate/tool-fixture"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Agent } from "../../src/agent/agent"
import { Truncate as TruncateService } from "../../src/tool/truncate"
import { InstanceRef } from "../../src/effect/instance-ref"
import { PermissionEvaluate } from "../../src/permission/evaluate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const evaluateRequest = PermissionEvaluate.evaluateRequest
const it = testEffect(CrossSpawnSpawner.defaultLayer)

// The shared tool fixture stubs Truncate with a no-op so most tool tests don't
// truncate. Truncation tests need the REAL Truncate service, so build the tool
// through the live Truncate layer here instead of going through initTool. The
// layer forks a scoped cleanup fiber, so it must live in a ManagedRuntime (a
// bare Effect.runPromise tears the scope down and interrupts the fiber).
const truncateToolLayer = Layer.mergeAll(Agent.defaultLayer, TruncateService.defaultLayer)
const truncateRuntime = ManagedRuntime.make(truncateToolLayer)
function toEffectValue(value: any): Effect.Effect<void> {
  if (Effect.isEffect(value)) return value as Effect.Effect<void>
  if (value && typeof value.then === "function") return Effect.promise(() => value)
  return Effect.void
}
async function initToolWithTruncate(tool: typeof BashTool) {
  const def = await truncateRuntime.runPromise(
    tool.pipe(Effect.flatMap((info) => info.init())) as Effect.Effect<any, never, any>,
  )
  return {
    ...def,
    execute: (args: any, c: any) => {
      const effectCtx = {
        ...c,
        metadata: (input: any) => toEffectValue(c.metadata?.(input)),
        ask: (input: any) => toEffectValue(c.ask?.(input)),
      }
      // Bridge the ambient Instance ALS (set by Instance.provide in the test) into
      // the Effect InstanceRef so the real Truncate/Agent services resolve.
      const instance = Instance.current
      return truncateRuntime.runPromise(def.execute(args, effectCtx).pipe(Effect.provideService(InstanceRef, instance)))
    },
  }
}

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const projectRoot = path.join(__dirname, "../..")

// Load the instance through the Effect InstanceStore (DB-safe — the legacy Instance.provide path
// re-runs project migrations through src/storage/db.ts which conflicts with the core Database
// migrator on the shared test DB → "table project already exists"), then restore the legacy
// Instance ALS so BashTool (a legacy tool reading Instance.directory) resolves.
async function provideInstance<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  return provideTestInstance({ directory, fn: (instanceCtx) => Instance.restore(instanceCtx, fn) })
}

describe("tool.bash", () => {
  it.live("keeps tool definitions identical across working directories", () =>
    Effect.gen(function* () {
      const definitions = []
      for (let i = 0; i < 2; i++) {
        definitions.push(
          yield* provideTmpdirInstance((directory) =>
            Effect.gen(function* () {
              const instance = yield* InstanceRef
              const bash = yield* Effect.promise(() => Instance.restore(instance!, () => initTool(BashTool)))
              expect(bash.jsonSchema).toBeDefined()
              return { directory, description: bash.description, parameters: JSON.stringify(bash.jsonSchema) }
            }),
          ),
        )
      }
      expect(definitions[0].description).toBe(definitions[1].description)
      expect(definitions[0].parameters).toBe(definitions[1].parameters)
      for (const definition of definitions) {
        expect(definition.description).not.toContain(definition.directory)
        expect(definition.parameters).not.toContain(definition.directory)
      }
    }),
  )

  test("resolves the default working directory at execution and honors workdir", async () => {
    await using first = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "location.txt"), "first directory"),
    })
    await using second = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "location.txt"), "second directory"),
    })
    for (const [directory, expected] of [
      [first.path, "first directory"],
      [second.path, "second directory"],
    ]) {
      await provideInstance(directory, async () => {
        const bash = await initTool(BashTool)
        const result = await bash.execute({ command: "cat location.txt", description: "Read directory fixture" }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(result.output).toBe(expected)
      })
    }
    await provideInstance(first.path, async () => {
      const bash = await initTool(BashTool)
      const result = await bash.execute(
        { command: "cat location.txt", workdir: second.path, description: "Read directory fixture" },
        ctx,
      )
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toBe("second directory")
    })
  })

  test("basic", async () => {
    await provideInstance(projectRoot, async () => {
      const bash = await initTool(BashTool)
      const result = await bash.execute(
        {
          command: "echo 'test'",
          description: "Echo test message",
        },
        ctx,
      )
      expect(result.metadata.exit).toBe(0)
      expect(result.metadata.output).toContain("test")
    })
  })
})

describe("tool.bash permissions", () => {
  test.each([
    ["cat ../sibling/output.md", "cat", "sibling/output.md"],
    ['cat "../sibling/output.md"', "cat", "sibling/output.md"],
    ["cd ../sibling && cat output.md", "cat", "sibling/output.md"],
    ["cd ../sibling; cat output.md", "cat", "sibling/output.md"],
    ["ls ..", "ls", ""],
    ["ls; ls ..", "ls", ""],
    ["cd .. && ls", "ls", ""],
    ["cd ../sibling || exit 1; cat output.md", "cat", "sibling/output.md"],
    ["cd -- ../sibling && cat output.md", "cat", "sibling/output.md"],
    ["cd -P ../sibling && cat output.md", "cat", "sibling/output.md"],
    ["cd ../sibling && cat output.md &", "cat", "sibling/output.md"],
    ["cat -- ../sibling/output.md", "cat", "sibling/output.md"],
    ["chmod -w ../sibling/output.md", "chmod -w", "sibling/output.md"],
    ["cd ../sibling; cd a; cd b; cd c; cd d; cd e; cd f; cat output.md", "cat", "sibling/a/b/c/d/e/f/output.md"],
    ["cd missing; cd ../sibling; cat output.md", "cat", "sibling/output.md"],
  ])("denies normalized paths in %s", async (command, executable, target) => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "workspace"))
    await fs.mkdir(path.join(tmp.path, "sibling"))
    await Bun.write(path.join(tmp.path, "sibling", "output.md"), "private content")
    await provideInstance(path.join(tmp.path, "workspace"), async () => {
      const bash = await initTool(BashTool)
      const absolute = `${executable} ${path.join(tmp.path, target)}`
      const ruleset: PermissionNext.Ruleset = [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "bash", pattern: absolute, action: "deny" },
      ]
      const testCtx = {
        ...ctx,
        ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          for (const pattern of request.patterns) {
            if (evaluateRequest(request, pattern, ruleset).action === "deny") throw new Error("Path denied")
          }
        },
      }
      for (const spelling of [absolute, command]) {
        await expect(bash.execute({ command: spelling, description: "Inspect path" }, testCtx)).rejects.toThrow(
          "Path denied",
        )
      }
    })
  })

  test.each([
    ["cd nested & cat local.txt", "cat nested/local.txt"],
    ["cat 'one two'", "cat one two"],
  ])("does not let an allow rule for a normalized spelling cover %s", async (command, allowedSpelling) => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "nested"))
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const absolute = (value: string) => value.replace(/(\S+)$/, (_, last) => path.join(tmp.path, last))
      const ruleset: PermissionNext.Ruleset = [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "bash", pattern: absolute(allowedSpelling), action: "allow" },
        { permission: "bash", pattern: "cd *", action: "allow" },
      ]
      const testCtx = {
        ...ctx,
        ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          for (const pattern of request.patterns) {
            if (evaluateRequest(request, pattern, ruleset).action !== "allow") throw new Error("Path denied")
          }
        },
      }
      await expect(bash.execute({ command, description: "Read file" }, testCtx)).rejects.toThrow("Path denied")
    })
  })

  test("denies the operand of a command when an option consumes a separate value", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const exact = `mkdir -m 700 ${path.join(tmp.path, "private")}`
      const ruleset: PermissionNext.Ruleset = [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "bash", pattern: exact, action: "deny" },
      ]
      const testCtx = {
        ...ctx,
        ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          for (const pattern of request.patterns) {
            if (evaluateRequest(request, pattern, ruleset).action === "deny") throw new Error("Path denied")
          }
        },
      }
      await expect(bash.execute({ command: "mkdir -m 700 private", description: "Make" }, testCtx)).rejects.toThrow(
        "Path denied",
      )
    })
  })

  test("denies mixed authored and absolute operand spellings and numeric cd targets", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const deny = async (rule: string, command: string) => {
        const ruleset: PermissionNext.Ruleset = [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "bash", pattern: rule, action: "deny" },
        ]
        const testCtx = {
          ...ctx,
          ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            for (const pattern of request.patterns) {
              if (evaluateRequest(request, pattern, ruleset).action === "deny") throw new Error("Path denied")
            }
          },
        }
        await expect(bash.execute({ command, description: "Probe" }, testCtx)).rejects.toThrow("Path denied")
      }
      await deny(`cp public.txt ${path.join(tmp.path, "private.txt")}`, "cp public.txt private.txt")
      await deny(`cat ${path.join(tmp.path, "123", "secret")}`, "cd 123 && cat secret")
      await deny(`cp a b c ${path.join(tmp.path, "dest")}`, "cp a b c dest")
      await deny(`cp a ${path.join(tmp.path, "b")} c d e`, "cp a b c d e")
      await deny(`cat ${path.join(tmp.path, "secret")}`, "cat  secret")
      await deny(`cat ${path.join(tmp.path, "secret$")}`, "cat secret\\$")
      await fs.symlink(os.tmpdir(), path.join(tmp.path, "elsewhere"))
      await deny(`cp * ${path.join(await fs.realpath(os.tmpdir()), "fresh-target")}`, "cp local elsewhere/fresh-target")
    })
  })

  test("denies a symlinked operand by its resolved destination", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "real"))
    await Bun.write(path.join(tmp.path, "real", "key"), "secret")
    await fs.symlink(path.join(tmp.path, "real"), path.join(tmp.path, "link"))
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const ruleset: PermissionNext.Ruleset = [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "bash", pattern: `cat ${await fs.realpath(path.join(tmp.path, "real"))}/key`, action: "deny" },
      ]
      const testCtx = {
        ...ctx,
        ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          for (const pattern of request.patterns) {
            if (evaluateRequest(request, pattern, ruleset).action === "deny") throw new Error("Path denied")
          }
        },
      }
      await expect(bash.execute({ command: "cat link/key", description: "Read" }, testCtx)).rejects.toThrow(
        "Path denied",
      )
    })
  })

  test("keeps directory changes inside subshells and substitutions", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "nested"))
    await Bun.write(path.join(tmp.path, "local.txt"), "local content")
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      for (const command of ["(cd nested); cat local.txt", 'echo "$(cd nested)"; cat local.txt']) {
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        await bash.execute(
          { command, description: "Read local file" },
          {
            ...ctx,
            ask: async (req: (typeof requests)[number]) => {
              requests.push(req)
            },
          },
        )
        const request = requests.find((req) => req.permission === "bash")!
        const ruleset: PermissionNext.Ruleset = [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "bash", pattern: `cat ${path.join(tmp.path, "local.txt")}`, action: "deny" },
        ]
        expect(request.patterns.some((pattern) => evaluateRequest(request, pattern, ruleset).action === "deny")).toBe(
          true,
        )
      }
    })
  })

  test("retains exact relative command allow rules", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "local.txt"), "local content")
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const ruleset: PermissionNext.Ruleset = [
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "cat local.txt", action: "allow" },
      ]
      const result = await bash.execute(
        { command: "cat local.txt", description: "Read local file" },
        {
          ...ctx,
          ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            for (const pattern of request.patterns)
              expect(evaluateRequest(request, pattern, ruleset).action).toBe("allow")
          },
        },
      )
      expect(result.output).toContain("local content")
    })
  })

  test("keeps repeated commands in different directories as separate accesses", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "nested"))
    await Bun.write(path.join(tmp.path, "local.txt"), "private content")
    await Bun.write(path.join(tmp.path, "nested", "local.txt"), "public content")
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const ruleset: PermissionNext.Ruleset = [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "bash", pattern: `cat ${path.join(tmp.path, "local.txt")}`, action: "deny" },
        { permission: "bash", pattern: `cat ${path.join(tmp.path, "nested", "local.txt")}`, action: "allow" },
      ]
      await expect(
        bash.execute(
          {
            command: "cat local.txt; cd nested && cat local.txt",
            description: "Read files in two directories",
          },
          {
            ...ctx,
            ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
              for (const pattern of request.patterns) {
                if (evaluateRequest(request, pattern, ruleset).action === "deny") throw new Error("Path denied")
              }
            },
          },
        ),
      ).rejects.toThrow("Path denied")
    })
  })

  test("checks external_directory for parent listings", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      await expect(
        bash.execute(
          { command: "ls ..", description: "List parent directory" },
          {
            ...ctx,
            ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
              if (request.permission === "external_directory") throw new Error("External directory denied")
            },
          },
        ),
      ).rejects.toThrow("External directory denied")
    })
  })

  test("does not merge distinct raw rules for the same absolute command", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "local.txt"), "private content")
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const ruleset: PermissionNext.Ruleset = [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "cat local.txt", action: "deny" },
        { permission: "bash", pattern: "cat ./local.txt", action: "allow" },
      ]
      await expect(
        bash.execute(
          { command: "cat local.txt; cat ./local.txt", description: "Read local file twice" },
          {
            ...ctx,
            ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
              for (const pattern of request.patterns) {
                if (evaluateRequest(request, pattern, ruleset).action === "deny") throw new Error("Path denied")
              }
            },
          },
        ),
      ).rejects.toThrow("Path denied")
    })
  })

  test("resolves relative workdir from the instance directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "nested"))
    await Bun.write(path.join(tmp.path, "nested", "local.txt"), "nested content")
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const result = await bash.execute(
        {
          command: "cat local.txt",
          workdir: "nested",
          description: "Read nested file",
        },
        ctx,
      )
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("nested content")
    })
  })

  test("asks for bash permission with correct pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute(
        {
          command: "echo hello",
          description: "Echo hello",
        },
        testCtx,
      )
      expect(requests.length).toBe(1)
      expect(requests[0].permission).toBe("bash")
      expect(requests[0].patterns).toContain("echo hello")
    })
  })

  test("asks for bash permission with multiple commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute(
        {
          command: "echo foo && echo bar",
          description: "Echo twice",
        },
        testCtx,
      )
      expect(requests.length).toBe(1)
      expect(requests[0].permission).toBe("bash")
      expect(requests[0].patterns).toContain("echo foo")
      expect(requests[0].patterns).toContain("echo bar")
    })
  })

  test("asks for external_directory permission when cd to parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute(
        {
          command: "cd ../",
          description: "Change to parent directory",
        },
        testCtx,
      )
      const extDirReq = requests.find((r) => r.permission === "external_directory")
      expect(extDirReq).toBeDefined()
    })
  })

  test("asks for external_directory permission when workdir is outside project", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute(
        {
          command: "ls",
          workdir: os.tmpdir(),
          description: "List temp dir",
        },
        testCtx,
      )
      const extDirReq = requests.find((r) => r.permission === "external_directory")
      expect(extDirReq).toBeDefined()
      expect(extDirReq!.patterns).toContain(path.join(os.tmpdir(), "*"))
    })
  })

  test("asks for external_directory permission when file arg is outside project", async () => {
    await using outerTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "outside.txt"), "x")
      },
    })
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      const filepath = path.join(outerTmp.path, "outside.txt")
      await bash.execute(
        {
          command: `cat ${filepath}`,
          description: "Read external file",
        },
        testCtx,
      )
      const extDirReq = requests.find((r) => r.permission === "external_directory")
      const expected = path.join(outerTmp.path, "*")
      expect(extDirReq).toBeDefined()
      expect(extDirReq!.patterns).toContain(expected)
      expect(extDirReq!.always).toContain(expected)
    })
  })

  test("does not ask for external_directory permission when rm inside project", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }

      await Bun.write(path.join(tmp.path, "tmpfile"), "x")

      await bash.execute(
        {
          command: `rm -rf ${path.join(tmp.path, "nested")}`,
          description: "remove nested dir",
        },
        testCtx,
      )

      const extDirReq = requests.find((r) => r.permission === "external_directory")
      expect(extDirReq).toBeUndefined()
    })
  })

  test("includes always patterns for auto-approval", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute(
        {
          command: "git log --oneline -5",
          description: "Git log",
        },
        testCtx,
      )
      expect(requests.length).toBe(1)
      expect(requests[0].always.length).toBeGreaterThan(0)
      expect(requests[0].always.some((p) => p.endsWith("*"))).toBe(true)
    })
  })

  test("does not ask for bash permission when command is cd only", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute(
        {
          command: "cd .",
          description: "Stay in current directory",
        },
        testCtx,
      )
      const bashReq = requests.find((r) => r.permission === "bash")
      expect(bashReq).toBeUndefined()
    })
  })

  test("matches redirects in permission pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute({ command: "cat > /tmp/output.txt", description: "Redirect ls output" }, testCtx)
      const bashReq = requests.find((r) => r.permission === "bash")
      expect(bashReq).toBeDefined()
      expect(bashReq!.patterns).toContain("cat > /tmp/output.txt")
    })
  })

  test("always pattern has space before wildcard to not include different commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
      const testCtx = {
        ...ctx,
        ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
          requests.push(req)
        },
      }
      await bash.execute({ command: "ls -la", description: "List" }, testCtx)
      const bashReq = requests.find((r) => r.permission === "bash")
      expect(bashReq).toBeDefined()
      const pattern = bashReq!.always[0]
      expect(pattern).toBe("ls *")
    })
  })
})

describe("tool.bash truncation", () => {
  test("truncates output exceeding line limit", async () => {
    await provideInstance(projectRoot, async () => {
      const bash = await initToolWithTruncate(BashTool)
      const lineCount = Truncate.MAX_LINES + 500
      const result = await bash.execute(
        {
          command: `seq 1 ${lineCount}`,
          description: "Generate lines exceeding limit",
        },
        ctx,
      )
      expect((result.metadata as any).truncated).toBe(true)
      expect(result.output).toContain("truncated")
      expect(result.output).toContain("The tool call succeeded but the output was truncated")
    })
  })

  test("truncates output exceeding byte limit", async () => {
    await provideInstance(projectRoot, async () => {
      const bash = await initToolWithTruncate(BashTool)
      const byteCount = Truncate.MAX_BYTES + 10000
      const result = await bash.execute(
        {
          command: `head -c ${byteCount} /dev/zero | tr '\\0' 'a'`,
          description: "Generate bytes exceeding limit",
        },
        ctx,
      )
      expect((result.metadata as any).truncated).toBe(true)
      expect(result.output).toContain("truncated")
      expect(result.output).toContain("The tool call succeeded but the output was truncated")
    })
  })

  test("does not truncate small output", async () => {
    await provideInstance(projectRoot, async () => {
      const bash = await initTool(BashTool)
      const result = await bash.execute(
        {
          command: "echo hello",
          description: "Echo hello",
        },
        ctx,
      )
      expect((result.metadata as any).truncated).toBe(false)
      const eol = process.platform === "win32" ? "\r\n" : "\n"
      expect(result.output).toBe(`hello${eol}`)
    })
  })

  test("full output is saved to file when truncated", async () => {
    await provideInstance(projectRoot, async () => {
      const bash = await initToolWithTruncate(BashTool)
      const lineCount = Truncate.MAX_LINES + 100
      const result = await bash.execute(
        {
          command: `seq 1 ${lineCount}`,
          description: "Generate lines for file check",
        },
        ctx,
      )
      expect((result.metadata as any).truncated).toBe(true)

      const filepath = (result.metadata as any).outputPath
      expect(filepath).toBeTruthy()

      const saved = await Filesystem.readText(filepath)
      const lines = saved.trim().split("\n")
      expect(lines.length).toBe(lineCount)
      expect(lines[0]).toBe("1")
      expect(lines[lineCount - 1]).toBe(String(lineCount))
    })
  })
})

// altimate_change start — tests for .opencode/tools/ PATH injection (skill CLI feature)
describe("tool.bash PATH injection", () => {
  test(".opencode/tools/ is prepended to PATH so user tools are executable", async () => {
    await using tmp = await tmpdir({ git: true })
    const toolsDir = path.join(tmp.path, ".opencode", "tools")
    await fs.mkdir(toolsDir, { recursive: true })
    await fs.writeFile(path.join(toolsDir, "my-custom-tool"), '#!/usr/bin/env bash\necho "custom-tool-output"', {
      mode: 0o755,
    })

    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const result = await bash.execute(
        {
          command: "my-custom-tool",
          description: "Run custom tool from .opencode/tools/",
        },
        ctx,
      )
      expect(result.metadata.exit).toBe(0)
      expect(result.metadata.output).toContain("custom-tool-output")
    })
  })

  test(".altimate-code/tools/ is prepended to PATH so user tools are executable", async () => {
    await using tmp = await tmpdir({ git: true })
    const toolsDir = path.join(tmp.path, ".altimate-code", "tools")
    await fs.mkdir(toolsDir, { recursive: true })
    await fs.writeFile(path.join(toolsDir, "my-altimate-tool"), '#!/usr/bin/env bash\necho "altimate-tool-output"', {
      mode: 0o755,
    })

    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const result = await bash.execute(
        {
          command: "my-altimate-tool",
          description: "Run custom tool from .altimate-code/tools/",
        },
        ctx,
      )
      expect(result.metadata.exit).toBe(0)
      expect(result.metadata.output).toContain("altimate-tool-output")
    })
  })

  test("PATH does not contain duplicate .opencode/tools/ entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const toolsDir = path.join(tmp.path, ".opencode", "tools")
    await fs.mkdir(toolsDir, { recursive: true })

    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const result = await bash.execute(
        {
          command: 'echo "$PATH"',
          description: "Print PATH",
        },
        ctx,
      )
      const pathValue = result.metadata.output.trim()
      const sep = process.platform === "win32" ? ";" : ":"
      const entries = pathValue.split(sep)
      const count = entries.filter((e: string) => e === toolsDir).length
      expect(count).toBeLessThanOrEqual(1)
    })
  })

  test("ALTIMATE_BIN_DIR is on PATH with higher priority than system dirs", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideInstance(tmp.path, async () => {
      const bash = await initTool(BashTool)
      const result = await bash.execute(
        {
          command: 'echo "$PATH"',
          description: "Print PATH to check ALTIMATE_BIN_DIR",
        },
        ctx,
      )
      const pathValue = result.metadata.output.trim()
      const binDir = process.env.ALTIMATE_BIN_DIR
      if (binDir) {
        const sep = process.platform === "win32" ? ";" : ":"
        const entries = pathValue.split(sep)
        const binIdx = entries.indexOf(binDir)
        // ALTIMATE_BIN_DIR should appear early in PATH (prepended, not appended)
        expect(binIdx).toBeGreaterThanOrEqual(0)
        expect(binIdx).toBeLessThan(5)
      }
    })
  })
})
// altimate_change end
