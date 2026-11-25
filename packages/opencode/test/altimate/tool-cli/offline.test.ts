// altimate_change - new file
import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

// Offline.start replaces the process-wide fetch, so the check runs in its own process.
test("offline mode turns workspace tools off and says so when they were asked for", async () => {
  await using tmp = await tmpdir()
  const module = path.resolve(import.meta.dir, "../../../src/altimate/tool-cli/workspace-tools.ts")
  const script = `const { resolveWorkspaceTools } = await import(${JSON.stringify(module)})
console.log(JSON.stringify([await resolveWorkspaceTools(true, ${JSON.stringify(tmp.path)}, async () => true), await resolveWorkspaceTools(undefined, ${JSON.stringify(tmp.path)}, async () => true)]))`
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...process.env, ALTIMATE_OFFLINE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  expect(stdout.trim().split("\n").at(-1)).toBe("[false,false]")
  // Only the explicit request gets the notice.
  expect(stderr.match(/Workspace tools are unavailable in offline mode\./g)).toHaveLength(1)
})
