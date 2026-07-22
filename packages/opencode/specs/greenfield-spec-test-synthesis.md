# Spec: Auxiliary spec-test synthesis for greenfield dbt models

Status: draft (rev 2 — Codex review folded in) · Owner: anand · 2026-07-07
Scope: `packages/opencode/src/altimate/review/*` (dbt-pr-review)

> **rev 2 changelog (Codex adversarial review, 2026-07-07).** The rev-1 honesty
> guard (a `derivedFrom` tag check) was necessary but **not sufficient** — it
> catches invented refs but not *back-labeling* (assert current output, then tag
> it with a real column). Rev 2 removes LLM trust from the blocking path
> entirely: block-eligible tests are **deterministically materialized from parsed
> declared constraints**, never LLM-authored; everything the LLM proposes is
> advisory and structurally cannot block. See §2, §3.5, §3.6.

## 1. Problem

dbt-pr-review has two verification worlds:

- **Reference-exists** (a `modified` model): base SQL is a trusted reference, so
  `semanticChangeLane` → `runner.equivalence(oldSql, newSql)` gives a provable
  non-regression claim. This branch works today.
- **Greenfield** (an `added` model): no reference. Today only lint/grade
  (`qualityLane`), PII, `dbtConfigLane`, and `missingGrainTestLane` fire — and
  the last only *flags* "this new model has no uniqueness test." The reviewer
  detects the missing coverage but does nothing about it.

The BAIR "Intelligence is Free" piece (data systems *by* agents) names the fix:
specs are imperfect, so pair the artifact with an auxiliary agent that generates
test cases to expand the spec. Applied here, for a greenfield model, in two
strictly separated tracks:

1. **Materialize declared-but-unenforced constraints** (deterministic, no LLM).
   The author declared `not_null`/`unique`/`accepted_values`/`relationships` or a
   contract column type, but no test actually enforces it. We build the check
   from the *parsed* constraint and run it. A failure here is a real, provable
   violation of an author-committed constraint → block-eligible.
2. **Propose new tests from soft intent** (LLM, advisory). Column descriptions,
   `ref()` edges, naming conventions, PR text. These are hypotheses about intent,
   offered as a committable patch. They **never block** and are labeled as
   candidates, not verification.

## 2. The crux: where LLM output is allowed to matter

An LLM told to "write tests" defaults to a **change-detector** (read current
output, assert it) and will happily back-label it to a real column. A tag check
cannot distinguish that from genuine derivation. So the design does not rely on
one:

- **Blocking path — no LLM.** Block-eligible tests are materialized by code from
  a parsed declared constraint. The constant/column/operator come from the dbt
  artifact (`schema.yml`/contract), not from model text. The LLM is not in this
  loop, so it cannot manufacture a blocking finding, back-labeled or otherwise.
- **Advisory path — LLM, fenced off.** LLM-proposed tests are tagged
  `origin: inferred_context`, emitted at `confidence: "unknown"` under a
  dedicated evidence tool, and are **structurally excluded from the verdict**
  (§3.5). A back-labeled or wrong LLM test is at worst noise in a proposed patch,
  never a block.

Source taxonomy (drives everything):

| origin | sources | LLM authors assertion? | block-eligible? |
|--------|---------|------------------------|-----------------|
| `declared_constraint` | schema.yml `not_null`/`unique`/`accepted_values`/`relationships`; enforced contract column type/PK | **No** — materialized from the parsed constraint | Yes (when executed & failed) |
| `inferred_context` | column descriptions, `ref()`/`source()` edges, naming conventions, PR title/body | Yes — proposed test | **Never** |

Explicitly **not** treated as declared intent (rev-1 error corrected): a `ref()`
edge is not FK existence; `dim_*` is not proof of uniqueness; "the customer's
email" does not imply `not_null`; compiled SQL is context, never an expected
value. All of these are `inferred_context` → advisory only.

The deterministic guard `filterToSpecDerived` (spec-test-gen.ts) still runs on the
advisory track — it drops proposals with no `derivedFrom`, a disallowed kind, or a
`ref` we did not extract ourselves (anti-fabrication). But it is **not** what
makes the feature sound; the source split + the no-LLM blocking path is.

## 3. Design

### 3.1 Flow

```
added model file
  ── track A (deterministic, block-eligible) ─────────────────────
  → runner.declaredConstraints(model)         [parsed schema.yml/contract + provenance]
  → keep constraints with NO enforcing test
  → materialize each into a dbt generic test  [code, not LLM]
  → runner.runGeneratedTests(...)             [P1; null if no warehouse]
  → executed & failed → contract_violation finding (block-eligible)

  ── track B (LLM, advisory) ─────────────────────────────────────
  → gather inferred_context sources (descriptions, refs, PR intent)
  → generateSpecTests(...)                    [cheap LLM, injected]
  → filterToSpecDerived(...)                  [drop fabricated/untagged]
  → emit as proposed-test findings (confidence unknown) + schema.yml patch
  → (P1) optionally execute in a sandbox → "candidate fails on current data"
         (still advisory — NEVER a contract_violation)
```

### 3.2 Types (spec-test-gen.ts)

```ts
type SpecOrigin = "declared_constraint" | "inferred_context"

interface SpecSource {
  origin: SpecOrigin
  kind: "not_null" | "unique" | "accepted_values" | "relationships"
      | "column_type" | "schema_desc" | "ref_edge" | "pr_intent"
  ref: string                 // stable id we extracted, e.g. "schema.yml:dim_customer.email"
  text?: string               // declared value/description
  args?: Record<string, unknown>  // parsed constraint args (accepted_values set, rel target)
}

interface GeneratedTest {
  id: string                  // deterministic; results key off this, NOT array order (§3.4)
  kind: GeneratedTestKind
  dbtTest?: { column?: string; test: string; args?: Record<string, unknown> }
  assertionSql?: string       // advisory track only; sandboxed (§3.7)
  rationale: string
  derivedFrom: SpecSource     // origin decides block-eligibility
}
```

### 3.3 Runner additions (`ReviewRunner`, orchestrate.ts:114)

New — do **not** reuse `declaredPrimaryKey()` for escalation (it's a lossy PK
proxy). A typed constraint reader with provenance:

```ts
/** Parsed, enforce-able constraints declared for a model, with provenance —
 *  schema.yml tests + enforced contract. Each carries origin + source ref so the
 *  lane can tell a declared constraint from an inferred one. */
declaredConstraints?(model: string): Promise<Array<{
  kind: "not_null" | "unique" | "accepted_values" | "relationships" | "column_type"
  column?: string
  args?: Record<string, unknown>
  hasEnforcingTest: boolean   // is there already a dbt test for this?
  uniqueId?: string           // manifest node id (provenance)
  sourceRef: string           // "schema.yml:<model>.<col>" etc.
}>>

/** Execute generated tests. Returns results KEYED BY test id (not array order).
 *  null when no warehouse/driver (same contract as dataDiff). */
runGeneratedTests?(
  tests: GeneratedTest[],
  warehouse?: string,
): Promise<Record<string, { status: "pass" | "fail" | "error"; violatingRows?: number; detail?: string }> | null>
```

### 3.4 Result mapping

`runGeneratedTests` returns a map keyed by `GeneratedTest.id`, so dropped/errored
tests or batched execution can never attach a failure to the wrong test.

### 3.5 Verdict gating — defense in depth, not lane discipline alone

Two layers, because `computeIdealVerdict` only sees `severity`+`category`
(verdict.ts:52) and would block on any `critical contract_violation`:

1. **Lane discipline.** Only track-A (executed + `declared_constraint`) failures
   are emitted as `critical contract_violation`. Track-B findings are emitted at
   `severity: warning`, `confidence: "unknown"`, evidence tool
   `altimate.spec_test.proposed`.
2. **Verdict-layer enforcement (new).** `computeIdealVerdict` is hardened so a
   generated-test finding may reach a blocking verdict **only** when its evidence
   carries `executed: true` AND `origin: "declared_constraint"`. And the
   warning-accumulation count (verdict.ts:63) excludes the
   `altimate.spec_test.proposed` tool exactly as it already excludes `ai-review`
   — otherwise three failed inferred range tests would block via accumulation
   (Codex finding 4). Both rules get their own verdict unit tests.

Resulting matrix:

| Situation | Severity | Confidence | Blocks? |
|-----------|----------|------------|---------|
| Track A: declared constraint materialized, **executed & failed** | `critical` (clamped) | `high` | Yes — real `contract_violation`, no LLM in the assertion |
| Track A: no warehouse (couldn't execute) | `suggestion` | `unknown` | No — proposed as an enforcing test to add |
| Track B: LLM proposal, not executed | `suggestion`/`warning` | `unknown` | No (excluded from verdict) |
| Track B: LLM proposal executed & failed (P1 sandbox) | `warning` | `unknown` | No — "candidate fails on current data," never `contract_violation` |
| Any test passed | (no finding) | — | raises the proposed/coverage counters |

The one blocking path is deterministic end to end: parsed constraint → code-built
assertion → warehouse execution → failure. No back-labeling reaches it because no
LLM text reaches it.

### 3.6 Envelope + output

- Add metrics to **`BuildEnvelopeInput`** (not just the zod schema — the summary
  is built from findings only, verdict.ts:132): `proposedTests` (track B) and,
  for P1, `enforcedConstraints` (track A executed/passed/failed).
- `format.ts` renders **P0 as "Proposed tests"** — authoring help, explicitly not
  "verification." "Spec coverage / executed / passed / failed" language is
  reserved for P1 track-A execution. Passed + proposed tests are offered as a
  committable schema.yml/tests patch; once merged they run in plain dbt CI
  forever (the durable spec expansion).

### 3.7 Execution safety (P1)

- Track A assertions are code-built dbt generic tests — inherently bounded.
- Any `assertionSql` (advisory track) is treated as untrusted: parse + enforce
  single `SELECT` only (no DDL/DML/multi-statement), allowlist referenced
  relations to the model + its declared upstreams, cap returned rows, strict
  timeout, run under the review warehouse role. Prefer generic dbt test specs
  over raw SQL wherever possible.

## 4. Tiering & cost

- Gate a `spec_tests` concern into `TIER_LANES.lite`/`.full` (risk-tier.ts:152),
  invoked only when the PR **adds** a model.
- Track B runs one cheap-model call per added model (the BAIR premise: auxiliary
  per-PR inference is now trivially cheap).
- Track A execution is opt-in via `.altimate/review.yml` `specTests.execute`,
  default off (generate-and-propose only) — same posture as `dataDiff`.

## 5. Failure modes & guards

1. **Back-labeled change-detector** → cannot reach the block path (no LLM there);
   on the advisory track it's at worst a noisy proposal (unknown, non-blocking).
2. **Inferred failure blocks via accumulation** → prevented by excluding
   `altimate.spec_test.proposed` from the warning count (§3.5.2) + a verdict test.
3. **Fabricated `critical`** → verdict-layer rule rejects any generated-test
   critical lacking `executed:true`+`declared_constraint` (§3.5.2).
4. **Wrong-but-declared constraint fails on valid data** (optional/anonymized/
   late-arriving) → this is a genuine violation of what the author *declared*; the
   finding says "your declared `not_null` on `email` fails on 340 rows — enforce
   or amend the declaration," which is correct signal, not a false positive.
5. **Unsafe/expensive LLM SQL** → §3.7 sandbox.
6. **Result misattribution** → id-keyed results (§3.4).
7. **Non-determinism across re-reviews** → stable `fingerprint` (finding.ts:107)
   keyed `spec_test:<sourceRef>`.

## 6. Build phases

- **P0 — propose only (no execution). Advisory authoring help, not verification.**
  `spec-test-gen.ts` (types + `filterToSpecDerived`), the source-split extraction,
  track-B proposal findings (`confidence:"unknown"`) + the schema.yml patch, and
  track-A constraints surfaced as **proposed enforcing tests** (also unexecuted →
  advisory). Success metric = accepted patches. No blocking, no "coverage" claim.
- **P1 — execution.** `runner.declaredConstraints` + `runGeneratedTests`; track-A
  executed failures → the one blocking path; verdict-layer enforcement + tests;
  sandbox; `enforcedConstraints` metrics.
- **P2 — feedback loop.** Persist accepted/dismissed proposals as *corrective*
  memory (see `corrective-app-memory.md`); feed priors back into track B.

## 7. Interfaces touched

| File | Change |
|------|--------|
| `spec-test-gen.ts` (new) | source taxonomy, `GeneratedTest.id`, `filterToSpecDerived`, transport skeleton |
| `orchestrate.ts` | `ReviewRunner.declaredConstraints?` + `runGeneratedTests?`, `OrchestrateInput.generateSpecTests?`, `specTestSynthesisLane` (two tracks), wiring under `spec_tests` |
| `verdict.ts` | verdict-layer enforcement (executed+declared for criticals; exclude `altimate.spec_test.proposed` from warning count); `BuildEnvelopeInput.proposedTests`/`enforcedConstraints` |
| `risk-tier.ts` | `spec_tests` in `lite`/`full` |
| `format.ts` | "Proposed tests" section (P0) + patch block |
| `config.ts` | `specTests: { execute: boolean }` |
| `run.ts` | inject production `generateSpecTests` (cheap model) like `runAiReview` |

### IP-boundary decision (open)

`ai-review.ts` keeps its generation prompt + parse/clamp in the compiled core
(`altimate_core.review_ai_*`), TS is transport-only. Track B's prompt should
follow suit → needs a new `altimate_core.review_spec_test_*` method in
altimate-core-internal. **Decision for the user:** (a) add the core method
(honors the IP boundary; cross-repo work) vs. (b) inline a minimal prompt in TS
for P0 speed and move it to core before GA. Track A (deterministic) has no prompt
and no such dependency.

## 8. Non-goals

- Not for `modified` models — reference-exists world owns those.
- Not a golden/snapshot generator.
- P0 makes no verification/coverage claim — it authors candidate tests.
