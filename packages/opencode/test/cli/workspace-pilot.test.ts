// altimate_change - new file
// With the workspace pilot off, `link` and `skill publish` must explain the opt-in rather
// than fall through to the default command, which read "link" as a project directory.
import { afterEach, expect, test } from "bun:test"
import yargs from "yargs"
import { pilotOffCommand, WORKSPACE_PILOT_OFF_MESSAGE } from "../../src/cli/cmd/workspace-pilot"

const originalWrite = process.stderr.write.bind(process.stderr)
const originalExitCode = process.exitCode
afterEach(() => {
  process.stderr.write = originalWrite
  // Bun ignores `process.exitCode = undefined`, so restore a number or a 1 leaks into later files.
  process.exitCode = originalExitCode ?? 0
})

test.each([
  ["link", ["link"]],
  ["link", ["link", "--directory", "/tmp/x"]],
  ["publish [name]", ["publish", "my-skill"]],
  ["publish [name]", ["publish"]],
  ["workspace-client [action]", ["workspace-client", "status"]],
  ["workspace-client [action]", ["workspace-client"]],
])("%s stub handles %p with the opt-in message and a failing exit", async (command, argv) => {
  let said = ""
  process.stderr.write = ((chunk: string | Uint8Array) => {
    said += String(chunk)
    return true
  }) as typeof process.stderr.write
  process.exitCode = 0
  await yargs(argv).command(pilotOffCommand(command)).strict().fail(false).parseAsync()
  process.stderr.write = originalWrite
  expect(said).toContain(WORKSPACE_PILOT_OFF_MESSAGE)
  expect(process.exitCode).toBe(1)
})

test("the real CLI stubs workspace-client when workspaces are turned off", async () => {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", `${import.meta.dir}/../../src/index.ts`, "workspace-client", "status"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ALTIMATE_DISABLE_WORKSPACE: "1", ALTIMATE_TELEMETRY_DISABLED: "1" },
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  expect(stderr).toContain(WORKSPACE_PILOT_OFF_MESSAGE)
  expect(code).toBe(1)
}, 60000)

// A required positional (`workspace-client <action>`) would make yargs itself throw "Not enough
// non-option arguments" before this stub's handler ever ran, which bypassed the opt-in message.
test("the real CLI stubs a bare workspace-client (no action) when workspaces are turned off", async () => {
  const proc = Bun.spawn([process.execPath, "--conditions=browser", `${import.meta.dir}/../../src/index.ts`, "workspace-client"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ALTIMATE_DISABLE_WORKSPACE: "1", ALTIMATE_TELEMETRY_DISABLED: "1" },
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  expect(stderr).toContain(WORKSPACE_PILOT_OFF_MESSAGE)
  expect(code).toBe(1)
}, 60000)
