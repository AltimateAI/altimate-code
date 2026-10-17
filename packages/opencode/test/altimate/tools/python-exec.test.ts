// altimate_change start — sandboxed analyst Python execution regression coverage
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { SessionID, MessageID } from "../../../src/session/schema"
import {
  PythonExecTool,
  childEnv,
  clampTimeout,
  clip,
  BOOTSTRAP,
  parseProcessTable,
  reconcileDescendants,
  verifiedKillTargets,
  confinementFor,
  pythonExecAvailable,
  resetConfinement,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  WORKSPACE_LIMIT_BYTES,
} from "../../../src/altimate/tools/python-exec"
import * as Sandbox from "../../../src/altimate/tools/python-sandbox"
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
// Tests that run analyst code need a sandbox that works on this host (macOS sandbox-exec, or Linux
// bubblewrap with user namespaces). Without one they are skipped and the refusal test below runs.
const detected = python ? await confinementFor(python) : undefined
const sandboxed = detected?.ok ? test : test.skip
if (python && !detected?.ok)
  console.warn(`python_exec sandbox tests skipped: ${detected && !detected.ok ? detected.reason : "no Python"}`)

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
  sandboxed(
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
      expect(result.output).toMatch(/^3$/m)
      expect(result.output).toContain("scratch.parsed (2 rows)")
      expect(result.output).toContain(result.metadata.network)
      const rows = (await scratch.execute("SELECT id, words FROM parsed ORDER BY id")).rows
      expect(rows.map((row) => Number(row[1]))).toEqual([2, 1])
    },
    15_000,
  )

  sandboxed(
    "keeps the event loop responsive while a cell runs",
    async () => {
      const tool = await initTool(PythonExecTool)
      let worst = 0
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
      }, 10)
      try {
        const result = await tool.execute({ code: "import time\ntime.sleep(2)\nprint('done')" }, ctx)
        expect(result.metadata.ok).toBe(true)
      } finally {
        clearInterval(timer)
      }
      expect(worst).toBeLessThan(250)
    },
    15_000,
  )

  sandboxed(
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

  sandboxed(
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

  sandboxed(
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

  sandboxed(
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

  sandboxed(
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
      expect(second.output).toContain(path.join("in", "previous_input.parquet"))
    },
    15_000,
  )

  sandboxed(
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

  sandboxed(
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

  sandboxed(
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

  sandboxed(
    "reports the confinement mechanism and blocks network access",
    async () => {
      const tool = await initTool(PythonExecTool)
      const code =
        "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 53), timeout=1)\n    print('CONNECTED')\nexcept OSError:\n    print('BLOCKED')"
      const result = await tool.execute({ code, inputs: [] }, ctx)
      expect(result.metadata.ok).toBe(true)
      expect(["sandbox-exec", "bwrap"]).toContain(result.metadata.filesystem)
      expect(result.output).toContain(`filesystem ${result.metadata.filesystem}`)
      expect(result.output).toContain(`network ${result.metadata.network}`)
      if (result.metadata.network === "isolated") expect(result.output).toContain("BLOCKED")
    },
    30_000,
  )

  sandboxed(
    "denies reads of host files outside the allowlist",
    async () => {
      await using elsewhere = await tmpdir()
      const secret = path.join(elsewhere.path, "host-secret.txt")
      await fs.writeFile(secret, "host-secret-contents")
      const targets = [
        secret,
        path.join(os.homedir(), ".ssh", "id_rsa"),
        path.join(os.homedir(), ".ssh"),
        "/etc/hosts",
        "/etc/hostname",
        os.homedir(),
      ]
      const tool = await initTool(PythonExecTool)
      const code = [
        "import os",
        `for target in ${JSON.stringify(targets)}:`,
        "    try:",
        "        data = os.listdir(target) if os.path.isdir(target) else open(target).read()",
        "        print('READ', target, str(data)[:40])",
        "    except OSError:",
        "        print('DENIED', target)",
      ].join("\n")
      const result = await tool.execute({ code, inputs: [] }, ctx)
      expect(result.metadata.ok).toBe(true)
      expect(result.output).not.toContain("READ ")
      expect(result.output).not.toContain("host-secret-contents")
      for (const target of targets) expect(result.output).toContain(`DENIED ${target}`)
    },
    30_000,
  )

  sandboxed(
    "subprocesses inherit the read confinement",
    async () => {
      await using elsewhere = await tmpdir()
      const secret = path.join(elsewhere.path, "subprocess-secret.txt")
      await fs.writeFile(secret, "subprocess-secret-contents")
      const tool = await initTool(PythonExecTool)
      const code = [
        "import subprocess",
        "open('mine.txt', 'w').write('workspace-contents')",
        "print(subprocess.run(['cat', 'mine.txt'], capture_output=True, text=True).stdout)",
        `outside = subprocess.run(['cat', ${JSON.stringify(secret)}], capture_output=True, text=True)`,
        "print('CAT_EXIT', outside.returncode, outside.stdout)",
        `shell = subprocess.run(['/bin/sh', '-c', 'cat ${secret}'], capture_output=True, text=True)`,
        "print('SH_OUT', shell.stdout)",
      ].join("\n")
      const result = await tool.execute({ code, inputs: [] }, ctx)
      expect(result.metadata.ok).toBe(true)
      expect(result.output).toContain("workspace-contents")
      expect(result.output).not.toContain("subprocess-secret-contents")
      expect(result.output).not.toMatch(/CAT_EXIT 0/)
    },
    30_000,
  )

  sandboxed(
    "pandas and duckdb read and write workspace files inside the sandbox",
    async () => {
      const tool = await initTool(PythonExecTool)
      const code = [
        "import duckdb, pandas as pd",
        "pd.DataFrame({'k': ['a', 'b', 'a'], 'v': [1, 2, 3]}).to_parquet('frame.parquet')",
        "print('SUM', duckdb.sql(\"SELECT sum(v) FROM 'frame.parquet' WHERE k = 'a'\").fetchone()[0])",
        "print('ROWS', len(pd.read_parquet('frame.parquet')))",
      ].join("\n")
      const result = await tool.execute({ code, inputs: [] }, ctx)
      expect(result.metadata.ok).toBe(true)
      expect(result.output).toContain("SUM 4")
      expect(result.output).toContain("ROWS 3")
    },
    30_000,
  )

  sandboxed(
    "confines writes to the session workspace",
    async () => {
      const outside = path.join(os.homedir(), `.pyexec-write-probe-${process.pid}`)
      const tool = await initTool(PythonExecTool)
      const code = `import os\ntry:\n    open(${JSON.stringify(outside)}, 'w').write('x')\n    print('WROTE')\nexcept OSError:\n    print('DENIED')\nopen('inside.txt', 'w').write('ok')\nprint('INSIDE_OK')`
      try {
        const result = await tool.execute({ code, inputs: [] }, ctx)
        expect(result.output).toContain("INSIDE_OK")
        expect(result.output).toContain("DENIED")
        await expect(fs.stat(outside)).rejects.toHaveProperty("code", "ENOENT")
      } finally {
        await fs.rm(outside, { force: true })
      }
    },
    30_000,
  )

  sandboxed(
    "refuses to run when no confinement mechanism is available",
    async () => {
      const detect = spyOn(Sandbox, "detectConfinement").mockResolvedValue({
        ok: false,
        reason: "python_exec refused: no enforced filesystem confinement is available (test).",
      })
      resetConfinement()
      try {
        const tool = await initTool(PythonExecTool)
        const result = await tool.execute({ code: "open('ran.txt', 'w').write('x')\nprint('UNCONFINED_RUN')" }, ctx)
        expect(detect).toHaveBeenCalled()
        expect(result.metadata.ok).toBe(false)
        expect(result.output).toContain("python_exec refused")
        expect(result.output).not.toContain("UNCONFINED_RUN")
      } finally {
        detect.mockRestore()
        resetConfinement()
      }
    },
    30_000,
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

  sandboxed(
    "reports a Python error with its traceback",
    async () => {
      const tool = await initTool(PythonExecTool)
      const result = await tool.execute({ code: "raise ValueError('boom')", inputs: [] }, ctx)
      expect(result.metadata.ok).toBe(false)
      expect(result.output).toContain("ValueError: boom")
    },
    15_000,
  )

  sandboxed(
    "returns at the deadline when a session-detached descendant holds stdout open",
    async () => {
      const tool = await initTool(PythonExecTool)
      const started = Date.now()
      const result = await tool.execute(
        {
          code: [
            "import subprocess, time",
            "subprocess.Popen(['sleep', '7331'], start_new_session=True)",
            "time.sleep(60)",
          ].join("\n"),
          timeout_ms: 1000,
        },
        ctx,
      )
      expect(Date.now() - started).toBeLessThan(8000)
      expect(result.metadata.timedOut).toBe(true)
      expect(result.output).toContain("timed out")
      expect(spawnSync("pgrep", ["-f", "sleep 7331"], { encoding: "utf8" }).stdout.trim()).toBe("")
    },
    20_000,
  )

  sandboxed(
    "returns promptly when the cell exits leaving a session-detached descendant on stdout",
    async () => {
      const tool = await initTool(PythonExecTool)
      const started = Date.now()
      const result = await tool.execute(
        {
          code: "import subprocess\nsubprocess.Popen(['sleep', '7332'], start_new_session=True)\nprint('done')",
          timeout_ms: 30_000,
        },
        ctx,
      )
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(result.output).toContain("done")
      spawnSync("pkill", ["-f", "sleep 7332"])
    },
    20_000,
  )

  const unsandboxed = python && !detected?.ok ? test : test.skip
  unsandboxed("python_exec refuses when the host has no working sandbox", async () => {
    const tool = await initTool(PythonExecTool)
    const result = await tool.execute({ code: "print(1)" }, ctx)
    expect(result.metadata.ok).toBe(false)
    expect(result.output).toContain("python_exec refused")
    expect(result.output).toContain("never run unconfined")
  })

  test.skipIf(process.platform !== "darwin" || !detected?.ok)(
    "sandboxed code cannot signal the agent or other host processes",
    async () => {
      const outside = Bun.spawn(["sleep", "7333"])
      try {
        const tool = await initTool(PythonExecTool)
        const result = await tool.execute(
          {
            code: [
              "import os, signal, subprocess",
              "for name, pid in (('parent', os.getppid()), ('other', %d)):" .replace("%d", "OUTSIDE"),
              "    try:",
              "        os.kill(pid, signal.SIGURG)",
              "        print(name, 'SIGNALLED')",
              "    except OSError:",
              "        print(name, 'DENIED')",
              "child = subprocess.Popen(['sleep', '5'])",
              "child.send_signal(signal.SIGURG)",
              "child.kill()",
              "print('child OK')",
            ].join("\n").replace("OUTSIDE", String(outside.pid)),
          },
          ctx,
        )
        expect(result.output).toContain("parent DENIED")
        expect(result.output).toContain("other DENIED")
        expect(result.output).toContain("child OK")
        expect(outside.killed || outside.exitCode !== null).toBe(false)
        expect(process.kill(process.pid, 0)).toBe(true)
      } finally {
        outside.kill()
      }
    },
    20_000,
  )
})
describe("python_exec confinement", () => {
  // Merged-usr host: /bin, /lib and /lib64 are symlinks into /usr, as is /etc/localtime.
  const read = {
    directories: ["/opt/py", "/usr"],
    files: ["/etc/ld.so.cache"],
    links: ["/bin", "/etc/localtime", "/lib", "/lib64"],
  }
  const symlinks: Record<string, string> = {
    "/bin": "usr/bin",
    "/lib": "usr/lib",
    "/lib64": "usr/lib64",
    "/etc/localtime": "../usr/share/zoneinfo/UTC",
  }

  test("bwrap argv binds exactly the allowlist read-only and the session directory writable", () => {
    const args = Sandbox.bwrapArgs(read, ["/tmp/scratch/python"], "/tmp/scratch/python/workspace", {
      readlink: (p: string) => symlinks[p],
    })
    expect(args).toEqual([
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/tmp",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--ro-bind",
      "/etc/ld.so.cache",
      "/etc/ld.so.cache",
      "--ro-bind",
      "/opt/py",
      "/opt/py",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "../usr/share/zoneinfo/UTC",
      "/etc/localtime",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
      "--bind",
      "/tmp/scratch/python",
      "/tmp/scratch/python",
      "--chdir",
      "/tmp/scratch/python/workspace",
    ])
    const binds = args.flatMap((arg, i) => (arg === "--bind" || arg === "--ro-bind" ? [args[i + 1]] : []))
    expect(binds).not.toContain("/")
    expect(binds).not.toContain(os.homedir())
  })

  test("the launched bwrap command runs the interpreter after the sandbox arguments", () => {
    const argv = Sandbox.launch({
      confinement: {
        filesystem: "bwrap",
        network: "isolated",
        prefix: ["/usr/bin/bwrap"],
        read: { ...read, links: [] },
      },
      write: ["/tmp/scratch/python"],
      cwd: "/tmp/scratch/python/workspace",
      python: "/opt/py/bin/python3",
      args: ["/tmp/scratch/python/call/_bootstrap.py", "cell.py", "/tmp/scratch/python/call"],
    })
    expect(argv[0]).toBe("/usr/bin/bwrap")
    expect(argv.slice(argv.indexOf("--"))).toEqual([
      "--",
      "/opt/py/bin/python3",
      "-I",
      "/tmp/scratch/python/call/_bootstrap.py",
      "cell.py",
      "/tmp/scratch/python/call",
    ])
  })

  test("the read allowlist keeps merged-usr symlinks for bwrap and binds their resolved targets", () => {
    const targets: Record<string, string> = {
      "/bin": "/usr/bin",
      "/lib": "/usr/lib",
      "/lib64": "/usr/lib64",
      "/etc/localtime": "/usr/share/zoneinfo/UTC",
    }
    const exists = new Set(["/usr", "/etc/ld.so.cache", "/etc/ld.so.conf", "/opt/py"])
    const result = Sandbox.readAllowlist(
      "linux",
      { roots: ["/opt/py"], libraries: [] },
      {
        home: "/home/u",
        resolve: (p) => targets[p] ?? (exists.has(p) ? p : undefined),
        link: (p) => p in targets,
      },
    )
    expect(result).toEqual({
      ok: true,
      directories: ["/opt/py", "/usr"],
      files: ["/etc/ld.so.cache", "/etc/ld.so.conf"],
      links: ["/bin", "/etc/localtime", "/lib", "/lib64"],
    })
  })

  test("the macOS profile denies reads, writes, network and services outside the allowlist", () => {
    const profile = Sandbox.sandboxProfile({ directories: ["/opt/py"], files: ["/", "/dev/null"], links: [] }, [
      "/private/tmp/s",
    ])
    expect(profile).toContain("(deny network*)")
    expect(profile).toContain("(deny appleevent-send)")
    expect(profile).toContain("(deny signal)")
    expect(profile).toContain("(allow signal (target self) (target children))")
    expect(profile).toMatch(/\(deny mach-lookup \(require-not/)
    expect(profile).toMatch(/\(deny file-read\* \(require-not \(require-any [^\n]*\(subpath "\/opt\/py"\)/)
    expect(profile).toMatch(/\(deny file-write\* \(require-not \(require-any \(subpath "\/private\/tmp\/s"\)/)
    expect(profile).not.toContain('(subpath "/")')
    expect(profile).not.toContain(`(subpath "${os.homedir()}")`)
  })

  test("the read allowlist rejects interpreter roots that expose the root or home directory", () => {
    const resolve = (p: string) => p
    expect(Sandbox.readAllowlist("linux", { roots: ["/home/u"], libraries: [] }, { home: "/home/u", resolve }).ok).toBe(
      false,
    )
    expect(Sandbox.readAllowlist("linux", { roots: ["/"], libraries: [] }, { home: "/home/u", resolve }).ok).toBe(false)
    expect(
      Sandbox.readAllowlist(
        "linux",
        { roots: ["/opt/py"], libraries: ["/home/u/libx.so"] },
        { home: "/home/u", resolve },
      ).ok,
    ).toBe(false)
    const ok = Sandbox.readAllowlist(
      "linux",
      {
        roots: ["/opt/py", "/opt/py/lib/python3.12"],
        libraries: [
          "/opt/py/lib/libpython.so",
          "/opt/ssl/lib/libssl.so.3",
          "/usr/lib/libc.so",
          "/dev/shm/sem.mp-1",
          "/srv/data/mapped.bin",
        ],
      },
      { home: "/home/u", resolve },
    )
    expect(ok.ok && ok.directories).toEqual(expect.arrayContaining(["/opt/py", "/opt/ssl/lib", "/usr"]))
    expect(ok.ok && ok.directories).not.toContain("/opt/py/lib/python3.12")
    expect(ok.ok && ok.directories).not.toContain("/dev/shm")
    expect(ok.ok && ok.directories).not.toContain("/srv/data")
  })

  test("a missing bubblewrap is refused with an install hint", async () => {
    const result = await Sandbox.detectConfinement({
      python: "python3",
      bootstrap: BOOTSTRAP,
      env: childEnv,
      platform: "linux",
      mechanisms: [],
      appArmorRestricted: () => true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("not installed")
      expect(result.reason).toContain("Install the `bubblewrap` package")
      expect(result.reason).not.toContain("apparmor_restrict_unprivileged_userns")
    }
  })

  test("bubblewrap blocked by the AppArmor user-namespace restriction names the remedies", () => {
    const reason = Sandbox.unsupported("linux", { bwrapInstalled: true, appArmorRestricted: true })
    expect(reason).toContain("kernel.apparmor_restrict_unprivileged_userns=1")
    expect(reason).toContain("AppArmor profile")
    expect(reason).toContain("kernel.apparmor_restrict_unprivileged_userns=0")
    expect(reason).toContain("admin decision")
    expect(reason).toContain("never changes system settings")
    expect(Sandbox.unsupported("linux", { bwrapInstalled: true, appArmorRestricted: false })).not.toContain("AppArmor")
  })

  test("the AppArmor message needs a user-namespace denial in the self-test AND the sysctl", () => {
    expect(Sandbox.indicatesUserNamespaceDenial("bwrap: setting up uid map: Permission denied")).toBe(true)
    expect(Sandbox.indicatesUserNamespaceDenial("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted")).toBe(true)
    expect(Sandbox.indicatesUserNamespaceDenial("PYTHON_LEAK")).toBe(false)
    expect(Sandbox.indicatesUserNamespaceDenial("ModuleNotFoundError: No module named 'pandas'")).toBe(false)
  })

  test("self-test canaries are outside every allowlisted path, /tmp and the private dir is 0700", async () => {
    const excluded = ["/usr", "/lib", "/etc/ssl", "/tmp", "/tmp/session"]
    const base = await fs.mkdtemp(path.join(os.homedir(), ".altimate-canary-test-"))
    try {
      const { files, dirs } = await Sandbox.createCanaries(excluded, [base])
      expect(files.length).toBe(1)
      for (const file of files)
        for (const e of excluded) expect(file === e || file.startsWith(e + "/")).toBe(false)
      expect(files[0].startsWith("/tmp/")).toBe(false)
      expect((await fs.stat(dirs[0])).mode & 0o777).toBe(0o700)
      // A root that is itself allowlisted yields no canary.
      const none = await Sandbox.createCanaries([base], [base])
      expect(none.files).toEqual([])
      for (const d of [...dirs, ...none.dirs]) await fs.rm(d, { recursive: true, force: true })
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  test("unsupported platforms are refused", async () => {
    for (const platform of ["win32", "freebsd"] as const) {
      const result = await Sandbox.detectConfinement({
        python: "python3",
        bootstrap: BOOTSTRAP,
        env: childEnv,
        platform,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("never run unconfined")
    }
  })

  e2e(
    "Linux with no working mechanism is refused",
    async () => {
      const result = await Sandbox.detectConfinement({
        python,
        bootstrap: BOOTSTRAP,
        env: childEnv,
        platform: "linux",
        mechanisms: [],
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("bubblewrap")
    },
    30_000,
  )

  e2e(
    "macOS without sandbox-exec reports it as missing",
    async () => {
      const result = await Sandbox.detectConfinement({
        python,
        bootstrap: BOOTSTRAP,
        env: childEnv,
        platform: "darwin",
        mechanisms: [],
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain("sandbox-exec not found")
        expect(result.reason).not.toContain("no filesystem confinement mechanism is supported")
      }
    },
    30_000,
  )

  e2e(
    "macOS sandbox-exec self-test failure reports the reason",
    async () => {
      const result = await Sandbox.detectConfinement({
        python,
        bootstrap: BOOTSTRAP,
        env: childEnv,
        platform: "darwin",
        mechanisms: [{ filesystem: "sandbox-exec", network: "isolated", prefix: ["/usr/bin/false"] }],
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain("sandbox-exec self-test failed:")
        expect(result.reason).not.toContain("no filesystem confinement mechanism is supported")
      }
    },
    30_000,
  )

  e2e(
    "a mechanism that does not actually confine reads fails the self-test and is refused",
    async () => {
      await using bin = await tmpdir()
      // A fake bwrap that discards the sandbox arguments and runs the interpreter unconfined.
      const fake = path.join(bin.path, "bwrap")
      await fs.writeFile(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 })
      const result = await Sandbox.detectConfinement({
        python,
        bootstrap: BOOTSTRAP,
        env: childEnv,
        platform: "linux",
        mechanisms: [{ filesystem: "bwrap", network: "isolated", prefix: [fake] }],
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("Self-test")
    },
    30_000,
  )

  e2e(
    "the host mechanism passes its self-test",
    async () => {
      resetConfinement()
      const result = await confinementFor(python)
      expect(result.ok).toBe(true)
      if (result.ok)
        expect(result.confinement.filesystem).toBe(process.platform === "darwin" ? "sandbox-exec" : "bwrap")
    },
    30_000,
  )
})

describe("descendant identity verification", () => {
  const id = (parent: number, started = "Sat Oct 17 10:00:00 2026", command = "sleep", uid = 501) => ({
    parent,
    uid,
    started,
    command,
  })
  const table = (rows: Record<number, ReturnType<typeof id>>) =>
    new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]))

  test("parses ps output with lstart and command", () => {
    const parsed = parseProcessTable("  12   1 501 Sat Oct  7 10:00:00 2026 /usr/bin/python3\n")
    expect(parsed.get(12)).toEqual({ parent: 1, uid: 501, started: "Sat Oct  7 10:00:00 2026", command: "/usr/bin/python3" })
  })

  test("does not signal a recorded pid whose identity no longer matches", () => {
    const root = id(1, undefined, "bwrap")
    const known = new Map([[200, id(100)]])
    // pid 200 was reused by an unrelated process that starts in the same second but runs another command
    const now = table({ 100: root, 200: id(999, undefined, "Finder") })
    const verdict = verifiedKillTargets(known, now, 100, root)
    expect(verdict.kill).toEqual([])
    expect(verdict.skipped).toEqual([200])
    const reused = reconcileDescendants(known, now, 100, root)
    expect(reused).toEqual([200])
    expect(known.has(200)).toBe(false)
  })

  test("does not signal when uid differs or the root itself was reused", () => {
    const root = id(1, undefined, "bwrap")
    const known = new Map([[200, id(100)]])
    expect(verifiedKillTargets(known, table({ 100: root, 200: id(100, undefined, "sleep", 0) }), 100, root).kill).toEqual([])
    const reusedRoot = id(1, "Sat Oct 17 10:00:05 2026", "bwrap")
    const moved = new Map([[200, id(150)]])
    expect(verifiedKillTargets(moved, table({ 100: reusedRoot, 200: id(77) }), 100, root).kill).toEqual([])
  })

  test("signals a continuously observed descendant, including after re-parenting", () => {
    const root = id(1, undefined, "bwrap")
    const known = new Map<number, ReturnType<typeof id>>()
    reconcileDescendants(known, table({ 100: root, 200: id(100) }), 100, root)
    expect(known.has(200)).toBe(true)
    // parent exited and the child was re-parented to launchd; it is still the same process
    const later = table({ 200: id(1) })
    reconcileDescendants(known, later, 100, root)
    expect(verifiedKillTargets(known, later, 100, root).kill).toEqual([200])
  })
})
// altimate_change end
