// altimate_change start — a skill must not auto-load because of a file on some other project.
import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"

describe("autoLoadScanRoot", () => {
  test("uses the worktree when there is a real project", () => {
    expect(SystemPrompt.autoLoadScanRoot("/Users/me/code/proj", "/Users/me/code/proj/sub")).toBe("/Users/me/code/proj")
  })

  test("falls back to the session directory when the worktree is the no-project sentinel", () => {
    // `Project.fromDirectory` returns `/` for a directory belonging to no git project. Searching
    // it matched any `dbt_project.yml` anywhere on the machine, so an empty scratch directory
    // silently loaded the dbt skills into its system prompt.
    expect(SystemPrompt.autoLoadScanRoot("/", "/tmp/scratch")).toBe("/tmp/scratch")
  })

  test("does not treat a path merely starting with / as the sentinel", () => {
    // Guard against matching by prefix rather than equality — every absolute path starts with "/".
    expect(SystemPrompt.autoLoadScanRoot("/srv", "/tmp/scratch")).toBe("/srv")
  })
})
// altimate_change end
