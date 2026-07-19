import { describe, test, expect } from "bun:test"
import { execSync } from "child_process"
import { classifyBucket, classifyCategories, FORK_OWNED_ROOTS, UNATTRIBUTED, categoryRuleIds, isUpstreamFixLine } from "./taxonomy"

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim()
const UPSTREAM_TAG = "v1.17.9"

function loadUpstreamPaths(): Set<string> {
  const out = execSync(`git ls-tree -r --name-only "${UPSTREAM_TAG}"`, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  })
  return new Set(out.split("\n").filter((l) => l.length > 0))
}

describe("classifyBucket", () => {
  test("upstream_shared wins even for a path under a fork-owned root", () => {
    const upstream = new Set([".opencode/.gitignore"])
    // .opencode/** is in FORK_OWNED_ROOTS, but this exact path also exists upstream.
    expect(classifyBucket(".opencode/.gitignore", upstream)).toBe("upstream_shared")
  })

  test("fork_owned for a path under an approved root that doesn't exist upstream", () => {
    const upstream = new Set<string>()
    expect(classifyBucket("packages/dbt-tools/package.json", upstream)).toBe("fork_owned")
    expect(classifyBucket("packages/drivers/src/index.ts", upstream)).toBe("fork_owned")
    expect(classifyBucket("packages/opencode/src/altimate/foo.ts", upstream)).toBe("fork_owned")
    expect(classifyBucket("script/upstream/taxonomy.ts", upstream)).toBe("fork_owned")
  })

  test("fork_added_outside_boundary for a path matching neither", () => {
    const upstream = new Set<string>()
    expect(classifyBucket("packages/opencode/src/some-random-new-thing.ts", upstream)).toBe("fork_added_outside_boundary")
  })

  test("upstream_shared for an ordinary upstream file", () => {
    const upstream = new Set(["packages/opencode/src/index.ts"])
    expect(classifyBucket("packages/opencode/src/index.ts", upstream)).toBe("upstream_shared")
  })

  test("normalizes backslashes and leading ./", () => {
    const upstream = new Set(["packages/opencode/src/index.ts"])
    expect(classifyBucket("packages\\opencode\\src\\index.ts", upstream)).toBe("upstream_shared")
    expect(classifyBucket("./packages/opencode/src/index.ts", upstream)).toBe("upstream_shared")
  })

  test("packages/dbt-tools/** is fork-owned (gap vs config.ts keepOurs, fixed in taxonomy)", () => {
    expect(FORK_OWNED_ROOTS).toContain("packages/dbt-tools/**")
  })
})

describe(".opencode/ overlap oracle (generated from git ls-tree -r v1.17.9)", () => {
  test("exactly 10 .opencode/ paths overlap between v1.17.9 and the current tree, and all classify upstream_shared", () => {
    const upstreamOpencodePaths = execSync(`git ls-tree -r --name-only "${UPSTREAM_TAG}" -- .opencode/`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    })
      .split("\n")
      .filter((l) => l.length > 0)

    const currentOpencodePaths = execSync("git ls-files .opencode/", {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    })
      .split("\n")
      .filter((l) => l.length > 0)

    const currentSet = new Set(currentOpencodePaths)
    const overlap = upstreamOpencodePaths.filter((p) => currentSet.has(p)).sort()

    expect(overlap).toHaveLength(10)
    expect(overlap).toEqual(
      [
        ".opencode/.gitignore",
        ".opencode/command/commit.md",
        ".opencode/command/issues.md",
        ".opencode/command/learn.md",
        ".opencode/command/translate.md",
        ".opencode/opencode.jsonc",
        ".opencode/plugins/smoke-theme.json",
        ".opencode/plugins/tui-smoke.tsx",
        ".opencode/themes/.gitignore",
        ".opencode/tui.json",
      ].sort(),
    )

    const upstreamPaths = new Set(overlap)
    expect(classifyBucket(".opencode/.gitignore", upstreamPaths)).toBe("upstream_shared")
    expect(classifyBucket(".opencode/themes/.gitignore", upstreamPaths)).toBe("upstream_shared")
    for (const p of overlap) {
      expect(classifyBucket(p, upstreamPaths)).toBe("upstream_shared")
    }
  })

  test("a .opencode/ path NOT in the overlap set classifies fork_owned", () => {
    const upstreamPaths = loadUpstreamPaths()
    // .opencode/skills/** is fork-authored and has no upstream counterpart.
    expect(classifyBucket(".opencode/skills/dbt-snapshot/SKILL.md", upstreamPaths)).toBe("fork_owned")
  })
})

describe("classifyCategories", () => {
  test("multi-label: a block can match more than one rule", () => {
    const cats = classifyCategories("packages/opencode/test/tool/registry.test.ts", "tool registry: defensive fallback for missing tool")
    expect(cats).toContain("TOOL_REGISTRY")
    expect(cats).toContain("TEST_ONLY")
    expect(cats).toContain("ROBUSTNESS")
  })

  test("returns UNATTRIBUTED when no rule matches", () => {
    expect(classifyCategories("random/path/nope.ts", "totally unrelated description with no keywords")).toEqual([UNATTRIBUTED])
  })

  test("UNATTRIBUTED is still added when a block matches ONLY sub-bucket rules and no primary category (Codex finding #13)", () => {
    // "defensive fallback guard" matches the ROBUSTNESS sub-bucket, and the
    // /test/ path segment matches TEST_ONLY — but neither is a PrimaryCategory
    // rule, so this block has zero opinion on functional area and must still
    // surface UNATTRIBUTED alongside its sub-bucket labels. Before the fix,
    // `unique.length > 0` alone suppressed UNATTRIBUTED here, silently hiding
    // blocks that need a real primary-category rule.
    const cats = classifyCategories("packages/opencode/test/foo/bar.test.ts", "defensive fallback guard for edge case")
    expect(cats).toContain("TEST_ONLY")
    expect(cats).toContain("ROBUSTNESS")
    expect(cats).toContain(UNATTRIBUTED)
  })

  test("UNCLEAR sub-bucket for empty/placeholder descriptions", () => {
    expect(classifyCategories("packages/opencode/src/index.ts", "")).toContain("UNCLEAR")
    expect(classifyCategories("packages/opencode/src/index.ts", "(no description)")).toContain("UNCLEAR")
  })

  test("TUI primary category", () => {
    expect(classifyCategories("packages/tui/src/component/foo.tsx", "tui tweak")).toContain("TUI")
  })

  test("PERMISSION_SAFETY primary category", () => {
    expect(classifyCategories("packages/opencode/src/permission/permission.ts", "bash-safety deny rule")).toContain("PERMISSION_SAFETY")
  })

  test("BRANDING primary category", () => {
    expect(classifyCategories("packages/opencode/src/some.ts", "app name wordmark change")).toContain("BRANDING")
  })

  test("COMPAT_SHIM primary category", () => {
    expect(classifyCategories("packages/opencode/src/bridge/run.ts", "effect runtime promise wrapper")).toContain("COMPAT_SHIM")
  })

  test("FEATURE sub-bucket keyword", () => {
    expect(classifyCategories("packages/opencode/src/memory/store.ts", "net-new memory feature")).toContain("FEATURE")
  })

  test("categoryRuleIds returns a non-empty, stable list of rule ids", () => {
    const ids = categoryRuleIds()
    expect(ids.length).toBeGreaterThan(10)
    expect(new Set(ids).size).toBe(ids.length) // no duplicate ids
  })
})

describe("isUpstreamFixLine", () => {
  test("detects upstream_fix: tag case-insensitively", () => {
    expect(isUpstreamFixLine("// altimate_change start — upstream_fix: null check")).toBe(true)
    expect(isUpstreamFixLine("// altimate_change start — Upstream_Fix: null check")).toBe(true)
  })

  test("false for a plain feature marker", () => {
    expect(isUpstreamFixLine("// altimate_change start — new feature")).toBe(false)
  })
})
