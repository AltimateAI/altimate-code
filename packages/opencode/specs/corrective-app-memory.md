# Spec: Corrective, attribute-keyed app-memory

Status: draft · Owner: anand · 2026-07-07
Scope: shared substrate; first consumers = `dbt-pr-review` test-acceptance +
reviewer finding-acceptance. Companion to `greenfield-spec-test-synthesis.md` (§P2).

## 1. Problem

Two memory needs in the product, both currently unserved or served badly:

1. **dbt-pr-review learning.** The spec-test-synthesis agent generates tests per
   repo. Some a team keeps, some it dismisses as noise. Today that signal
   evaporates — the next PR regenerates the same dismissed tests.
2. **altimate-code's own reviewer/skill memory.** Stored today as raw markdown
   traces (`MEMORY.md` is already ~34KB and self-warning about size).

Both are the failure the BAIR "Intelligence is Free" piece names: **file-based
raw-trace memory doesn't scale, and raw traces induce repeated mistakes.** Its
prescription — the thing to build — is *structured, corrective* memory: organize
across attributes, each `*` (universal) or a specific value, and store the
**correction**, never the trace.

The move that makes this defensible (and not just a cache): store author-
*committed* corrections keyed by the attributes of the situation, retrieve by
most-specific match, and **never let a learned entry silently escalate a block.**

## 2. Data model

A memory entry is `(scope, correction, provenance)`.

```ts
interface MemoryScope {
  project: string                 // tenant / repo — always specific (isolation boundary)
  // Each below: a specific value OR "*" (universal). Retrieval matches specificity.
  modelLayer?: string | "*"       // staging | intermediate | marts | ...
  table?: string | "*"
  column?: string | "*"
  operation?: string | "*"        // date | dedup | join | pii | ...
  warehouse?: string | "*"
  category?: string | "*"         // ReviewCategory, or a domain tag
  derivedFromKind?: string | "*"  // for test-acceptance: contract|grain|range|referential|not_null
}

interface MemoryEntry {
  id: string                      // fingerprint of the canonicalized scope + directive
  scope: MemoryScope
  directive: string               // the correction: "prefer X" / "do NOT flag Y" / "suppress test kind Z here"
  polarity: "prefer" | "suppress" // reinforce vs. suppress the behavior
  provenance: {
    source: "accepted_pr" | "explicit_dismiss" | "human_rule"
    committed: boolean            // true only when a human/PR action ratified it
    supportCount: number          // times observed; merges increment, they don't append
    lastSeen: string              // ISO; drives decay/expiry
  }
}
```

Non-negotiables that keep this from becoming raw traces:

- **Store the directive, not the transcript.** An entry is a single correction,
  not a session log. No PR bodies, no diffs, no model output.
- **Merge, don't append.** Two observations with the same canonical scope+directive
  update one entry (`supportCount++`, refresh `lastSeen`) — the store does not grow
  per event. This is what bounds size where `MEMORY.md` doesn't.
- **Corrective, not descriptive.** "when deduping `int_*` models, dismiss
  `referential` tests on unenforced sources" — a rule that changes future
  behavior, not a note about the past.

## 3. Retrieval

Given a situation described by the same attributes, return the merged set of
applicable entries, **most-specific match wins** on conflict:

- Score each matching entry by count of non-`*` scope fields that match.
- Higher specificity overrides lower (a `column`-specific `suppress` beats a
  `layer`-wide `prefer`).
- Ties → higher `supportCount`, then more recent `lastSeen`.
- Expired/low-support entries (`supportCount < N` past a decay window) are not
  returned — a single fluke never becomes a standing rule.

Retrieval is a pure function of `(scope query, store)` → deterministic, testable.

## 4. Consumers

### 4.1 dbt-pr-review test acceptance (the P2 loop)

- **Write:** when a generated test's proposed patch is merged → `accepted_pr`
  `prefer` entry keyed by `(project, modelLayer, derivedFromKind, category)`.
  When a proposed test is explicitly dismissed → `explicit_dismiss` `suppress`
  entry, same key.
- **Read:** `SpecTestGenInput` gains a `priors: MemoryEntry[]` field. The
  generator is told: prefer kinds this repo keeps, avoid kinds it dismisses.
  Generation gets sharper per-repo each PR **without** retraining anything.

### 4.2 Reviewer finding acceptance (generalizes static rubric exclusions)

- **Write:** a dismissed/muted finding → `suppress` entry keyed by the finding's
  `(category, model/column, ruleKey)`.
- **Read:** the orchestrator's post-filter (orchestrate.ts:1336, currently
  `exclusionReason` over the static rubric) additionally consults learned
  `suppress` entries — turning the hand-written exclusion list into a learned one.

### 4.3 altimate-code reviewer/skill memory

Same store replaces the raw-`.md` reviewer memory: corrections keyed by
`(operation, table, column, warehouse)` instead of prose files. The Spider2
`builder.txt` improvements are already de-facto corrective memory — this promotes
that pattern into the layer itself.

## 5. Safety: learned memory must not silently escalate

Mirrors the test-gen honesty rule. A learned entry may:

- **bias generation** (which tests to propose), and
- **suppress/downgrade** advisory findings (raise precision).

A learned entry may **NOT**:

- escalate any finding to blocking, or manufacture a new blocking finding.

Rationale: `suppress`/`prefer` only ever *reduce* noise or *reweight* proposals —
both fail safe. Escalation off a learned pattern would let accumulated bias
force `REQUEST_CHANGES`, exactly the "livelock / drift" risk. Blocking stays
gated on deterministic engine proof (equivalence, executed author-declared
constraints), never on memory. `provenance.committed` is recorded so a future
governance tier *could* allow human-ratified escalation, but P0 does not.

## 6. Storage & governance

- **Per-project, tenant-scoped** (the isolation boundary; `project` is never `*`).
- Backing store: append-and-compact JSONL or a small SQLite table — but the API
  is `get(scopeQuery)` / `record(entry)` with merge semantics, so the backend is
  swappable. No embeddings needed (structured attribute match, not semantic
  search — the article's specific critique of the KG/embedding approach).
- **Reviewable & exportable:** entries are inspectable; `.altimate/review.yml`
  can pin (force-keep) or forbid (never-learn) scopes. Memory is a config surface,
  not a black box.
- **Decay:** entries below support threshold expire; the store self-prunes.

## 7. Build phases

- **P0 — read-path with seeded rules.** The `MemoryEntry` schema + deterministic
  `get(scopeQuery)` retrieval + `.altimate/review.yml` hand-authored entries.
  Wire into `SpecTestGenInput.priors` and the reviewer post-filter. No learning
  yet — proves the retrieval + safety model with static data.
- **P1 — write-path.** Record `accepted_pr` / `explicit_dismiss` entries from PR
  merge/dismiss events with merge semantics + decay.
- **P2 — reviewer/skill memory migration.** Move altimate-code's raw-`.md`
  reviewer memory onto the same store.

## 8. Interfaces (summary)

| File | Change |
|------|--------|
| `corrective-memory.ts` (new, shared) | `MemoryScope`, `MemoryEntry`, `get()`, `record()` with merge/decay |
| `spec-test-gen.ts` | `SpecTestGenInput.priors`; generator prompt consumes them |
| `orchestrate.ts` | post-filter consults learned `suppress` entries |
| `config.ts` | `memory: { pin, forbid }` scopes |

## 9. Non-goals

- Not a semantic/embedding memory — deliberately structured attribute match.
- Not cross-tenant — `project` is the hard isolation boundary.
- Not a path to new blocking decisions (§5).
