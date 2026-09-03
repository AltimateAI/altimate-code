// Fork-only module — owns the PRE-EXECUTION PROTOCOL SCOPING CONTRACT.
//
// The protocol used to sit statically in `altimate/prompts/builder.txt`.
// builder is a PRIMARY agent, so a static section there governs every builder
// surface at once: dbt authoring, interactive chat, and headless
// question-answering runs. A pre-registered paired ablation (540 trials on a
// public data-question benchmark, one binary across both arms) measured what
// the section costs on the question-answering surface:
//
//   macro Pass@1  control 0.6667 → treatment 0.6807
//   delta +0.0140, query-blocked permutation p = 0.7358,
//   cluster-bootstrap 95% CI [-0.0400, +0.0674]   → no score effect
//   wall clock  440.9s → 319.4s  (-27.6%)
//   model turns -27.7%, generation time -32.2%
//   `altimate_core_validate` + `sql_analyze` calls  2,805 → 0
//   `sql_execute` calls  +49%   (the freed budget went into real querying)
//
// The 2,805 → 0 is the one number directly attributable to this text: the
// ritual is prompt-ordered, and deleting the order deletes it completely. The
// latency win is NOT attributable to this section alone — that treatment arm
// bundled five coupled changes and the experiment declined to attribute.
//
// So this module SCOPES rather than deletes. The measurement covers exactly
// one cell — headless question-answering in a workspace with no dbt project —
// and that is the only cell where the protocol is dropped. dbt work and
// interactive chat, where a pre-execution discipline may genuinely earn its
// place, are unmeasured and keep it. Anything that cannot be classified
// confidently keeps it too: the cost of keeping it is latency on one workload,
// the cost of wrongly dropping it is unmeasured.
//
// MECHANISM (reworked onto the pack architecture — `altimate/prompts/profiles.ts`,
// PR #1217): `builder.txt` no longer exists. The protocol is the `sql-guard`
// pack, and it ships statically inside the default `builder` agent's `.prompt`
// (`PromptProfiles.PROMPT_BUILDER`, byte-pinned by
// `test/altimate/prompt-profiles.test.ts`) so it is present by default in every
// case. This module no longer INJECTS the text — there is nothing to inject,
// it is already there. Instead `scopedBuilderPrompt` returns a per-session
// override prompt (`PromptProfiles.PROMPT_BUILDER_SCOPED`, the same profile
// with the sql-guard pack excluded) for the one cell the ablation covers, or
// `undefined` to mean "use the agent's default prompt unchanged". The call
// site (session/prompt.ts) clones the resolved `Agent.Info` with `.prompt`
// swapped only when this returns a value — the default static registration in
// agent.ts, and the byte-identity pin, are never touched.
//
// Directive commentary lives here (not at the call site) so any change to the
// gate's reasoning reviews in ONE file, mirroring session/termination.ts.

import fs from "fs/promises"
import path from "path"
import { PromptProfiles } from "../altimate/prompts/profiles"
import { Log } from "../util/log"

const log = Log.create({ service: "pre-execution-scope" })

/** Files that mark a directory as a dbt project root. */
const PROJECT_FILES = ["dbt_project.yml", "dbt_project.yaml"] as const

/**
 * Subdirectories never considered candidates for a nested dbt project, mirroring
 * `findDbtProjectRoot`'s skip list so a fixture project shipped inside
 * `node_modules/foo/` or a compiled artifact in `target/` is not mistaken for
 * the user's real project.
 */
const SKIP_DIRS = new Set(["node_modules", "target"])

/**
 * The `errno` code of a filesystem rejection, when it carries one.
 *
 * `ENOENT` and `ENOTDIR` are real answers — nothing is there. Every other code,
 * and an error carrying no code at all, means the question went unanswered.
 */
function errnoCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined
  const code = err.code
  return typeof code === "string" ? code : undefined
}

/** True when a rejection means "nothing is there", rather than "could not tell". */
function meansAbsent(err: unknown): boolean {
  const code = errnoCode(err)
  return code === "ENOENT" || code === "ENOTDIR"
}

/**
 * How a workspace classifies for the purpose of this gate.
 *
 * `unknown` is a real, load-bearing state, not a placeholder: it is what we
 * report when the filesystem could not answer the question, and it keeps the
 * protocol. The existing `findDbtProjectRoot` helper cannot serve this gate
 * directly because it collapses "no project here" and "could not look here"
 * into the same `null`, and this gate turns a directive off on the difference.
 */
export type WorkspaceShape = "dbt" | "non-dbt" | "unknown"

/**
 * Does `dir` itself contain a dbt project file?
 *
 * Returns `undefined` — not `false` — when the filesystem could not answer.
 * ENOENT and ENOTDIR are real answers ("nothing there"); anything else (EACCES,
 * EIO, a transient network mount failure) is not, and must not be read as
 * "no dbt project here".
 */
async function hasProjectFile(dir: string): Promise<boolean | undefined> {
  let sawUnknown = false
  for (const name of PROJECT_FILES) {
    try {
      if ((await fs.stat(path.join(dir, name))).isFile()) return true
    } catch (err) {
      if (meansAbsent(err)) continue
      log.warn("project-file probe failed", { dir, name, code: errnoCode(err) })
      sawUnknown = true
    }
  }
  return sawUnknown ? undefined : false
}

/**
 * Classify a workspace by the presence of a dbt project.
 *
 * `dbt` requires an actual `dbt_project.yml` (or `.yaml`) FILE at, above, or
 * one level below a candidate directory:
 *
 *   - **at** the candidate,
 *   - **above** it, every ancestor up to the filesystem root. A session is
 *     routinely started inside `models/`, and on a non-git project the worktree
 *     candidate is the same directory, so nothing else would find the project.
 *     The walk is deliberately unbounded: a depth limit would have to report
 *     "I stopped early" as `unknown` to stay honest, which on any deep tree
 *     turns the gate off entirely. Two `stat` calls per level, in run mode
 *     only, is not worth that.
 *   - **one level below** it, which is how benchmark and monorepo layouts nest
 *     a project (the same rule, and the same skip list, as
 *     `findDbtProjectRoot`).
 *
 * A project found in an unrelated ancestor is a false positive that KEEPS the
 * protocol, which is the safe direction.
 *
 * `non-dbt` requires at least one candidate the scan examined COMPLETELY — its
 * symlinks resolved, every ancestor probe answered up to the root, and its own
 * children enumerated and probed — with no project found. If no candidate
 * managed that, the answer is `unknown`, which keeps the protocol. One complete
 * answer is enough: the ancestor walk from that candidate already covers the
 * worktree above it, so a partner candidate that could not be read has nothing
 * left to contribute.
 */
export async function classifyWorkspace(candidates: (string | undefined)[]): Promise<WorkspaceShape> {
  const dirs = [...new Set(candidates.filter((d): d is string => !!d))]
  let sawCompleteAnswer = false

  for (const dir of dirs) {
    let complete = true

    // Resolve symlinks first. `path.resolve` is lexical, so a symlinked cwd
    // (`/tmp/ws` -> `/repo/models`) would walk `/tmp` and `/` and never see the
    // project the session is actually inside.
    let start: string
    try {
      start = await fs.realpath(dir)
    } catch (err) {
      if (!meansAbsent(err)) log.warn("candidate realpath failed", { dir, code: errnoCode(err) })
      continue
    }

    // At the candidate, then upwards to the filesystem root.
    let current = start
    for (;;) {
      const found = await hasProjectFile(current)
      if (found === true) return "dbt"
      if (found === undefined) complete = false
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }

    // One level below. The filesystem root is a legitimate stop rather than a
    // directory to enumerate — a non-git project sets worktree to it, and
    // scanning its children is meaningless and can be slow or permission-denied
    // — so the root on its own never yields a complete answer.
    if (start === path.parse(start).root) {
      complete = false
    } else {
      let entries
      try {
        entries = await fs.readdir(start, { withFileTypes: true })
      } catch (err) {
        if (!meansAbsent(err)) log.warn("workspace enumeration failed", { dir: start, code: errnoCode(err) })
        entries = undefined
      }
      if (entries === undefined) {
        complete = false
      } else {
        // Probe everything that is not plainly a regular file. Filtering on
        // `isDirectory()` would silently skip symlinked directories and any
        // entry whose type the filesystem did not report, and a skipped entry
        // is an unexamined one. `hasProjectFile` on a non-directory just gets
        // ENOTDIR, which is a real "nothing there".
        const children = entries
          .filter((e) => !e.isFile() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
          // Deterministic order: fs.readdir's order varies across filesystems.
          .sort((a, b) => a.name.localeCompare(b.name))
        for (const child of children) {
          const found = await hasProjectFile(path.join(start, child.name))
          if (found === true) return "dbt"
          if (found === undefined) complete = false
        }
      }
    }

    if (complete) sawCompleteAnswer = true
  }

  return sawCompleteAnswer ? "non-dbt" : "unknown"
}

/**
 * The sole gate for scoping the pre-execution protocol (the `sql-guard` pack)
 * out of the builder prompt.
 *
 * Returns a full replacement prompt to use INSTEAD of the agent's default
 * `.prompt`, or `undefined` to mean "use the default, unchanged" — the
 * default already carries the protocol, since it ships statically in
 * `PromptProfiles.PROMPT_BUILDER`. The ONLY case this returns an override is
 * the one the ablation measured:
 *
 *   run mode (headless / CI, the `run` CLI)  AND
 *   the builder agent (the only profile that ever carried the pack)  AND
 *   a workspace confidently classified as having no dbt project.
 *
 * Everything else returns `undefined`, including `unknown`. Note the asymmetry
 * is deliberate: run mode is not itself a task-shape signal, it is the surface
 * the evidence covers. Widening this to interactive chat needs its own
 * measurement.
 *
 * Classification is only performed when the cheap conditions already hold, so
 * an interactive session pays no filesystem cost for this gate.
 */
export async function scopedBuilderPrompt(input: {
  runMode: boolean
  agent: string
  /** Candidate directories to classify — typically the cwd and the worktree root. */
  directories: (string | undefined)[]
}): Promise<string | undefined> {
  // Only builder ever carried this pack; analyst and reviewer never did.
  if (input.agent !== "builder") return undefined
  if (!input.runMode) return undefined
  const shape = await classifyWorkspace(input.directories)
  if (shape !== "non-dbt") return undefined
  log.info("pre-execution protocol scoped out", { agent: input.agent, shape })
  return PromptProfiles.PROMPT_BUILDER_SCOPED
}

export * as SessionPreExecution from "./pre-execution"
