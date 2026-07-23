import { describe, test, expect } from "bun:test"
import { isManifestAffecting } from "../../src/altimate/review/run"

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
