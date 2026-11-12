import { afterEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// The wrapper hands its process to the binary with process.execve where node
// has it, and otherwise spawns the binary and forwards termination signals.
// These tests stand in a script for the binary: it reports readiness on
// stdout, logs every signal it receives, and exits with a code that identifies
// the path it took, or 98 after 20 s so a failed test leaves no process
// behind. Each signal is sent two ways: to the wrapper's pid (a
// driver's `kill <pid>`) and to its process group (GNU `timeout`, `killpg`,
// tree-kill, or a terminal's Ctrl-C), with and without a controlling terminal.
const WRAPPER_SOURCE = path.resolve(import.meta.dir, "../../bin/altimate-code")
const SIGNAL_MODULE = path.resolve(import.meta.dir, "../../src/cli/cmd/run-signal.ts")
const SIGNALS = ["SIGINT", "SIGHUP", "SIGTERM"] as const
const TRAP_EXIT = { SIGINT: 8, SIGHUP: 9, SIGTERM: 7 } as const
const unix = process.platform !== "win32"
const nodeHasExecve =
  unix && spawnSync("node", ["-p", "typeof process.execve"], { encoding: "utf8" }).stdout.trim() === "function"
const hasPython = unix && spawnSync("python3", ["-c", "import pty"]).status === 0
const unixtest = unix ? test : test.skip

let dir: string | undefined
let running: ChildProcess | undefined
let wrapperPid: number | undefined

afterEach(() => {
  if (running && running.exitCode === null && running.signalCode === null) running.kill("SIGKILL")
  if (wrapperPid) {
    try {
      process.kill(wrapperPid, "SIGKILL")
    } catch {}
  }
  running = undefined
  wrapperPid = undefined
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function tmp() {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "altimate-wrapper-test-"))
  return dir
}

// The package is ESM ("type": "module"), so node would load the extensionless
// wrapper as ESM from inside it. Copy it out, as an installed wrapper is.
function wrapperCopy() {
  const bin = path.join(tmp(), "bin")
  fs.mkdirSync(bin, { recursive: true })
  const file = path.join(bin, "altimate-code")
  fs.copyFileSync(WRAPPER_SOURCE, file)
  return file
}

// Loaded with --require, it hides process.execve so the wrapper takes the
// spawn-and-forward path that node without execve (and Windows) uses.
function withoutExecve() {
  const file = path.join(tmp(), "no-execve.cjs")
  fs.writeFileSync(file, "delete process.execve\n")
  return ["--require", file]
}

function fakeBinary(body: string | ((signalFile: string) => string)) {
  const file = path.join(tmp(), "fake-altimate-code")
  const signalFile = path.join(tmp(), "signal")
  fs.writeFileSync(file, `#!/bin/sh\n${typeof body === "string" ? body : body(signalFile)}\n`)
  fs.chmodSync(file, 0o755)
  return { file, signalFile }
}

// Logs every signal it receives, then exits with the first one's code after a
// pause long enough for a second copy of the signal to arrive and be logged.
// A JS handler sees each delivery; a shell trap would merge two into one.
function loggingBinary() {
  const file = path.join(tmp(), "fake-altimate-code")
  const signalFile = path.join(tmp(), "signal")
  fs.writeFileSync(
    file,
    [
      `#!${process.execPath}`,
      `import fs from "node:fs"`,
      `const codes = ${JSON.stringify(TRAP_EXIT)}`,
      `let first: keyof typeof codes | undefined`,
      `for (const signal of Object.keys(codes) as (keyof typeof codes)[]) {`,
      `  process.on(signal, () => {`,
      `    fs.appendFileSync(${JSON.stringify(signalFile)}, signal + "\\n")`,
      `    if (first) return`,
      `    first = signal`,
      `    setTimeout(() => process.exit(codes[signal]), 500)`,
      `  })`,
      `}`,
      `console.log("ready")`,
      `setTimeout(() => process.exit(98), 20_000)`,
    ].join("\n"),
  )
  fs.chmodSync(file, 0o755)
  return { file, signalFile }
}

// A bun binary that takes signals the way `run` does: through the RunSignal
// coalescer, where a second delivery means "exit now" (code 99) and a single
// one runs a shutdown flush and exits 7.
function coalescingBinary() {
  const file = path.join(tmp(), "fake-altimate-code")
  const signalFile = path.join(tmp(), "signal")
  fs.writeFileSync(
    file,
    [
      `#!${process.execPath}`,
      `import fs from "node:fs"`,
      `import { RunSignal } from ${JSON.stringify(SIGNAL_MODULE)}`,
      `const log = (line: string) => fs.appendFileSync(${JSON.stringify(signalFile)}, line + "\\n")`,
      `const accept = RunSignal.coalescer(process.env.ALTIMATE_WRAPPER_FORWARDS_SIGNALS === "1")`,
      `let deliveries = 0`,
      `for (const signal of ["SIGINT", "SIGTERM"] as const) {`,
      `  process.on(signal, () => log("raw " + signal))`,
      `  process.on(signal, accept(signal, () => {`,
      `    log("delivery " + signal)`,
      `    if (++deliveries > 1) process.exit(99)`,
      `    setTimeout(() => process.exit(7), 500)`,
      `  }))`,
      `}`,
      `console.log("ready")`,
      `setTimeout(() => process.exit(98), 20_000)`,
    ].join("\n"),
  )
  fs.chmodSync(file, 0o755)
  return { file, signalFile }
}

function lines(signalFile: string) {
  return fs.existsSync(signalFile) ? fs.readFileSync(signalFile, "utf8").trim().split("\n").filter(Boolean) : []
}

function start(binary: string, options?: { detached?: boolean; nodeArgs?: string[] }) {
  const child = spawn("node", [...(options?.nodeArgs ?? []), wrapperCopy()], {
    env: { ...process.env, ALTIMATE_CODE_BIN_PATH: binary },
    stdio: ["ignore", "pipe", "pipe"],
    detached: options?.detached ?? false,
  })
  running = child
  wrapperPid = child.pid
  let stdout = ""
  let stderr = ""
  child.stdout!.on("data", (chunk) => (stdout += chunk))
  child.stderr!.on("data", (chunk) => (stderr += chunk))
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fake binary never reported ready; stderr: ${stderr}`)), 10_000)
    child.stdout!.on("data", () => {
      if (stdout.includes("ready")) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }))
  })
  return {
    child,
    ready,
    exit,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

// Runs the wrapper as the session leader of a new pseudo-terminal, so it has a
// controlling terminal the way an interactive shell's job does. The relay
// prints `PID <wrapper pid>`, the terminal's output, then `EXIT <code|SIGn>`.
function startOnTerminal(binary: string, nodeArgs: string[] = []) {
  const relay = path.join(tmp(), "pty-relay.py")
  fs.writeFileSync(
    relay,
    [
      "import os, pty, sys",
      "pid, fd = pty.fork()",
      "if pid == 0:",
      "    os.execvp(sys.argv[1], sys.argv[1:])",
      'sys.stdout.write("PID %d\\n" % pid); sys.stdout.flush()',
      "while True:",
      "    try:",
      "        data = os.read(fd, 1024)",
      "    except OSError:",
      "        break",
      "    if not data:",
      "        break",
      "    sys.stdout.buffer.write(data); sys.stdout.flush()",
      "_, status = os.waitpid(pid, 0)",
      'code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else "SIG%d" % os.WTERMSIG(status)',
      'sys.stdout.write("EXIT %s\\n" % code); sys.stdout.flush()',
    ].join("\n"),
  )
  const child = spawn("python3", ["-I", relay, "node", ...nodeArgs, wrapperCopy()], {
    env: { ...process.env, ALTIMATE_CODE_BIN_PATH: binary },
    stdio: ["ignore", "pipe", "pipe"],
  })
  running = child
  let stdout = ""
  child.stdout!.on("data", (chunk) => (stdout += chunk))
  const pid = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready wrapper on the terminal; output: ${stdout}`)), 10_000)
    child.stdout!.on("data", () => {
      const match = stdout.match(/^PID (\d+)$/m)
      if (match && stdout.includes("ready")) {
        clearTimeout(timer)
        wrapperPid = Number(match[1])
        resolve(Number(match[1]))
      }
    })
  })
  // Resolves with the wrapper's status, or "running" if it is still alive after
  // the deadline (a swallowed signal).
  const exit = (deadlineMs: number) =>
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("running"), deadlineMs)
      const check = () => {
        const match = stdout.match(/^EXIT (\S+)$/m)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      child.stdout!.on("data", check)
      check()
    })
  return { pid, exit }
}

function send(pid: number, signal: NodeJS.Signals, target: "pid" | "group") {
  process.kill(target === "group" ? -pid : pid, signal)
}

describe("bin/altimate-code signal delivery", () => {
  // With process.execve the wrapper is the binary: there is one process, so a
  // signal sent to the wrapper's pid or its group reaches the binary exactly once.
  const execTest = nodeHasExecve ? test : test.skip
  for (const signal of SIGNALS) {
    for (const target of ["pid", "group"] as const) {
      execTest(`${signal} sent to the wrapper's ${target} reaches the binary exactly once`, async () => {
        const { file, signalFile } = loggingBinary()
        const run = start(file, { detached: true })
        await run.ready
        send(run.child.pid!, signal, target)
        expect(await run.exit).toEqual({ code: TRAP_EXIT[signal], signal: null })
        expect(lines(signalFile)).toEqual([signal])
      })
    }
  }

  const terminalExecTest = nodeHasExecve && hasPython ? test : test.skip
  for (const signal of SIGNALS) {
    for (const target of ["pid", "group"] as const) {
      terminalExecTest(
        `with a controlling terminal, ${signal} sent to the wrapper's ${target} reaches the binary exactly once`,
        async () => {
          const { file, signalFile } = loggingBinary()
          const run = startOnTerminal(file)
          send(await run.pid, signal, target)
          expect(await run.exit(5_000)).toBe(String(TRAP_EXIT[signal]))
          expect(lines(signalFile)).toEqual([signal])
        },
      )
    }
  }

  // Without process.execve the wrapper forwards every termination signal it
  // receives, so a pid-directed signal is never swallowed.
  for (const signal of SIGNALS) {
    unixtest(`without execve, ${signal} sent to the wrapper's pid is forwarded exactly once`, async () => {
      const { file, signalFile } = loggingBinary()
      const run = start(file, { detached: true, nodeArgs: withoutExecve() })
      await run.ready
      send(run.child.pid!, signal, "pid")
      expect(await run.exit).toEqual({ code: TRAP_EXIT[signal], signal: null })
      expect(lines(signalFile)).toEqual([signal])
    })
  }

  const terminalTest = unix && hasPython ? test : test.skip
  for (const signal of SIGNALS) {
    terminalTest(`without execve and with a controlling terminal, a pid-directed ${signal} is forwarded`, async () => {
      const { file, signalFile } = loggingBinary()
      const run = startOnTerminal(file, withoutExecve())
      send(await run.pid, signal, "pid")
      expect(await run.exit(5_000)).toBe(String(TRAP_EXIT[signal]))
      expect(lines(signalFile)).toEqual([signal])
    })
  }

  // A group-directed signal reaches the binary directly and again through the
  // forward; `run` takes the pair as one delivery, so its shutdown flush runs.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    unixtest(`without execve, a group-directed ${signal} is one delivery to run's handler`, async () => {
      const { file, signalFile } = coalescingBinary()
      const run = start(file, { detached: true, nodeArgs: withoutExecve() })
      await run.ready
      send(run.child.pid!, signal, "group")
      expect(await run.exit).toEqual({ code: 7, signal: null })
      expect(lines(signalFile).filter((line) => line.startsWith("delivery"))).toEqual([`delivery ${signal}`])
    })
  }

  unixtest("a normal exit code is propagated unchanged", async () => {
    const { file } = fakeBinary("echo ready\nexit 3")
    const run = start(file)
    expect(await run.exit).toEqual({ code: 3, signal: null })
    expect(run.stdout).toContain("ready")
    expect(run.stderr).toBe("")
  })

  unixtest("without execve, a binary killed by a signal exits 128 + signal with the same message as before", async () => {
    const { file } = fakeBinary("echo ready\nkill -KILL $$")
    const run = start(file, { nodeArgs: withoutExecve() })
    expect(await run.exit).toEqual({ code: 128 + os.constants.signals.SIGKILL, signal: null })
    expect(run.stderr.trim()).toBe("altimate-code terminated by SIGKILL")
  })

  execTest("with execve, a binary killed by a signal is seen by the caller as killed by that signal", async () => {
    const { file } = fakeBinary("echo ready\nkill -KILL $$")
    const run = start(file)
    expect(await run.exit).toEqual({ code: null, signal: "SIGKILL" })
  })

  test("a missing binary exits 1 with the spawn error", async () => {
    const missing = path.join(os.tmpdir(), "altimate-wrapper-test-missing", "altimate-code")
    const run = start(missing)
    expect((await run.exit).code).toBe(1)
    expect(run.stderr).toContain("ENOENT")
  })
})
