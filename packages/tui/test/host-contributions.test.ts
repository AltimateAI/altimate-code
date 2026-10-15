// altimate: ALT-F02
import { expect, test } from "bun:test"
import path from "node:path"

for (const scenario of ["branded", "stock", "throw", "load-throw"]) {
  test(`host TUI contribution: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "run", "test/fixture/host-contributions.tsx", scenario], {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain(`H2 TUI ${scenario}: PASS`)
  }, 30_000)
}
