import { expect, test } from "bun:test"
import path from "node:path"

for (const module of ["capture", "schedule"]) {
  test(`learning ${module} import failures do not abort instance startup`, async () => {
    const child = Bun.spawn([process.execPath, "test", path.join(import.meta.dir, "bootstrap-import-failure.fixture.ts")], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, LEARN_FAIL_IMPORT: module },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
  }, 30_000)
}
