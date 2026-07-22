import { describe, test, expect } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { gitRepoRoot, makeContentResolver } from "../../src/altimate/review/git"
import { makeCompiledResolver } from "../../src/altimate/review/compiled"

const exec = promisify(execFile)

/**
 * Regression coverage for the subdir-invocation content-resolution MAJOR
 * (PR #1027 consensus review, finding 1). The three affected code paths —
 * `makeContentResolver` working-tree read, `warnIfStale` file existence check,
 * and `makeCompiledResolver` compiled-SQL lookup — all previously joined
 * repo-relative paths (from `git diff --name-status`) with the caller's
 * `opts.cwd`, silently ENOENT-ing when the CLI was invoked from a subdir.
 *
 * These tests build a small git repo in a temp dir, invoke resolvers from a
 * subdir, and assert content is still found via the resolved git top-level.
 */

async function mkTempRepo(): Promise<{ root: string; sub: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "review-subdir-invocation-"))
  const sub = path.join(root, "packages", "dbt")
  await fs.mkdir(sub, { recursive: true })
  await fs.mkdir(path.join(sub, "models", "marts"), { recursive: true })
  await fs.writeFile(path.join(sub, "models", "marts", "customers.sql"), "-- customers content\n")
  await exec("git", ["init", "-q"], { cwd: root })
  await exec("git", ["config", "user.email", "t@test"], { cwd: root })
  await exec("git", ["config", "user.name", "t"], { cwd: root })
  await exec("git", ["add", "."], { cwd: root })
  await exec("git", ["commit", "-qm", "seed"], { cwd: root })
  return { root, sub }
}

describe("R20: subdir-invocation content resolution (PR #1027 consensus MAJOR)", () => {
  test("gitRepoRoot resolves the same top-level from repo root and from a subdir", async () => {
    const { root, sub } = await mkTempRepo()
    const fromRoot = await gitRepoRoot(root)
    const fromSub = await gitRepoRoot(sub)
    // `git rev-parse --show-toplevel` may emit a path with a `/private` prefix
    // on macOS (symlink resolution); compare via realpath so the test is
    // portable across platforms.
    expect(await fs.realpath(fromRoot!)).toBe(await fs.realpath(root))
    expect(await fs.realpath(fromSub!)).toBe(await fs.realpath(root))
  })

  test("gitRepoRoot returns undefined outside a git repo", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "not-a-repo-"))
    const r = await gitRepoRoot(dir)
    expect(r).toBeUndefined()
  })

  test("makeContentResolver working-tree branch reads via gitRoot when invoked from subdir", async () => {
    const { root, sub } = await mkTempRepo()
    // Simulating the CI-side path where a caller invokes the review from a
    // subdir (`sub`). The gitRoot option lets working-tree reads use the
    // resolved top-level.
    const resolver = makeContentResolver({ base: "HEAD", cwd: sub, gitRoot: root })
    const content = await resolver("packages/dbt/models/marts/customers.sql", "new")
    expect(content).toBe("-- customers content\n")
  })

  test("makeContentResolver without gitRoot falls back to opts.cwd (legacy behavior)", async () => {
    // When gitRoot is omitted, working-tree reads join with opts.cwd. When
    // the CLI is invoked from the repo root this is correct; from a subdir
    // it silently ENOENTs. Regression guard: the fallback path is
    // exercised (returns undefined without throwing) so the legacy call
    // sites still work.
    const { root, sub } = await mkTempRepo()
    const resolver = makeContentResolver({ base: "HEAD", cwd: sub })
    // Subdir cwd + repo-relative file = path-doubling → ENOENT → undefined.
    const missing = await resolver("packages/dbt/models/marts/customers.sql", "new")
    expect(missing).toBeUndefined()
    // From the repo root the same file is found (baseline check).
    const found = await makeContentResolver({ base: "HEAD", cwd: root })(
      "packages/dbt/models/marts/customers.sql",
      "new",
    )
    expect(found).toBe("-- customers content\n")
  })

  test("makeCompiledResolver strips the git-root → dbt-root pathPrefix", async () => {
    // Simulate a monorepo where dbt lives at packages/dbt/ and compiled SQL
    // is written by `dbt compile` to packages/dbt/target/compiled/<project>/.
    // File paths from `git diff --name-status` are repo-root relative
    // (packages/dbt/models/marts/foo.sql). Without prefix-stripping the
    // resolver looks for target/compiled/<project>/packages/dbt/models/…
    // (wrong: nested duplication) and misses the compiled artifact.
    const { root } = await mkTempRepo()
    const dbtRoot = path.join(root, "packages", "dbt")
    const project = "acme"
    const compiledPath = path.join(dbtRoot, "target", "compiled", project, "models", "marts", "customers.sql")
    await fs.mkdir(path.dirname(compiledPath), { recursive: true })
    await fs.writeFile(compiledPath, "-- compiled customers\n")

    const resolver = makeCompiledResolver({
      cwd: dbtRoot,
      projectName: project,
      pathPrefix: "packages/dbt",
    })
    const content = await resolver("packages/dbt/models/marts/customers.sql", "new")
    expect(content).toBe("-- compiled customers\n")
  })

  test("makeCompiledResolver pathPrefix is a no-op when unset (repo-root-invoked case)", async () => {
    const { root } = await mkTempRepo()
    const project = "acme"
    const compiledPath = path.join(root, "target", "compiled", project, "models", "marts", "customers.sql")
    await fs.mkdir(path.dirname(compiledPath), { recursive: true })
    await fs.writeFile(compiledPath, "-- compiled at root\n")

    const resolver = makeCompiledResolver({ cwd: root, projectName: project })
    const content = await resolver("models/marts/customers.sql", "new")
    expect(content).toBe("-- compiled at root\n")
  })

  test("makeCompiledResolver pathPrefix does NOT strip when path doesn't start with prefix", async () => {
    // Precision guard: a file outside the prefixed subtree must remain
    // untouched. Repo-relative `docs/foo.md` with prefix `packages/dbt`
    // → still `docs/foo.md` (no lookup match, returns undefined).
    const { root } = await mkTempRepo()
    const resolver = makeCompiledResolver({
      cwd: path.join(root, "packages", "dbt"),
      projectName: "acme",
      pathPrefix: "packages/dbt",
    })
    const content = await resolver("docs/foo.md", "new")
    expect(content).toBeUndefined()
  })

  test("makeCompiledResolver pathPrefix normalises Windows backslashes to forward slashes (codex round-5 HIGH)", async () => {
    // `path.relative()` on Windows returns `packages\dbt` while git diff paths
    // are always POSIX-separated. If the resolver didn't normalise the prefix,
    // no repo-relative file path would match it and compiled SQL would be
    // silently missed on Windows monorepos.
    const { root } = await mkTempRepo()
    const dbtRoot = path.join(root, "packages", "dbt")
    const project = "acme"
    const compiledPath = path.join(dbtRoot, "target", "compiled", project, "models", "customers.sql")
    await fs.mkdir(path.dirname(compiledPath), { recursive: true })
    await fs.writeFile(compiledPath, "-- compiled via backslash prefix\n")

    // Simulate the Windows caller: pathPrefix contains `\` separators; the
    // repo-relative file path from `git diff` still uses `/`.
    const resolver = makeCompiledResolver({
      cwd: dbtRoot,
      projectName: project,
      pathPrefix: "packages\\dbt",
    })
    const content = await resolver("packages/dbt/models/customers.sql", "new")
    expect(content).toBe("-- compiled via backslash prefix\n")
  })

  test("makeCompiledResolver pathPrefix accepts '.' as a no-op alias", async () => {
    // `path.relative(root, root)` returns "" — treat "" and "." as
    // equivalent to "no prefix" so callers don't need branching logic.
    const { root } = await mkTempRepo()
    const project = "acme"
    const compiledPath = path.join(root, "target", "compiled", project, "models", "customers.sql")
    await fs.mkdir(path.dirname(compiledPath), { recursive: true })
    await fs.writeFile(compiledPath, "-- via dot prefix\n")
    const resolver = makeCompiledResolver({ cwd: root, projectName: project, pathPrefix: "." })
    expect(await resolver("models/customers.sql", "new")).toBe("-- via dot prefix\n")
  })
})
