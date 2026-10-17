// altimate_change start — sandboxed analyst Python execution regression coverage
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { SessionID, MessageID } from "../../../src/session/schema"
import {
  PythonExecTool,
  childEnv,
  clampTimeout,
  clip,
  networkIsolation,
  pythonExecAvailable,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  WORKSPACE_LIMIT_BYTES,
} from "../../../src/altimate/tools/python-exec"
import { getScratch, closeScratch } from "../../../src/altimate/native/connections/scratch"
import { initTool } from "../tool-fixture"
import { tmpdir } from "../../fixture/fixture"

const ctx = {
  sessionID: SessionID.make("ses_python_exec"),
  messageID: MessageID.make("msg_python_exec"),
  callID: "",
  agent: "analyst",
  abort: AbortSignal.any([]),
  messages: [] as any[],
  metadata: () => {},
  ask: async () => {},
}

// Resolve version-manager shims before the tool removes the parent's HOME and PATH.
const probe = spawnSync(
  process.env.ALTIMATE_PYTHON || "python3",
  ["-I", "-c", "import duckdb, pandas, sys; print(sys.executable)"],
  {
    encoding: "utf8",
    timeout: 10_000,
  },
)
const python = probe.status === 0 ? probe.stdout.trim() : ""
const e2e = python ? test : test.skip

let previous: Record<string, string | undefined> = {}

beforeAll(() => {
  previous = {
    ALTIMATE_PYTHON: process.env.ALTIMATE_PYTHON,
    ALTIMATE_PYTHON_EXEC: process.env.ALTIMATE_PYTHON_EXEC,
    ALTIMATE_TELEMETRY_DISABLED: process.env.ALTIMATE_TELEMETRY_DISABLED,
    PYEXEC_TEST_SECRET: process.env.PYEXEC_TEST_SECRET,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
  }
  if (python) process.env.ALTIMATE_PYTHON = python
  delete process.env.ALTIMATE_PYTHON_EXEC
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  process.env.PYEXEC_TEST_SECRET = "python-exec-test-do-not-leak"
  process.env.AWS_SECRET_ACCESS_KEY = "python-exec-test-fake-credential"
  process.env.DATABASE_URL = "postgres://python-exec-test-fake-connection"
})

afterEach(async () => {
  await closeScratch()
})

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("python_exec helpers", () => {
  test("discovery reports an unavailable interpreter", async () => {
    const original = process.env.ALTIMATE_PYTHON
    await using directory = await tmpdir()
    try {
      process.env.ALTIMATE_PYTHON = path.join(directory.path, "missing-python")
      expect(await pythonExecAvailable()).toBe(false)
    } finally {
      if (original === undefined) delete process.env.ALTIMATE_PYTHON
      else process.env.ALTIMATE_PYTHON = original
    }
  })

  e2e(
    "discovery requires pandas and duckdb in the isolated interpreter",
    async () => {
      const original = process.env.ALTIMATE_PYTHON
      await using directory = await tmpdir()
      const setup = spawnSync(python, ["-m", "venv", "--without-pip", directory.path], {
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(setup.status).toBe(0)
      try {
        process.env.ALTIMATE_PYTHON = path.join(
          directory.path,
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
        )
        expect(await pythonExecAvailable()).toBe(false)
      } finally {
        if (original === undefined) delete process.env.ALTIMATE_PYTHON
        else process.env.ALTIMATE_PYTHON = original
      }
    },
    15_000,
  )

  e2e(
    "discovery accepts the configured interpreter and respects the disable flag",
    async () => {
      const original = process.env.ALTIMATE_PYTHON_EXEC
      try {
        delete process.env.ALTIMATE_PYTHON_EXEC
        expect(await pythonExecAvailable()).toBe(true)
        process.env.ALTIMATE_PYTHON_EXEC = "0"
        expect(await pythonExecAvailable()).toBe(false)
      } finally {
        if (original === undefined) delete process.env.ALTIMATE_PYTHON_EXEC
        else process.env.ALTIMATE_PYTHON_EXEC = original
      }
    },
    15_000,
  )

  test("child environment carries no parent variables", () => {
    const env = childEnv("/tmp/ws")
    expect(env.HOME).toBe("/tmp/ws")
    expect(env).not.toHaveProperty("DATABASE_URL")
    expect(Object.keys(env).some((key) => /AWS|TOKEN|KEY|SECRET|PASSWORD/.test(key))).toBe(false)
  })

  test("timeouts default when empty or invalid and clamp to the ceiling", () => {
    for (const value of [undefined, 0, -1, NaN, Infinity]) expect(clampTimeout(value)).toBe(DEFAULT_TIMEOUT_MS)
    expect(clampTimeout(10 * MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS)
    expect(clampTimeout(5)).toBe(1000)
    expect(clampTimeout(1234.5)).toBe(1234)
  })

  test("long output keeps head and tail", () => {
    const result = clip("a".repeat(100) + "b".repeat(100), 50)
    expect(result.clipped).toBe(true)
    expect(result.text.startsWith("a")).toBe(true)
    expect(result.text.endsWith("b")).toBe(true)
    expect(clip("short", 50)).toEqual({ text: "short", clipped: false })
  })
})

describe("python_exec", () => {
  e2e(
    "loads a scratch table and saves a DataFrame back to the same session",
    async () => {
      const scratch = await getScratch(ctx.sessionID)
      await scratch.execute(
        "CREATE TABLE src AS SELECT * FROM (VALUES (1, 'Alpha  Beta'), (2, 'gamma')) t(id, txt)",
        undefined,
        undefined,
        {
          noLimit: true,
        },
      )
      const tool = await initTool(PythonExecTool)
      const result = await tool.execute(
        {
          code: [
            "from altimate_io import load, save",
            "df = load('src')",
            "df['words'] = df['txt'].str.split().str.len()",
            "save(df, 'parsed')",
            "print(int(df['words'].sum()))",
          ].join("\n"),
          inputs: ["src"],
        },
        ctx,
      )
      expect(result.metadata.ok).toBe(true)
      expect(result.output).toContain("3")
      expect(result.output).toContain("scratch.parsed (2 rows)")
      expect(result.output).toContain(result.metadata.network)
      const rows = (await scratch.execute("SELECT id, words FROM parsed ORDER BY id")).rows
      expect(rows.map((row) => Number(row[1]))).toEqual([2, 1])
    },
    15_000,
  )

  e2e(
    "persists workspace files across calls in one session",
    async () => {
      const tool = await initTool(PythonExecTool)
      const first = await tool.execute(
        { code: "import pickle\nwith open('intermediate.pkl', 'wb') as f:\n    pickle.dump({'answer': 42}, f)" },
        ctx,
      )
      expect(first.metadata.ok).toBe(true)
      expect(first.metadata.workspace).toEndWith(path.join("python", "workspace"))
      const second = await tool.execute(
        {
          code: "import os, pickle\nwith open('intermediate.pkl', 'rb') as f:\n    print(pickle.load(f)['answer'])\nprint(os.getcwd())",
        },
        ctx,
      )
      expect(second.metadata.ok).toBe(true)
      expect(second.metadata.workspace).toBe(first.metadata.workspace)
      expect(second.output).toContain("42")
      expect(second.output).toContain(first.metadata.workspace)
    },
    15_000,
  )

  e2e(
    "keeps different sessions' workspaces separate and removes files when the session closes",
    async () => {
      const tool = await initTool(PythonExecTool)
      const first = await tool.execute(
        { code: "with open('private.txt', 'w') as f:\n    f.write('session-private')" },
        ctx,
      )
      expect(first.metadata.ok).toBe(true)
      const other = { ...ctx, sessionID: SessionID.make("ses_python_exec_other") }
      const second = await tool.execute(
        { code: "from pathlib import Path\nprint(Path('private.txt').exists())" },
        other,
      )
      expect(second.metadata.ok).toBe(true)
      expect(second.metadata.workspace).not.toBe(first.metadata.workspace)
      expect(second.output).toContain("False")
      expect(await fs.readFile(path.join(first.metadata.workspace, "private.txt"), "utf8")).toBe("session-private")
      await closeScratch(ctx.sessionID)
      await expect(fs.stat(first.metadata.workspace)).rejects.toHaveProperty("code", "ENOENT")
      expect((await fs.stat(second.metadata.workspace)).isDirectory()).toBe(true)
    },
    15_000,
  )

  e2e(
    "reports the workspace size cap and permits a later call after clearing oversized files",
    async () => {
      const tool = await initTool(PythonExecTool)
      // truncate creates a sparse file: exercise the real cap without allocating gigabytes.
      const result = await tool.execute(
        { code: `with open('oversized.bin', 'wb') as f:\n    f.truncate(${WORKSPACE_LIMIT_BYTES + 1})` },
        ctx,
      )
      expect(result.metadata.ok).toBe(false)
      expect(result.output).toMatch(/workspace.*(?:size|limit)|(?:size|limit).*workspace/i)
      expect(result.output).toMatch(/exceed|limit/i)
      const next = await tool.execute({ code: "print('workspace recovered')" }, ctx)
      expect(next.metadata.ok).toBe(true)
      expect(next.output).toContain("workspace recovered")
      await expect(fs.stat(path.join(next.metadata.workspace, "oversized.bin"))).rejects.toHaveProperty(
        "code",
        "ENOENT",
      )
    },
    15_000,
  )

  e2e(
    "does not expose parent credentials, connection strings, or other environment variables",
    async () => {
      const tool = await initTool(PythonExecTool)
      const result = await tool.execute({ code: "import os\nprint(dict(os.environ))", inputs: [] }, ctx)
      expect(result.metadata.ok).toBe(true)
      for (const value of ["PYEXEC_TEST_SECRET", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "python-exec-test-"]) {
        expect(result.output).not.toContain(value)
      }
    },
    15_000,
  )

  e2e(
    "does not retain undeclared scratch inputs from an earlier call",
    async () => {
      const scratch = await getScratch(ctx.sessionID)
      await scratch.execute("CREATE TABLE previous_input AS SELECT 42 AS answer", undefined, undefined, {
        noLimit: true,
      })
      const tool = await initTool(PythonExecTool)
      const first = await tool.execute(
        { code: "from altimate_io import load\nprint(load('previous_input'))", inputs: ["previous_input"] },
        ctx,
      )
      expect(first.metadata.ok).toBe(true)
      const second = await tool.execute(
        { code: "from altimate_io import load\nload('previous_input')", inputs: [] },
        ctx,
      )
      expect(second.metadata.ok).toBe(false)
      expect(second.output).toContain("previous_input")
    },
    15_000,
  )

  e2e(
    "rejects path traversal in load and save table names",
    async () => {
      const tool = await initTool(PythonExecTool)
      const result = await tool.execute(
        {
          code: [
            "import pandas as pd",
            "from altimate_io import load, save",
            "for operation in (lambda: load('../escape'), lambda: save(pd.DataFrame({'id': [1]}), '../escape')):",
            "    try:",
            "        operation()",
            "    except ValueError:",
            "        print('REJECTED')",
          ].join("\n"),
        },
        ctx,
      )
      expect(result.metadata.ok).toBe(true)
      expect(result.output.match(/REJECTED/g)).toHaveLength(2)
    },
    15_000,
  )

  e2e(
    "kills code that runs past its deadline",
    async () => {
      const tool = await initTool(PythonExecTool)
      const result = await tool.execute({ code: "import time\ntime.sleep(30)", inputs: [], timeout_ms: 1000 }, ctx)
      expect(result.metadata.ok).toBe(false)
      expect(result.metadata.timedOut).toBe(true)
      expect(result.output).toContain("timed out")
    },
    15_000,
  )

  e2e(
    "does not execute code when the call is already aborted",
    async () => {
      const tool = await initTool(PythonExecTool)
      const result = await tool.execute(
        { code: "print('ABORTED_CODE_EXECUTED')" },
        { ...ctx, abort: AbortSignal.abort() },
      )
      expect(result.metadata.ok).toBe(false)
      expect(result.output).not.toContain("ABORTED_CODE_EXECUTED")
    },
    15_000,
  )

  e2e(
    "reports isolation and blocks network access where isolation is available",
    async () => {
      const isolation = networkIsolation()
      const tool = await initTool(PythonExecTool)
      const code =
        isolation.network === "isolated"
          ? "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 53), timeout=1)\n    print('CONNECTED')\nexcept OSError:\n    print('BLOCKED')"
          : "print('network isolation unavailable')"
      const result = await tool.execute({ code, inputs: [] }, ctx)
      expect(result.metadata.ok).toBe(true)
      expect(result.metadata.network).toBe(isolation.network)
      expect(result.output).toContain(isolation.network)
      if (isolation.network === "isolated") expect(result.output).toContain("BLOCKED")
    },
    15_000,
  )

  test("rejects input names that are not scratch tables", async () => {
    const tool = await initTool(PythonExecTool)
    const result = await tool.execute({ code: "print(1)", inputs: ["main.src; DROP"] }, ctx)
    expect(result.metadata.ok).toBe(false)
    expect(result.output).toContain("not a scratch table name")
  })

  test("rejects empty code", async () => {
    const tool = await initTool(PythonExecTool)
    const result = await tool.execute({ code: "  \n", inputs: [] }, ctx)
    expect(result.metadata.ok).toBe(false)
    expect(result.output).toContain("No code to run")
  })

  e2e(
    "reports a Python error with its traceback",
    async () => {
      const tool = await initTool(PythonExecTool)
      const result = await tool.execute({ code: "raise ValueError('boom')", inputs: [] }, ctx)
      expect(result.metadata.ok).toBe(false)
      expect(result.output).toContain("ValueError: boom")
    },
    15_000,
  )
})
// altimate_change end
