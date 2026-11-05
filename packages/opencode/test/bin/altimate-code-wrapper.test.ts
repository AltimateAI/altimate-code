import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// The wrapper spawns its binary asynchronously and forwards termination
// signals to it. These tests stand in a shell script for the binary: it reports
// readiness on stdout, records the signal it received, and exits with a code
// that identifies the path it took.
const WRAPPER_SOURCE = path.resolve(import.meta.dir, "../../bin/altimate-code")
const unixtest = process.platform !== "win32" ? test : test.skip

let dir: string | undefined
let running: ChildProcess | undefined

afterEach(() => {
  if (running && running.exitCode === null && running.signalCode === null) running.kill("SIGKILL")
  running = undefined
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

// The package is ESM ("type": "module"), so node would load the extensionless
// wrapper as ESM from inside it. Copy it out, as an installed wrapper is.
function wrapperCopy() {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "altimate-wrapper-test-"))
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin, { recursive: true })
  const file = path.join(bin, "altimate-code")
  fs.copyFileSync(WRAPPER_SOURCE, file)
  return file
}

function fakeBinary(body: string | ((signalFile: string) => string)) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "altimate-wrapper-test-"))
  const file = path.join(dir, "fake-altimate-code")
  const signalFile = path.join(dir, "signal")
  fs.writeFileSync(file, `#!/bin/sh\n${typeof body === "string" ? body : body(signalFile)}\n`)
  fs.chmodSync(file, 0o755)
  return { file, signalFile }
}

function waiting(signalFile: string) {
  return [
    `trap 'echo SIGTERM > "${signalFile}"; exit 7' TERM`,
    `trap 'echo SIGINT > "${signalFile}"; exit 8' INT`,
    `trap 'echo SIGHUP > "${signalFile}"; exit 9' HUP`,
    "echo ready",
    "while :; do sleep 0.05; done",
  ].join("\n")
}

function start(binary: string, options?: { detached?: boolean }) {
  const child = spawn("node", [wrapperCopy()], {
    env: { ...process.env, ALTIMATE_CODE_BIN_PATH: binary },
    stdio: ["ignore", "pipe", "pipe"],
    detached: options?.detached ?? false,
  })
  running = child
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

describe("bin/altimate-code signal forwarding", () => {
  unixtest("SIGTERM to the wrapper reaches the binary and its exit code is propagated", async () => {
    const { file, signalFile } = fakeBinary(waiting)
    const run = start(file)
    await run.ready
    expect(run.child.kill("SIGTERM")).toBe(true)
    const result = await run.exit
    expect(fs.readFileSync(signalFile, "utf8").trim()).toBe("SIGTERM")
    expect(result).toEqual({ code: 7, signal: null })
    expect(run.stderr).toBe("")
  })

  unixtest("SIGINT is forwarded when the wrapper has no controlling terminal", async () => {
    const { file, signalFile } = fakeBinary(waiting)
    // A new session has no controlling terminal, so the terminal cannot have
    // delivered the signal to the binary already; the wrapper must.
    const run = start(file, { detached: true })
    await run.ready
    expect(run.child.kill("SIGINT")).toBe(true)
    const result = await run.exit
    expect(fs.readFileSync(signalFile, "utf8").trim()).toBe("SIGINT")
    expect(result).toEqual({ code: 8, signal: null })
  })

  unixtest("SIGHUP is forwarded when the wrapper has no controlling terminal", async () => {
    const { file, signalFile } = fakeBinary(waiting)
    const run = start(file, { detached: true })
    await run.ready
    expect(run.child.kill("SIGHUP")).toBe(true)
    const result = await run.exit
    expect(fs.readFileSync(signalFile, "utf8").trim()).toBe("SIGHUP")
    expect(result).toEqual({ code: 9, signal: null })
  })

  unixtest("a normal exit code is propagated unchanged", async () => {
    const { file } = fakeBinary("echo ready\nexit 3")
    const run = start(file)
    expect(await run.exit).toEqual({ code: 3, signal: null })
    expect(run.stdout).toContain("ready")
    expect(run.stderr).toBe("")
  })

  unixtest("a binary killed by a signal exits 128 + signal with the same message as before", async () => {
    const { file } = fakeBinary("echo ready\nkill -KILL $$")
    const run = start(file)
    expect(await run.exit).toEqual({ code: 128 + os.constants.signals.SIGKILL, signal: null })
    expect(run.stderr.trim()).toBe("altimate-code terminated by SIGKILL")
  })

  test("a missing binary exits 1 with the spawn error", async () => {
    const missing = path.join(os.tmpdir(), "altimate-wrapper-test-missing", "altimate-code")
    const run = start(missing)
    expect((await run.exit).code).toBe(1)
    expect(run.stderr).toContain("ENOENT")
  })
})
