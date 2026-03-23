import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// ─── Helpers for InstructionPrompt.loaded() ─────────────────────────────────

const sid = SessionID.make("test-session")

function makeUserMsg(id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: sid,
      role: "user" as const,
      time: { created: 0 },
      agent: "user",
      model: { providerID: "test" as any, modelID: "test" as any },
      tools: {},
      mode: "",
    } as MessageV2.User,
    parts,
  }
}

function readToolPart(opts: {
  id: string
  messageID: string
  status: "completed" | "running" | "error"
  loaded?: unknown[]
  compacted?: number
}): MessageV2.ToolPart {
  if (opts.status === "completed") {
    return {
      id: PartID.make(opts.id),
      sessionID: sid,
      messageID: MessageID.make(opts.messageID),
      type: "tool",
      callID: opts.id,
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "file content",
        title: "Read file",
        metadata: opts.loaded !== undefined ? { loaded: opts.loaded } : {},
        time: { start: 0, end: 1, ...(opts.compacted !== undefined ? { compacted: opts.compacted } : {}) },
      },
    } as MessageV2.ToolPart
  }
  if (opts.status === "running") {
    return {
      id: PartID.make(opts.id),
      sessionID: sid,
      messageID: MessageID.make(opts.messageID),
      type: "tool",
      callID: opts.id,
      tool: "read",
      state: {
        status: "running",
        input: {},
        time: { start: 0 },
      },
    } as MessageV2.ToolPart
  }
  return {
    id: PartID.make(opts.id),
    sessionID: sid,
    messageID: MessageID.make(opts.messageID),
    type: "tool",
    callID: opts.id,
    tool: "read",
    state: {
      status: "error",
      input: {},
      error: "read failed",
      time: { start: 0, end: 1 },
    },
  } as MessageV2.ToolPart
}

function nonReadToolPart(opts: {
  id: string
  messageID: string
  tool: string
  loaded?: unknown[]
}): MessageV2.ToolPart {
  return {
    id: PartID.make(opts.id),
    sessionID: sid,
    messageID: MessageID.make(opts.messageID),
    type: "tool",
    callID: opts.id,
    tool: opts.tool,
    state: {
      status: "completed",
      input: {},
      output: "done",
      title: "Tool done",
      metadata: opts.loaded !== undefined ? { loaded: opts.loaded } : {},
      time: { start: 0, end: 1 },
    },
  } as MessageV2.ToolPart
}

// ─── InstructionPrompt.loaded() ─────────────────────────────────────────────

describe("InstructionPrompt.loaded", () => {
  test("returns empty set for messages with no tool parts", () => {
    const textPart = {
      id: PartID.make("p1"),
      sessionID: sid,
      messageID: MessageID.make("m1"),
      type: "text",
      content: "hello",
    } as unknown as MessageV2.Part
    const result = InstructionPrompt.loaded([makeUserMsg("m1", [textPart])])
    expect(result.size).toBe(0)
  })

  test("extracts paths from completed read tool parts with loaded metadata", () => {
    const part = readToolPart({
      id: "p1",
      messageID: "m1",
      status: "completed",
      loaded: ["/project/subdir/AGENTS.md", "/project/lib/AGENTS.md"],
    })
    const result = InstructionPrompt.loaded([makeUserMsg("m1", [part])])
    expect(result.size).toBe(2)
    expect(result.has("/project/subdir/AGENTS.md")).toBe(true)
    expect(result.has("/project/lib/AGENTS.md")).toBe(true)
  })

  test("skips compacted tool parts", () => {
    const part = readToolPart({
      id: "p1",
      messageID: "m1",
      status: "completed",
      loaded: ["/project/AGENTS.md"],
      compacted: 12345,
    })
    const result = InstructionPrompt.loaded([makeUserMsg("m1", [part])])
    expect(result.size).toBe(0)
  })

  test("skips non-read tool parts even with loaded metadata", () => {
    const part = nonReadToolPart({
      id: "p1",
      messageID: "m1",
      tool: "bash",
      loaded: ["/project/AGENTS.md"],
    })
    const result = InstructionPrompt.loaded([makeUserMsg("m1", [part])])
    expect(result.size).toBe(0)
  })

  test("skips non-completed read tool parts", () => {
    const runningPart = readToolPart({ id: "p1", messageID: "m1", status: "running" })
    const errorPart = readToolPart({ id: "p2", messageID: "m1", status: "error" })
    const result = InstructionPrompt.loaded([makeUserMsg("m1", [runningPart, errorPart])])
    expect(result.size).toBe(0)
  })

  test("filters out non-string entries in the loaded array", () => {
    const part = readToolPart({
      id: "p1",
      messageID: "m1",
      status: "completed",
      loaded: ["/valid/path", 42, null, { nested: true }, "/another/path", undefined],
    })
    const result = InstructionPrompt.loaded([makeUserMsg("m1", [part])])
    expect(result.size).toBe(2)
    expect(result.has("/valid/path")).toBe(true)
    expect(result.has("/another/path")).toBe(true)
  })

  test("deduplicates paths across multiple messages", () => {
    const part1 = readToolPart({
      id: "p1",
      messageID: "m1",
      status: "completed",
      loaded: ["/project/AGENTS.md"],
    })
    const part2 = readToolPart({
      id: "p2",
      messageID: "m2",
      status: "completed",
      loaded: ["/project/AGENTS.md", "/project/lib/AGENTS.md"],
    })
    const result = InstructionPrompt.loaded([makeUserMsg("m1", [part1]), makeUserMsg("m2", [part2])])
    expect(result.size).toBe(2)
    expect(result.has("/project/AGENTS.md")).toBe(true)
    expect(result.has("/project/lib/AGENTS.md")).toBe(true)
  })
})

// ─── InstructionPrompt.resolve ──────────────────────────────────────────────

describe("InstructionPrompt.resolve", () => {
  test("returns empty when AGENTS.md is at project root (already in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
        await Bun.write(path.join(dir, "src", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "AGENTS.md"))).toBe(true)

        const results = await InstructionPrompt.resolve([], path.join(tmp.path, "src", "file.ts"), "test-message-1")
        expect(results).toEqual([])
      },
    })
  })

  test("returns AGENTS.md from subdirectory (not in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(path.join(tmp.path, "subdir", "AGENTS.md"))).toBe(false)

        const results = await InstructionPrompt.resolve(
          [],
          path.join(tmp.path, "subdir", "nested", "file.ts"),
          "test-message-2",
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
      },
    })
  })

  test("doesn't reload AGENTS.md when reading it directly", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filepath = path.join(tmp.path, "subdir", "AGENTS.md")
        const system = await InstructionPrompt.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = await InstructionPrompt.resolve([], filepath, "test-message-2")
        expect(results).toEqual([])
      },
    })
  })
})

describe("InstructionPrompt.systemPaths OPENCODE_CONFIG_DIR", () => {
  let originalConfigDir: string | undefined

  beforeEach(() => {
    originalConfigDir = process.env["OPENCODE_CONFIG_DIR"]
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env["OPENCODE_CONFIG_DIR"]
    } else {
      process.env["OPENCODE_CONFIG_DIR"] = originalConfigDir
    }
  })

  test("prefers OPENCODE_CONFIG_DIR AGENTS.md over global when both exist", async () => {
    await using profileTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Profile Instructions")
      },
    })
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env["OPENCODE_CONFIG_DIR"] = profileTmp.path
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await InstructionPrompt.systemPaths()
          expect(paths.has(path.join(profileTmp.path, "AGENTS.md"))).toBe(true)
          expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(false)
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("falls back to global AGENTS.md when OPENCODE_CONFIG_DIR has no AGENTS.md", async () => {
    await using profileTmp = await tmpdir()
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env["OPENCODE_CONFIG_DIR"] = profileTmp.path
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await InstructionPrompt.systemPaths()
          expect(paths.has(path.join(profileTmp.path, "AGENTS.md"))).toBe(false)
          expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(true)
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("uses global AGENTS.md when OPENCODE_CONFIG_DIR is not set", async () => {
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    delete process.env["OPENCODE_CONFIG_DIR"]
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: async () => {
          const paths = await InstructionPrompt.systemPaths()
          expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(true)
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })
})
