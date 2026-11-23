import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { isManifestAffecting, projectAdapters } from "../../src/altimate/review/run"

/**
 * Guards on `warnIfStale`'s changed-file filter. The stale warning gates on a
 * changed file having an mtime newer than the manifest; iterating every path
 * in the diff (including README.md, package.json, .github/*) triggered
 * false-positive warnings on unrelated repo activity. The filter admits only
 * dbt-relevant paths.
 */
describe("isManifestAffecting", () => {
  // ADMITTED — these should trigger a stale-manifest warning when newer than
  // the compiled manifest.
  test.each([
    "models/marts/customers.sql",
    "models/staging/stg_orders.sql",
    "models/schema.yml",
    "models/marts/_models.yml",
    "models/customers.md", // dbt docs block under models/
    "analyses/gross_margin.md", // dbt docs block under analyses/
    "seeds/lookup.csv",
    "snapshots/orders_snapshot.sql",
    "snapshots/orders_snapshot.yml",
    "macros/generate_schema_name.sql",
    "tests/singular/no_orphan_orders.sql",
    "analyses/gross_margin.sql",
    "dbt_project.yml",
    "packages.yml",
    "profiles.yml",
    "dependencies.yml",
  ])("admits: %s", (rel) => {
    expect(isManifestAffecting(rel)).toBe(true)
  })

  // REJECTED — these should NOT trigger a stale-manifest warning because
  // touching them doesn't invalidate the compiled dbt manifest.
  test.each([
    "README.md",
    "CHANGELOG.md",
    "package.json",
    ".github/workflows/ci.yml",
    ".gitignore",
    "docs/README.md",
    "Dockerfile",
    "scripts/deploy.sh",
    "target/manifest.json", // the manifest itself
    "target/compiled/foo.sql", // compiled artifacts
    "tests/e2e/setup.ts",
    // dbt docs blocks are canonically parsed only from `models/` and
    // `analyses/`. README.md files elsewhere under dbt directories are
    // package documentation, not manifest input (altimate-harness-bot
    // review, PR #1027 run.ts:133).
    "macros/README.md",
    "tests/README.md",
    "seeds/README.md",
    "snapshots/README.md",
  ])("rejects: %s", (rel) => {
    expect(isManifestAffecting(rel)).toBe(false)
  })
})

describe("projectAdapters", () => {
  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "adapters-"))
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
    git("init", "-q")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    return dir
  }

  test("reads adapter variants from the project's own macros, mapping presto to trino", async () => {
    const dir = repo({
      "dbt/macros/first.sql": "{% macro postgres__first(x) %}{% endmacro %}\n{%- macro  snowflake__first(x) -%}{% endmacro %}",
      "dbt/macros/other.sql": "{% macro presto__other() %}{% endmacro %}{% macro default__other() %}{% endmacro %}",
      "elsewhere/macros/x.sql": "{% macro bigquery__x() %}{% endmacro %}",
    })
    expect(await projectAdapters(dir, "HEAD", "dbt")).toEqual(["postgres", "snowflake", "trino"])
    expect(await projectAdapters(dir, "HEAD", undefined)).toEqual([])
  })

  test("a project without adapter-specific macros has none", async () => {
    const dir = repo({ "macros/m.sql": "{% macro cents(x) %}{{ x }} / 100{% endmacro %}" })
    expect(await projectAdapters(dir, "HEAD", "")).toEqual([])
  })
})

describe("grepMatchesAt", () => {
  test("paths are repo-root relative from a subdirectory", async () => {
    const { grepMatchesAt } = await import("../../src/altimate/review/git")
    const dir = mkdtempSync(join(tmpdir(), "grep-"))
    mkdirSync(join(dir, "a/b"), { recursive: true })
    writeFileSync(join(dir, "a/b/s.yml"), "snapshots:\n  - name: snap\n")
    const git = (...x: string[]) => execFileSync("git", x, { cwd: dir, stdio: "ignore" })
    git("init", "-q")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    expect(await grepMatchesAt(join(dir, "a"), "HEAD", "^snapshots:", "a/*.yml")).toEqual(["HEAD:a/b/s.yml:snapshots:"])
    expect(await grepMatchesAt(dir, "HEAD", "^models:", "*.yml")).toEqual([])
  })
})

describe("projectResourceNames", () => {
  test("includes snapshots defined only in YAML", async () => {
    const { projectResourceNames } = await import("../../src/altimate/review/run")
    const dir = mkdtempSync(join(tmpdir(), "names-"))
    for (const [rel, body] of Object.entries({
      "p/models/stg_a.sql": "select 1",
      "p/snapshots/kippadb.yml": "snapshots:\n  - name: snapshot_rollup\n    relation: source('s', 't')\n",
      "p/models/props.yml": "models:\n  - name: stg_a\n",
    })) {
      mkdirSync(join(dir, rel, ".."), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
    const git = (...x: string[]) => execFileSync("git", x, { cwd: dir, stdio: "ignore" })
    git("init", "-q")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    expect([...(await projectResourceNames(dir, "HEAD", "p", join(dir, "p")))!].sort()).toEqual(["snapshot_rollup", "stg_a"])
  })

  test("working-tree mode includes models that are added but not committed", async () => {
    const { projectResourceNames } = await import("../../src/altimate/review/run")
    const dir = mkdtempSync(join(tmpdir(), "names-wt-"))
    mkdirSync(join(dir, "p/models"), { recursive: true })
    writeFileSync(join(dir, "p/models/stg_a.sql"), "select 1")
    const git = (...x: string[]) => execFileSync("git", x, { cwd: dir, stdio: "ignore" })
    git("init", "-q")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    writeFileSync(join(dir, "p/models/stg_new.sql"), "select 2")
    expect([...(await projectResourceNames(dir, undefined, "p", join(dir, "p")))!].sort()).toEqual(["stg_a", "stg_new"])
    expect([...(await projectResourceNames(dir, "HEAD", "p", join(dir, "p")))!].sort()).toEqual(["stg_a"])
  })

  test("working-tree mode reads uncommitted YAML snapshots and adapter macros from disk", async () => {
    const { projectResourceNames, projectAdapters } = await import("../../src/altimate/review/run")
    const dir = mkdtempSync(join(tmpdir(), "names-wt-yml-"))
    mkdirSync(join(dir, "p/models"), { recursive: true })
    writeFileSync(join(dir, "p/models/stg_a.sql"), "select 1")
    const git = (...x: string[]) => execFileSync("git", x, { cwd: dir, stdio: "ignore" })
    git("init", "-q")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    mkdirSync(join(dir, "p/snapshots"), { recursive: true })
    writeFileSync(join(dir, "p/snapshots/s.yml"), "snapshots:\n  - name: snap_new\n    relation: source('s', 't')\n")
    mkdirSync(join(dir, "p/macros"), { recursive: true })
    writeFileSync(join(dir, "p/macros/m.sql"), "{% macro snowflake__cents(x) %}{{ x }}{% endmacro %}")
    expect([...(await projectResourceNames(dir, undefined, "p", join(dir, "p")))!]).toContain("snap_new")
    expect(await projectAdapters(dir, undefined, "p")).toEqual(["snowflake"])
    expect(await projectAdapters(dir, "HEAD", "p")).toEqual([])
  })
})

describe("packageDocNames", () => {
  const repo = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-docs-"))
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true })
      writeFileSync(join(dir, rel), body)
    }
    const git = (...x: string[]) => execFileSync("git", x, { cwd: dir, stdio: "ignore" })
    git("init", "-q")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    return dir
  }

  test("collects docs blocks from .md files anywhere under installed dbt_packages/", async () => {
    const { packageDocNames } = await import("../../src/altimate/review/run")
    const dir = repo({ "p/packages.yml": "packages: []\n", "p/models/a.sql": "select 1" })
    // dbt_packages/ is installed (ignored in real repos), so it lives on disk only.
    mkdirSync(join(dir, "p/dbt_packages/utils/docs/deep"), { recursive: true })
    writeFileSync(join(dir, "p/dbt_packages/utils/docs/a.md"), "{% docs order_id %}x{% enddocs %}\n{%- docs amount -%}y{% enddocs %}")
    writeFileSync(join(dir, "p/dbt_packages/utils/docs/deep/b.md"), "{% docs grain %}z{% enddocs %}")
    writeFileSync(join(dir, "p/dbt_packages/utils/docs/not_md.sql"), "{% docs ignored %}{% enddocs %}")
    expect([...(await packageDocNames(dir, "HEAD", "p", join(dir, "p")))!].sort()).toEqual(["amount", "grain", "order_id"])
  })

  test("no packages declared is an empty set; declared but not installed is undefined", async () => {
    const { packageDocNames } = await import("../../src/altimate/review/run")
    const none = repo({ "p/models/a.sql": "select 1" })
    expect(await packageDocNames(none, "HEAD", "p", join(none, "p"))).toEqual(new Set())
    const missing = repo({ "p/dependencies.yml": "projects: []\n" })
    expect(await packageDocNames(missing, "HEAD", "p", join(missing, "p"))).toBeUndefined()
    expect(await packageDocNames(missing, "HEAD", undefined, join(missing, "p"))).toBeUndefined()
  })
})
