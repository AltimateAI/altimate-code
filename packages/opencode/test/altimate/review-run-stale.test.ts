import { describe, test, expect } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { detectArtifactHints, isManifestAffecting, reviewPullRequest } from "../../src/altimate/review/run"
import { renderSummary } from "../../src/altimate/review/format"

const USABLE_CATALOG = JSON.stringify({
  nodes: {
    "model.analytics.fixture": {
      metadata: { name: "fixture" },
      columns: { id: { name: "id", type: "integer" } },
    },
  },
})

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
  test("returns no hints when no models changed, even when the catalog is absent", async () => {
    await using tmp = await tmpdir()
    const manifest = path.join(tmp.path, "target", "manifest.json")
    await fs.mkdir(path.dirname(manifest), { recursive: true })
    await fs.writeFile(manifest, "{}")

    expect(await detectArtifactHints(manifest, tmp.path)).toEqual([])
  })

  test("distinguishes a missing catalog from an unreadable or empty catalog", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "target")
    const manifest = path.join(target, "manifest.json")
    const changedModels = [{ path: "models/a.sql", status: "added" as const }]
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(manifest, "{}")

    expect(await detectArtifactHints(manifest, tmp.path, changedModels, "analytics")).toContain(
      "catalog.json (run `dbt docs generate`)",
    )

    for (const contents of ["{}", "{not json"]) {
      await fs.writeFile(path.join(target, "catalog.json"), contents)
      expect(await detectArtifactHints(manifest, tmp.path, changedModels, "analytics")).toContain(
        "catalog.json unreadable or empty (regenerate with `dbt docs generate`)",
      )
    }
  })

  test("reports both missing compiled directories when the catalog exists", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "target")
    const manifest = path.join(target, "manifest.json")
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(manifest, "{}")
    await fs.writeFile(path.join(target, "catalog.json"), USABLE_CATALOG)

    expect(
      await detectArtifactHints(
        manifest,
        tmp.path,
        [{ path: "models/a.sql", status: "modified" }],
        "analytics",
      ),
    ).toEqual([
      "target-base/compiled missing for 1 changed model(s) (compile the base ref)",
      "target/compiled missing for 1 changed model(s) (run `dbt compile` for the head)",
    ])
  })

  test("reports changed models missing from a partially populated compiled directory", async () => {
    await using tmp = await tmpdir()
    const project = "analytics"
    const target = path.join(tmp.path, "target")
    const manifest = path.join(target, "manifest.json")
    await fs.mkdir(path.join(target, "compiled", project, "models"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "target-base", "compiled", project, "models"), { recursive: true })
    await fs.writeFile(manifest, "{}")
    await fs.writeFile(path.join(target, "catalog.json"), USABLE_CATALOG)
    await fs.writeFile(path.join(target, "compiled", project, "models", "a.sql"), "select 1")
    await fs.writeFile(path.join(tmp.path, "target-base", "compiled", project, "models", "a.sql"), "select 1")
    await fs.writeFile(path.join(tmp.path, "target-base", "compiled", project, "models", "b.sql"), "select 1")

    expect(
      await detectArtifactHints(
        manifest,
        tmp.path,
        [
          { path: "models/a.sql", status: "modified" },
          { path: "models/b.sql", status: "modified" },
        ],
        project,
      ),
    ).toEqual(["target/compiled missing for 1 changed model(s) (run `dbt compile` for the head)"])
  })

  test("uses compiled SQL beside a custom manifest and prefers its sibling base directory", async () => {
    await using tmp = await tmpdir()
    const project = "analytics"
    const build = path.join(tmp.path, "build")
    const headModel = path.join(build, "compiled", project, "models", "a.sql")
    const siblingBaseModel = path.join(tmp.path, "build-base", "compiled", project, "models", "a.sql")
    const fallbackBaseModel = path.join(tmp.path, "target-base", "compiled", project, "models", "a.sql")
    await fs.mkdir(path.dirname(headModel), { recursive: true })
    await fs.mkdir(path.dirname(siblingBaseModel), { recursive: true })
    await fs.mkdir(path.dirname(fallbackBaseModel), { recursive: true })
    await fs.writeFile(path.join(build, "manifest.json"), "{}")
    await fs.writeFile(path.join(build, "catalog.json"), USABLE_CATALOG)
    await fs.writeFile(headModel, "select 1")
    await fs.writeFile(fallbackBaseModel, "select 1")

    const manifest = path.join(build, "manifest.json")
    const changedModels = [{ path: "models/a.sql", status: "modified" as const }]
    // The sibling `build-base/compiled` DIRECTORY already exists (created above), so it is
    // preferred over `target-base/compiled` even though only the fallback holds `a.sql`.
    // The hint therefore names the sibling; the fallback is never consulted once the
    // sibling directory is present.
    expect(await detectArtifactHints(manifest, tmp.path, changedModels, project)).toEqual([
      "build-base/compiled missing for 1 changed model(s) (compile the base ref)",
    ])

    await fs.writeFile(siblingBaseModel, "select 1")
    expect(await detectArtifactHints(manifest, tmp.path, changedModels, project)).toEqual([])
  })

  test("uses the sole base project directory and oldPath when the dbt project was renamed", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "target")
    const manifest = path.join(target, "manifest.json")
    const headModel = path.join(target, "compiled", "new_analytics", "models", "new_name.sql")
    const baseModel = path.join(tmp.path, "target-base", "compiled", "old_analytics", "models", "old_name.sql")
    await fs.mkdir(path.dirname(headModel), { recursive: true })
    await fs.mkdir(path.dirname(baseModel), { recursive: true })
    await fs.writeFile(manifest, "{}")
    await fs.writeFile(path.join(target, "catalog.json"), USABLE_CATALOG)
    await fs.writeFile(headModel, "select 1")
    await fs.writeFile(baseModel, "select 1")

    expect(
      await detectArtifactHints(
        manifest,
        tmp.path,
        [{ path: "models/new_name.sql", oldPath: "models/old_name.sql", status: "renamed" }],
        "new_analytics",
      ),
    ).toEqual([])
  })

  test("reports an ambiguous base project directory without assuming the head project name", async () => {
    await using tmp = await tmpdir()
    const project = "analytics"
    const target = path.join(tmp.path, "target")
    const manifest = path.join(target, "manifest.json")
    const headModel = path.join(target, "compiled", project, "models", "a.sql")
    const baseRoot = path.join(tmp.path, "target-base", "compiled")
    await fs.mkdir(path.dirname(headModel), { recursive: true })
    await fs.mkdir(path.join(baseRoot, "old_analytics"), { recursive: true })
    await fs.mkdir(path.join(baseRoot, "legacy_analytics"), { recursive: true })
    await fs.writeFile(manifest, "{}")
    await fs.writeFile(path.join(target, "catalog.json"), USABLE_CATALOG)
    await fs.writeFile(headModel, "select 1")

    expect(
      await detectArtifactHints(
        manifest,
        tmp.path,
        [{ path: "models/a.sql", status: "modified" }],
        project,
      ),
    ).toEqual(["target-base/compiled has several project directories; expected `analytics`"])
  })

  test("does not request a catalog or compiled SQL for a deletion-only diff", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "target")
    const manifest = path.join(target, "manifest.json")
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(manifest, "{}")

    expect(
      await detectArtifactHints(
        manifest,
        tmp.path,
        [{ path: "models/deleted.sql", status: "deleted" }],
        "analytics",
      ),
    ).toEqual([])
  })

  test("does not report artifacts when the manifest itself is absent", async () => {
    await using tmp = await tmpdir()
    expect(
      await detectArtifactHints(
        path.join(tmp.path, "target", "manifest.json"),
        tmp.path,
        [{ path: "models/a.sql", status: "modified" }],
        "analytics",
      ),
    ).toEqual([])
  })

  test("reports an unresolved project name once and keeps the catalog hint", async () => {
    await using tmp = await tmpdir()
    const manifest = path.join(tmp.path, "target", "manifest.json")
    await fs.mkdir(path.dirname(manifest), { recursive: true })
    await fs.writeFile(manifest, "{}")

    expect(
      await detectArtifactHints(manifest, tmp.path, [
        { path: "models/a.sql", status: "modified" },
        { path: "models/b.sql", status: "modified" },
      ]),
    ).toEqual([
      "catalog.json (run `dbt docs generate`)",
      "dbt project name not resolved — no readable dbt_project.yml next to the manifest, so compiled SQL cannot be located",
    ])
  })
})

async function writeDbtArtifacts(root: string, catalog = false) {
  const target = path.join(root, "target")
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(
    path.join(target, "manifest.json"),
    JSON.stringify({
      metadata: { adapter_type: "duckdb" },
      nodes: {
        "model.analytics.existing": {
          resource_type: "model",
          name: "existing",
          original_file_path: "models/existing.sql",
          depends_on: { nodes: [] },
        },
      },
      sources: {},
    }),
  )
  if (catalog) await fs.writeFile(path.join(target, "catalog.json"), USABLE_CATALOG)
  await fs.writeFile(path.join(root, "dbt_project.yml"), "name: analytics\n")
}

describe("review artifact hint scope", () => {
  test("a README-only diff renders only the empty-scope message", async () => {
    await using tmp = await tmpdir()
    await writeDbtArtifacts(tmp.path)

    const env = await reviewPullRequest({
      cwd: tmp.path,
      changedFiles: [{ path: "README.md", status: "modified", diff: "+docs\n" }],
      getContent: async () => undefined,
      noAi: true,
    })
    const summary = renderSummary(env)

    expect(summary).toContain("Nothing to review")
    expect(summary).not.toContain("Missing artifacts")
    expect(summary).not.toContain("No issues found")
    expect(summary).not.toContain("AI reviewer:")
  })

  test("excluded models and tracked compiled output do not produce hints", async () => {
    await using tmp = await tmpdir()
    await writeDbtArtifacts(tmp.path)
    await fs.mkdir(path.join(tmp.path, ".altimate"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, ".altimate", "review.yml"), "exclude:\n  - models/excluded.sql\n")

    const env = await reviewPullRequest({
      cwd: tmp.path,
      changedFiles: [
        { path: "models/excluded.sql", status: "modified", diff: "+select 1\n" },
        { path: "target/compiled/analytics/models/x.sql", status: "modified", diff: "+select 1\n" },
      ],
      getContent: async () => undefined,
      noAi: true,
    })

    expect(env.summary.artifactHints).toEqual([])
  })

  test("a changed Python model is included in compiled artifact hints", async () => {
    await using tmp = await tmpdir()
    await writeDbtArtifacts(tmp.path, true)

    const env = await reviewPullRequest({
      cwd: tmp.path,
      changedFiles: [{ path: "models/new_model.py", status: "added", diff: "+def model(): pass\n" }],
      getContent: async () => undefined,
      noAi: true,
    })

    expect(env.summary.artifactHints).toEqual([
      "target/compiled missing for 1 changed model(s) (run `dbt compile` for the head)",
    ])
  })
})
