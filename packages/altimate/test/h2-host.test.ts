import { expect, test } from "bun:test"
import path from "node:path"
import { createFixture } from "./lib/host"

for (const mode of [
  "fresh",
  "duplicate",
  "config-duplicate",
  "collision",
  "exact",
  "wildcard",
  "lifecycle",
  "throw",
  "stock",
]) {
  test(`H2 host composition: ${mode}`, async () => {
    await using fixture = await createFixture()
    const preload = mode === "throw" ? "fixtures/h2-throw-preload.ts" : "../script/identity-preload.ts"
    const child = Bun.spawn(
      [
        process.execPath,
        ...(mode === "stock" ? [] : ["--preload", path.join(import.meta.dir, preload)]),
        path.join(import.meta.dir, "fixtures/h2-host.ts"),
        mode,
      ],
      {
        env: {
          ...process.env,
          HOME: fixture.path,
          XDG_CONFIG_HOME: path.join(fixture.path, "config"),
          XDG_DATA_HOME: path.join(fixture.path, "data"),
          XDG_CACHE_HOME: path.join(fixture.path, "cache"),
          XDG_STATE_HOME: path.join(fixture.path, "state"),
          OPENCODE_TEST_HOME: fixture.path,
          ALTIMATE_CLI_TEST_HOME: fixture.path,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status, stdout + stderr).toBe(0)
    expect(stdout).toContain(
      JSON.stringify({
        mode,
        ...(mode === "stock" ? { absent: true } : mode === "throw" ? { blocked: true } : { active: true }),
      }),
    )
    if (mode === "collision")
      expect(stdout + stderr).toMatch(/protected.*(sql_execute|warehouse_add)|(sql_execute|warehouse_add).*protected/i)
  }, 45_000)
}
