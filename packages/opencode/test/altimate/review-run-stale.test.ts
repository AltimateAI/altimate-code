import { describe, test, expect } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { detectArtifactHints, isManifestAffecting } from "../../src/altimate/review/run"

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

describe("detectArtifactHints", () => {
  test("reports a missing catalog when both compiled directories exist", async () => {
    await using tmp = await tmpdir()
    const manifest = path.join(tmp.path, "target", "manifest.json")
    await fs.mkdir(path.dirname(manifest), { recursive: true })
    await fs.writeFile(manifest, "{}")
    await fs.mkdir(path.join(tmp.path, "target", "compiled"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "target-base", "compiled"), { recursive: true })

    expect(await detectArtifactHints(manifest, tmp.path)).toEqual(["catalog.json (run `dbt docs generate`)"])
  })

  test("reports both missing compiled directories when the catalog exists", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "target")
    const manifest = path.join(target, "manifest.json")
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(manifest, "{}")
    await fs.writeFile(path.join(target, "catalog.json"), "{}")

    expect(await detectArtifactHints(manifest, tmp.path)).toEqual([
      "target-base/compiled (compile the base ref)",
      "target/compiled (run `dbt compile` for the head)",
    ])
  })

  test("does not report artifacts when the manifest itself is absent", async () => {
    await using tmp = await tmpdir()
    expect(await detectArtifactHints(path.join(tmp.path, "target", "manifest.json"), tmp.path)).toEqual([])
  })
})
