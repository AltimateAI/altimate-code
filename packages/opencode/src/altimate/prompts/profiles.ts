// altimate_change start — workload-adaptive harness PR 1: compile-time prompt assembly.
//
// The former monolithic `builder.txt` is split into an invariant core plus named
// packs (fragments under `builder/`). This module concatenates them back into
// per-profile prompts at module load (Bun embeds `.txt` imports at compile time,
// exactly like the previous single-file import), so the assembled default is
// byte-for-byte identical to the pre-split `builder.txt` — asserted by
// `test/altimate/prompt-profiles.test.ts` against a pinned sha256.
//
// Rules for editing:
// - Fragments carry their own trailing newlines; profiles join with "" (no
//   separator). Never add separators here — that changes bytes.
// - Every fragment has exactly one owner file; a fragment may appear in more
//   than one profile, but never twice in the same profile.
// - Any wording change to a fragment changes the builder prompt bytes and must
//   update the pinned sha256 in the identity test deliberately.

import CORE from "./builder/core.txt"
import CORE_TRAINING from "./builder/core-training.txt"
import PACK_DBT_OPS from "./builder/packs/dbt-ops.txt"
import PACK_SQL_GUARD from "./builder/packs/sql-guard.txt"
import PACK_DBT_VERIFY from "./builder/packs/dbt-verify.txt"
import PACK_DBT_WORKFLOW from "./builder/packs/dbt-workflow.txt"
import PACK_PITFALLS from "./builder/packs/pitfalls.txt"
import PACK_SELF_REVIEW from "./builder/packs/self-review.txt"
import PACK_LEGACY_SKILLS from "./builder/packs/legacy-skills-catalogue.txt"
import PACK_FINISH from "./builder/packs/finish.txt"

/** Named fragments, exported for tests (ownership + composition assertions). */
export const FRAGMENTS = {
  core: CORE,
  "core-training": CORE_TRAINING,
  "dbt-ops": PACK_DBT_OPS,
  "sql-guard": PACK_SQL_GUARD,
  "dbt-verify": PACK_DBT_VERIFY,
  "dbt-workflow": PACK_DBT_WORKFLOW,
  pitfalls: PACK_PITFALLS,
  "self-review": PACK_SELF_REVIEW,
  "legacy-skills-catalogue": PACK_LEGACY_SKILLS,
  finish: PACK_FINISH,
} as const

export type FragmentName = keyof typeof FRAGMENTS

/**
 * The default (builder) profile: every fragment, in the original file order.
 * This order is load-bearing — it reproduces the pre-split `builder.txt`
 * byte-for-byte.
 */
export const BUILDER_PROFILE: readonly FragmentName[] = [
  "core",
  "dbt-ops",
  "sql-guard",
  "dbt-verify",
  "dbt-workflow",
  "pitfalls",
  "self-review",
  "legacy-skills-catalogue",
  "core-training",
  "finish",
]

/**
 * Opt-in data-qa profile: the builder prompt minus the dbt-specific packs and
 * the Pre-Execution Protocol (sql-guard) pack. Basis: an internal 540-trial
 * paired prompt ablation on a public benchmark found removing these on data-QA
 * workloads had no score effect (permutation p=0.74) and cut wall clock 27.6%.
 * Nothing selects this profile automatically — see `agent.ts`
 * (ALTIMATE_DATA_QA_PROFILE gate).
 */
export const DATA_QA_PROFILE: readonly FragmentName[] = ["core", "legacy-skills-catalogue", "core-training"]

export function assemble(profile: readonly FragmentName[]): string {
  return profile.map((name) => FRAGMENTS[name]).join("")
}

export const PROMPT_BUILDER = assemble(BUILDER_PROFILE)
export const PROMPT_DATA_QA = assemble(DATA_QA_PROFILE)
// altimate_change end
