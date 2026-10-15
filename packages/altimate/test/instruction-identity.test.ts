import { expect, test } from "bun:test"
import { join } from "node:path"
import descriptor from "../identity.json"

for (const branded of [false, true]) {
  test(`${branded ? "branded" : "stock"} instruction hooks and driver home follow identity aliases`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        ...(branded ? ["--define", `globalThis.__OPENCODE_IDENTITY__=${JSON.stringify(descriptor)}`] : []),
        join(import.meta.dir, "fixtures/instruction-identity.ts"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [output, errors, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, errors).toBe(0)
    const results = JSON.parse(output) as {
      scenario: string
      primary: boolean
      fallback: boolean
      project: boolean
      driverDirectory: string
    }[]
    expect(results).toHaveLength(6)
    for (const result of results) {
      expect(result.driverDirectory).toBe(
        `<fixture>/${branded && result.scenario !== "fallback" ? "primary" : "fallback"}-home/.local/share/altimate-code/drivers`,
      )
      expect(result.project, result.scenario).toBe(branded || result.scenario !== "false")
      expect(result.primary, result.scenario).toBe(branded && result.scenario === "false")
      expect(result.fallback, result.scenario).toBe(!branded && !["fallback", "false"].includes(result.scenario))
    }
  }, 60_000)
}
