import { describe, test, expect } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import YAML from "yaml"

/** The GitHub Action's optional artifact preparation stays opt-in and injection-safe. */
const actionPath = path.join(import.meta.dir, "../../../../github/review/action.yml")

describe("action: dbt_prepare", () => {
  test("is opt-in, and its script reads inputs only from env", async () => {
    const action = YAML.parse(await fs.readFile(actionPath, "utf8"))
    expect(action.inputs.dbt_prepare.default).toBe("none")
    expect(action.inputs.dbt_command.default).toBe("dbt")
    const steps: Array<{ name: string; if?: string; run?: string; env?: Record<string, string> }> = action.runs.steps
    const prep = steps.find((s) => s.name === "Prepare dbt artifacts")!
    const review = steps.findIndex((s) => s.name === "Run dbt PR review")
    expect(steps.indexOf(prep)).toBeLessThan(review)
    expect(prep.if).toBe("inputs.dbt_prepare != 'none'")
    expect(prep.run).not.toContain("${{")
    expect(prep.env?.IN_DBT).toBe("${{ inputs.dbt_command }}")
    // The base is compiled into target-base/, where the compiled-SQL resolver looks.
    expect(prep.run).toContain('"$PROJECT/target-base"')
  })

  test("a failed docs generate or base checkout warns and lets the review run", async () => {
    const action = YAML.parse(await fs.readFile(actionPath, "utf8"))
    const prep = (action.runs.steps as Array<{ name: string; run?: string }>).find((s) => s.name === "Prepare dbt artifacts")!
    const run = prep.run!
    expect(run).toMatch(/docs generate[^\n]*\) \|\|\n\s*echo "::warning::/)
    expect(run).toMatch(/git worktree add[^\n]*\|\| \{ echo "::warning::/)
    expect(run.indexOf('rm -rf "$PROJECT/target-base"')).toBeLessThan(run.indexOf('build "$WT/$REL"'))
  })
})
