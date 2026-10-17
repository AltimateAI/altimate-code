// altimate_change start — dbt-impact compiled diff mode: compare the
// `compiled_code` of the base and head manifests instead of a naive Jinja
// render, so `{% set %}`, vars and macros no longer leave a model UNCLASSIFIED.
import { execFile } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { promisify } from "util"
import { dbtCompileOffline, type DbtOfflineOptions } from "../../altimate/native/dbt/runner"
import { configUniqueKey, type DbtChange, type DiffChanges, naiveRender } from "./dbt-impact-helpers"
import type { Manifest, ManifestNode } from "./dbt-mart-helpers"

const exec = promisify(execFile)

const norm = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim()

function models(m: Manifest): Map<string, ManifestNode> {
  const out = new Map<string, ManifestNode>()
  for (const [id, n] of Object.entries(m.nodes ?? {}))
    if (n.resource_type === "model" && (n.config as { enabled?: boolean } | undefined)?.enabled !== false) out.set(id, n)
  return out
}

const cfg = (n: ManifestNode, k: string) => (n.config as Record<string, unknown> | undefined)?.[k]

/**
 * The impact changes between two manifests. Per model (restricted to `only`
 * names when given): gone in head → `drop`; a changed `materialized` →
 * `materialization`; different `compiled_code` → a `sql` change on the
 * compiled SQL. A model compiled on neither side falls back to the naive
 * render of `raw_code`, and is unclassified only when that fails too.
 */
export function changesFromManifests(base: Manifest, head: Manifest, only?: Set<string>): DiffChanges {
  const b = models(base)
  const h = models(head)
  const changes: DbtChange[] = []
  const unclassified: DiffChanges["unclassified"] = []
  const keep = (n: ManifestNode) => !only || only.has(String(n.name))
  for (const [id, bn] of b) {
    if (!keep(bn)) continue
    const model = String(bn.name)
    const hn = h.get(id)
    if (!hn) {
      changes.push({ model, kind: "drop" })
      continue
    }
    const [from, to] = [cfg(bn, "materialized"), cfg(hn, "materialized")] as Array<string | undefined>
    if (from !== to && to) {
      const c: DbtChange = { model, kind: "materialization", from, to }
      const strategy = cfg(hn, "incremental_strategy")
      if (typeof strategy === "string") c.incremental_strategy = strategy
      const uk = cfg(hn, "unique_key")
      const keys = typeof uk === "string" ? [uk] : Array.isArray(uk) ? uk.map(String) : configUniqueKey(hn.raw_code)
      if (keys.length) c.unique_key = keys
      changes.push(c)
    }
    const [bc, hc] = [norm(bn.compiled_code), norm(hn.compiled_code)]
    if (bc && hc) {
      if (bc !== hc)
        changes.push({ model, kind: "sql", base_sql: String(bn.compiled_code), head_sql: String(hn.compiled_code) })
      continue
    }
    if (norm(bn.raw_code) === norm(hn.raw_code)) continue
    const [br, hr] = [naiveRender(bn.raw_code ?? ""), naiveRender(hn.raw_code ?? "")]
    if (br === undefined || hr === undefined) {
      unclassified.push({ model, reason: "not compiled on both sides, and uses Jinja beyond ref/source/config" })
      continue
    }
    if (br.trim() !== hr.trim()) changes.push({ model, kind: "sql", base_sql: br, head_sql: hr })
  }
  return { changes, unclassified }
}

/** A project tree at a git ref, extracted into `dest` without touching the
 *  repository (`git archive`). Returns the project directory inside it. */
export async function extractTree(gitRoot: string, ref: string, relProject: string, dest: string): Promise<string> {
  mkdirSync(dest, { recursive: true })
  const tar = path.join(dest, "..", `${path.basename(dest)}.tar`)
  await exec("git", ["archive", "--format=tar", "-o", tar, ref, ...(relProject ? ["--", relProject] : [])], {
    cwd: gitRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
  await exec("tar", ["-xf", tar, "-C", dest])
  rmSync(tar, { force: true })
  return path.join(dest, relProject)
}

export interface CompiledSides {
  baseManifest?: string
  headManifest?: string
  /** The head project directory (for `dbt ls`). */
  headDir: string
  notes: string[]
  cleanup: () => void
}

export type CompileFn = typeof dbtCompileOffline

/**
 * Compile both sides of a diff into a temp dir: base from `git archive`, head
 * from `git archive` (or the working tree when `head` is omitted, with every
 * artifact redirected to the temp dir). Only the changed models are compiled
 * on base, and the changed models plus their descendants on head. A side
 * whose compile fails keeps whatever manifest dbt wrote (parse only), and the
 * failure is reported.
 */
export async function compileSides(input: {
  projectDir: string
  gitRoot: string
  base: string
  head?: string
  changed: string[]
  dbt: Pick<DbtOfflineOptions, "dbtBin" | "profilesDir" | "target">
  compile?: CompileFn
}): Promise<CompiledSides> {
  const compile = input.compile ?? dbtCompileOffline
  const tmp = mkdtempSync(path.join(tmpdir(), "dbt-impact-"))
  const cleanup = () => {
    if (!process.env.ALTIMATE_KEEP_IMPACT_TMP) rmSync(tmp, { recursive: true, force: true })
  }
  const rel = path.relative(input.gitRoot, input.projectDir)
  const profilesDir =
    input.dbt.profilesDir ?? (existsSync(path.join(input.projectDir, "profiles.yml")) ? input.projectDir : undefined)
  const notes: string[] = []
  const withPackages = (dir: string) => {
    const pk = path.join(input.projectDir, "dbt_packages")
    if (dir !== input.projectDir && existsSync(pk) && !existsSync(path.join(dir, "dbt_packages")))
      symlinkSync(pk, path.join(dir, "dbt_packages"))
  }
  const side = async (name: "base" | "head", dir: string, select: string[]) => {
    withPackages(dir)
    const targetPath = path.join(tmp, `${name}-target`)
    const r = await compile(select, {
      projectDir: dir,
      dbtBin: input.dbt.dbtBin,
      profilesDir,
      target: input.dbt.target,
      targetPath,
      logPath: path.join(tmp, `${name}-logs`),
    })
    const manifest = path.join(targetPath, "manifest.json")
    if (!r.ok) notes.push(`${name}: dbt compile failed (${r.error ?? "unknown error"}); uncompiled models fall back to the raw SQL`)
    else if (!r.offline) notes.push(`${name}: compiled with a warehouse connection (the offline compile needed introspection)`)
    return existsSync(manifest) ? manifest : undefined
  }
  try {
    const baseDir = await extractTree(input.gitRoot, input.base, rel, path.join(tmp, "base"))
    const headDir = input.head
      ? await extractTree(input.gitRoot, input.head, rel, path.join(tmp, "head"))
      : input.projectDir
    const baseManifest = await side("base", baseDir, input.changed)
    const headManifest = await side(
      "head",
      headDir,
      input.changed.map((m) => `${m}+`),
    )
    return { baseManifest, headManifest, headDir, notes, cleanup }
  } catch (e) {
    notes.push(`could not prepare the base/head trees: ${e instanceof Error ? e.message : String(e)}`)
    return { headDir: input.projectDir, notes, cleanup }
  }
}
// altimate_change end
