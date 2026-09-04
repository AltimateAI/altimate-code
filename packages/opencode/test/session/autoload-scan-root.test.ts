// altimate_change start — a skill must not auto-load because of a file on some other project.
import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"

describe("autoLoadScanRoot", () => {
  test("uses the worktree when there is a real project", () => {
    expect(SystemPrompt.autoLoadScanRoot("/Users/me/code/proj", "/Users/me/code/proj/sub", "git")).toBe(
      "/Users/me/code/proj",
    )
  })

  test("falls back to the session directory when the worktree is the no-project sentinel", () => {
    // `Project.fromDirectory` returns `/` with no vcs for a directory belonging to no git
    // project. Searching it matched any `dbt_project.yml` anywhere on the machine, so an empty
    // scratch directory silently loaded the dbt skills into its system prompt.
    expect(SystemPrompt.autoLoadScanRoot("/", "/tmp/scratch", undefined)).toBe("/tmp/scratch")
  })

  test("keeps the root for a git repository genuinely rooted at /", () => {
    // Same worktree value, different meaning: `fromDirectory` reports `/` with `vcs: "git"` for
    // a real repo at the filesystem root, and narrowing that to the cwd would stop a marker at
    // `/` matching a session started in `/workspace/sub`.
    expect(SystemPrompt.autoLoadScanRoot("/", "/workspace/sub", "git")).toBe("/")
  })

  test("does not treat a path merely starting with / as the sentinel", () => {
    // Guard against matching by prefix rather than equality — every absolute path starts with "/".
    expect(SystemPrompt.autoLoadScanRoot("/srv", "/tmp/scratch", undefined)).toBe("/srv")
  })
})
// altimate_change end
