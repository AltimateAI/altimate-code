# Keeping learned lessons from bloating the context

Date: 2026-10-01. Branch: `feat/rsi-workspace-learning`. Status: research + proposed design, not implemented.

Question: as `altimate-code learn` accumulates team conventions, how do we keep per-turn context bounded **and** make sure
the agent actually applies them, without depending on the model choosing to call a skill or memory tool?

Source reports (full citations, unverified items marked there):
- [context-budget-harnesses.md](context-budget-harnesses.md): Claude Code, Cursor, Windsurf, Copilot, Codex, Devin, Kiro, Cline, Augment.
- [context-budget-memory-frameworks.md](context-budget-memory-frameworks.md): Letta, mem0, Zep/Graphiti, LangMem, Agno, ExpeL, ACE, Voyager.
- [context-budget-evidence.md](context-budget-evidence.md): instruction-count scaling, context rot, caching economics, rule-to-check, retrieval.

## TL;DR

1. **Everyone converges on the same shape:** a small, hard-capped tier that is always pushed; a tier the harness pushes on
   a deterministic trigger (file glob, path, tool); a long tail that is stored but not injected; and hooks/linters for
   anything that must hold. Nobody serious relies on the model pulling knowledge for correctness.
2. **Pull is unreliable; push by trigger is not.** Vercel: the skill was never invoked in 56% of runs (53% pass, same as
   no skill); the same content pushed as an 8 KB index in AGENTS.md scored 100%. Our own run: playbook in the prompt
   18/18, held-out 0/9 → 9/9.
3. **Bloat costs adherence, not money.** With a stable prefix, cache reads cost 0.1x. The real cost is that rule
   following degrades with rule count, silently and with primacy bias (IFScale: ~95% at 100 easy rules on Claude-class
   models, 44.6% at 500 for opus-4; AGENTIF: real agent prompts fully followed only 26.9% of the time; conditional rules
   cause >30% of errors). Irrelevant context also hurts on its own (Chroma: ~85% focused vs ~45% at 113K tokens).
4. **Unreviewed self-learned content can hurt.** SkillsBench: self-generated skills lowered pass rates 8–12 pp; the
   AGENTS.md study: LLM-written context files −3%, human-written +4%. ACE: an LLM rewriting the whole context collapsed it
   from 18,282 to 122 tokens and fell below the no-memory baseline. Mem0 production audit: 97.8% of entries were junk.
5. **So the answer to "memory or skill" is: neither choice prevents bloat. The tiering, triggers, budget and eviction
   in the harness do.** The store only decides sharing and review.

## What others do (condensed)

| Pattern | Who | Mechanism |
|---|---|---|
| Hard-capped always-on index | Claude Code auto memory (200 lines / 25 KB), Codex AGENTS.md (32 KiB), Windsurf (6K/12K chars), Letta core blocks | Harness measures on write, nags near the cap, errors over it |
| Trigger/glob-scoped injection | Claude Code `paths:` rules, Cursor Auto Attached, Copilot `applyTo`, Kiro `fileMatch` | Harness pushes when a matching file is read/edited; no model decision |
| Description-only listing, body on demand | Claude Code skills (1% of window, 1,536 chars each), Cursor Agent Requested, Kiro `auto` | Cheap push of the name; body is pulled (unreliable) |
| Eviction by non-use | Copilot Memory (28 days), Codex memories (`max_unused_days`) | Deterministic, no model |
| Counters and delta edits, never whole rewrites | ACE (helpful/harmful), ExpeL (start at 2, delete at 0) | Itemised lessons with ids |
| Supersede, don't overwrite | Graphiti (`invalid_at`), Agno (only at ≥0.8 confidence) | Old lesson archived, not lost |
| Citations + re-validation before use | Copilot Memory | Stale lessons silently skipped |
| Separate extraction from consolidation | Codex (two-phase), Letta sleep-time, ACE lazy refine | Consolidate only on overflow or in a background pass, so the always-on block stays byte-stable |
| Human promotion to the shared tier | Agno PROPOSE, Cursor Memories approval, Devin suggestions | Candidates are local until approved |
| Must-hold rules become hooks/lint | Anthropic guidance ("CLAUDE.md is context, not enforced configuration") | Zero context, no decay |

## How altimate-code compares today

Verified in code, then independently checked by a Codex review (file:line evidence in that review; corrections applied).

| Concern | Today | Gap |
|---|---|---|
| Delivery | Playbook is an `alwaysApply`/`applyPaths` skill whose body is injected whole (`session/system.ts:110,141`); memory pushed by `MemoryPrompt.inject` (`session/prompt.ts:1485`) | Good: no reliance on pull |
| Budget | Playbook ≤25 bullets × 240 chars each (`learn/curator.ts:10`), **no aggregate cap**, so up to ~6,000 chars; memory+training 20,000 chars (`memory/types.ts:40`) | Playbook is all-or-nothing whenever it matches |
| Selection | Memory scored by agent, kind, tags, applied count, recency (`memory/prompt.ts:132`); `InjectionContext` holds only agent/sessionID | **Task-blind**: no files, tables, warehouse or command |
| Per-lesson trigger | Only the whole playbook has `applyPaths`, and it means "a matching file exists anywhere in the worktree" (`session/system.ts:217,270`), not "this task touches it" | No per-lesson or per-task trigger |
| Cache boundary | `LLM.stream` **joins the whole system array into one string** (`session/llm.ts:102`); `applyCaching` marks the first two system messages and last two others (`provider/transform.ts:271`) | Any change in skills/memory invalidates the entire cached system block. Moving content "to the tail of the array" does nothing |
| Existing cache busters | Training entries render `(applied Nx)` and the count is incremented on injection (`memory/prompt.ts:118,270`); workspace awareness and the daily date also vary | **Bug on main, independent of RSI**: the system prompt text changes after the first injection, so it re-misses the cache |
| Counters | Reflector proposes HELPFUL/HARMFUL; curator increments and turns duplicate ADDs into HELPFUL (`learn/curator.ts:182,250`) | Attribution isn't tied to whether the lesson was actually injected; no last-used / TTL for bullets |
| Write gate | Lint, redaction, budgets, dedupe; digests omit system prompts (`learn/digest.ts:132,177`) | Recalled lessons echoed in tool output or assistant text are not filtered (recall→re-extract loop risk). Reflection loads the *candidate*, which can hold never-injected lessons (`session-reflect.ts:47`) |
| Must-hold rules | Seven opt-in dbt validators already exist (`altimate/validators/index.ts:26`) | Learned lessons have no path to become one; `tool.execute.before` errors are swallowed (`plugin/index.ts:195`), so hooks can't veto yet |
| Storage | Local memory: 50 *active* blocks/scope × 2,048 chars, shared by memory and training (`memory/store.ts:268`) | Non-expired records stay injection candidates; an archive tier needs new exclusion logic |

## Proposed design: four tiers, harness-owned

```
                 ┌──────────────────────────────────────────────────────────────┐
 lesson record → │ +check     lint / dbt validator / hook  enforced, attached   │ added when mechanically decidable
 (id, text,      │ T1 core    always-on, byte-stable        ≤ ~1.5k tok, ≤ 25   │ promote: broad + well-confirmed + reviewed
  trigger,       │ T2 scoped  pushed on trigger, tail of    ≤ 5 / turn, ~500 tok│ default tier for new approved lessons
  counters,      │            prompt after cache breakpoint                     │
  provenance)    │ T3 archive stored, searchable, not       0 tokens            │ demote: unused N days, harmful, superseded
                 └──────────────────────────────────────────────────────────────┘
```

1. **Lesson = one record** with `id`, text, `tier`, `trigger` (globs, dbt resource type, warehouse, tool), helpful/harmful,
   `last_applied`, provenance (correction quote / CI log / review link), `superseded_by`.
2. **T1 core** — rendered deterministically (sorted, no timestamps, no usage counts), only changes at promote or
   consolidation. Hard cap in tokens; overflow triggers consolidation, not silent truncation. Most important first
   (primacy). Requires splitting the system prompt into a **stable block** (provider prompt, instructions, T1) and a
   **volatile block** after it, each with its own cache breakpoint; today it is one joined string.
3. **T2 scoped** — the harness, not the model, matches triggers and injects at most k=5 lessons into the volatile part.
   Trigger timing matters: lessons keyed to the task prompt, linked dbt project, or files already read can be injected
   before the model acts; a lesson keyed to a file the model is *about to write* is only known after it emits the tool
   call, so the write tool must return "applicable conventions: …" (or block once and ask for a retry) rather than
   silently proceeding. Overflow (>5 matches) ranks by trigger specificity then net helpful; conflicts are flagged at
   write time. Trigger keywords stay in the injected text (NoLiMa). This is what fixes "memory is task-blind".
4. **T3 archive** — everything else. Retrievable by `memory_read`/search for exploration, but nothing correctness-critical
   may live only here.
5. **T0 checks** — a lesson that can be decided from the diff, AST or dbt manifest (e.g. "amounts go through `to_utc`",
   "staging models are named `stg_<source>__<entity>`") gets an attached check, built on the existing dbt validator
   registry. LLM-generated, validated against positive/negative examples before enabling (RuleLLM: validation took
   precision 62.9% → 85.2%). The failure message is fed back to the agent. Its prose moves out of T1 into T2 (still
   shown when relevant) only after the check is proven; checks cost runtime and failure-message tokens, not zero. Needs
   defined veto/unknown/failure semantics first, since hook exceptions are swallowed today.
6. **Lifecycle** — candidate (local) → approved T2 → T1 only on repeated evidence + human approval → check attached when
   checkable. Demote T1→T2→T3 on net-harmful counters or supersession; non-use demotes only lessons not marked
   mandatory (a rare-but-critical rule must not expire). Credit requires an **injection receipt** (which lesson version
   was actually in the prompt); a passing CI run does not credit every exposed lesson, a repeated correction of the same
   thing is strong negative evidence.
7. **Write gate** — filter recall-origin snippets (lesson text echoed back in tool output or assistant text) by
   provenance, without dropping a user's quoted correction; reject anything derivable from the repo, transient, or
   restating the system prompt; conflict check against existing lessons at write time.

**Where it lives.** Records belong in workspace memory once memory gets a workspace visibility and an approval state
(backend ask, see findings.md). Until then the same records can live in `.altimate-code/learn/` with the T1 block
rendered into the `team-playbook` skill, which is the only channel that reaches teammates today. The published skill
directory must carry the versioned T2 records too (publication already sends the whole directory), otherwise teammates
only get T1. The tier logic is the
same either way, so we can build it now and switch the store later.

## Proposed budgets (heuristics — validate before trusting)

| Tier | Budget | Basis |
|---|---|---|
| T1 core | ≤ 25 lessons, ≤ ~1.5k tokens | Evidence extrapolation (20–30 always-on; Claude <200 lines); our 4-lesson playbook is ~300 tokens |
| T2 scoped | ≤ 5 lessons, ≤ ~500 tokens per turn | Agno/Voyager k=5; no published optimum |
| T3 archive | 50 records/scope locally; server limit unknown | `memory/types.ts:35`; backend to confirm |
| Checks | as many as are proven | no prompt cost; runtime + failure-message tokens |

No source gives a validated rule limit for coding agents, and none compares glob triggers vs embeddings vs LLM routing.

## Experiment to replace the heuristics

On the existing harness (`experiments/rsi-workspace/harness`, real workspace 17), adding unseen held-out tasks:
1. **Injection receipts first:** log, per turn, which lesson ids/versions were in the prompt and the provider's
   cached-token count. Every later number depends on this.
2. **Saturation curve:** always-on N ∈ {10, 25, 50, 100} lessons (the real ones plus realistic distractor conventions),
   measuring per-rule adherence, held-out pass rate, prompt tokens, cache hit rate, latency.
3. **Tiering:** same pool delivered as (a) all always-on, (b) T1 + T2 triggered, (c) T2 only, (d) skill pulled on demand.
   Also measure trigger misses (a relevant lesson not injected).
4. **Graduation:** attach checks for the UTC-macro and naming rules; compare with and without the prose.

Decide from the numbers. Expected but not assumed: (b) matches (a) at lower tokens and a higher cache hit rate.

## Implementation order (smallest useful first)

1. **Cache hygiene on main (independent quick win):** stop rendering `(applied Nx)` in the prompt; split the system
   prompt into a stable block and a volatile block with separate cache breakpoints. Measure cached tokens before/after.
2. **Injection receipts** + the saturation/tiering experiment above.
3. Per-lesson `trigger` and T2 injection (task/project/read-file triggers first; write-time hints in the write tool).
4. Only if (2)–(3) show benefit: exposure-based counters, mandatory flag, TTL demotion, archive.
5. Check graduation on top of the dbt validator registry, after veto semantics are defined.
6. Switch the store to workspace memory when the backend supports workspace visibility + approval.

## Experiment results (2026-10-01, run `harness/runs/budget`)

Setup: same tasks, verifier and model (Claude Haiku 4.5 on Vertex) as the corrections run; author user, no workspace sync. Each arm: held-out ×3 + control ×3 = 18 runs. The 4 real learned lessons were mixed with realistic but irrelevant team conventions (96 written for this, 12 of them with triggers that also match this project's files; reviewed to not change any staging answer), spread evenly through the list. `N=4` is the earlier `corrections-learned` arm. Inputs: `harness/budget/`. Cost of the 5 new arms: $99.

| Arm | Held-out pass (excl. support-tickets) | Held-out checks | Control | 1st-call input tokens | Cost / run |
|---|---|---|---|---|---|
| N=4 (real lessons only) | 8/9 | 48/54 | 6/6 | 33,304 | $0.96 |
| N=25 | 7/9 | 52/54 | 6/6 | 34,584 | $1.03 |
| N=50 | 9/9 | 54/54 | 6/6 | 36,051 | $1.20 |
| N=100 | 8/9 | 53/54 | 6/6 | 38,880 | $1.12 |
| Task-matched (4 real + 4 matching distractors) | 8/9 | 48/54 | 6/6 | 33,537 | $1.04 |
| Pull (skill listed, not auto-loaded) | 8/9 | 49/54 | 6/6 | 32,897 | $1.12 |

Pull arm detail: the playbook skill was opened in 10 of 12 staging-task runs (and 2 of 6 controls, where it isn't needed). Both staging runs that did not open it failed (ledger-entries 1/6 checks, support-tickets 2/6). Every staging run that opened it passed, apart from support-tickets, which has a known naming ambiguity and fails in every arm.

**What this says**
1. **No adherence loss from irrelevant rules up to 100** on this model and task. Differences between arms are within noise (n=9; one run). The literature's degradation comes from many simultaneous *applicable* or conditional rules; irrelevant ones were cheap to ignore here.
2. **The cost of bloat is tokens, not quality here:** +5.6k input tokens on every call at N=100 (+17%), about 56 tokens per one-line rule. With a stable prefix that is mostly a cached read; without caching it is full price on every call.
3. **Pull is unreliable exactly where it matters:** in 2 of 12 relevant runs (17%) the agent never opened the skill, and both failed. Push delivery had no such misses. This confirms the concern: correctness-critical lessons must be pushed.
4. **Task-matched selection** performed the same as the 4 real lessons alone, at the same token cost. Its value is keeping cost flat as the lesson pool grows, not quality.

**Design consequences**
- The always-on cap can be looser than the literature extrapolation (25): on this evidence ~50–100 short rules didn't hurt. Keep a cap for cost and cache size, and because conflicting/conditional rules (not tested here) are where degradation is documented.
- Never deliver must-follow lessons by pull. Pull is acceptable only for reference material.
- Next gap to test: *applicable but conflicting or conditional* rules (e.g. "convert cents except in analyses"), and a stronger model, before fixing the cap.

## Experiment 2: applicable, overgeneralised and contradicting lessons (2026-10-01)

Same setup as above (Claude Haiku 4.5 agent, 18 runs per arm). Inputs: `harness/budget/make_arms2.py`, `arms/applicable40.md`, `arms/overgeneral.md`, `arms/conflict.md`.

| Arm | Held-out pass | Checks | Control |
|---|---|---|---|
| 4 real lessons | 8/9 | 48/54 | 6/6 |
| + 36 applicable style rules (40 total) | 7/9 | 47/54 | 6/6 |
| 4 real lessons reworded without scope ("every model and analysis…") | 8/9 | 53/54 | 5/6 (the failure wrote no file; no over-application) |
| **4 real + 4 stale contradicting lessons** | **1/9** | **8/54** | 5/6 |

In the conflict arm the agent followed the stale lesson for money, soft deletes and naming, and the current one only for timestamps. **Contradictions are the one thing that breaks the agent; size, applicability and scope wording did not.**

## Experiment 3: conventions change — does the loop retire stale lessons? (2026-10-01)

Scenario: the playbook holds 4 outdated lessons (`arms/stale-seed.md`); a simulated teammate reviews against the new conventions; 2 iterations of the corrections loop, then the final playbook is evaluated (18 runs). **Model change:** at ~20:30 the GCP org policy (`constraints/vertexai.allowedModels`, project 902846137931) started blocking every Claude model on Vertex, so this experiment uses Gemini: agent `gemini-3.5-flash`, reviewer `gemini-3.1-pro-preview`, strong reflector `gemini-3.1-pro-preview`, weak reflector `gemini-3.1-flash-lite`. Results are comparable within this experiment only.

References (Gemini agent): no playbook 2/9 (41/54 checks); **outdated playbook 0/9 (3/54)**; hand-written gold 9/9 (54/54). A stale playbook is far worse than none.

| Loop | Held-out pass | Checks | What happened |
|---|---|---|---|
| Current code, strong reflector | 9/9 | 54/54 | Reflector EDITed stale bullets into the new rules |
| Current code, weak reflector (2 runs) | 3/9, 4/9 | 40/54, 49/54 | Reflector marked stale bullets HARMFUL but never wrote the correction; curator auto-removed them → knowledge lost |
| + overlap guard only, weak | 4/9 | 44/54 | Guard rejected the weak reflector's correct ADDs (no `supersedes`) |
| **+ guard, implicit supersede, replacement step, weak (2 runs)** | **9/9, 9/9** | **54/54, 54/54** | Each run: one auto-removed lesson restored by the replacement call |
| + guard, implicit supersede, replacement step, strong | 9/9 | 54/54 | Explicit `supersedes` used 3×; no regression |

**The fix (branch `feat/learn-supersede`):**
1. Overlap guard: a new/edited lesson that shares a code identifier with an existing one must say `supersedes` or `coexists`; never two silent versions. Checked again at promote.
2. Implicit supersede: an overlapping ADD next to a lesson the same reflection marked harmful replaces it in place.
3. Replacement step: a lesson removed for contradiction without a replacement triggers one narrow model call to write the corrected rule (or NONE); failures are queued for the next reflection instead of being dropped.
4. Reflector prompt: when feedback contradicts a lesson, rewrite it; HARMFUL alone loses the knowledge.

Known limit: overlap detection only sees identifiers in backticks; prose-only contradictions rely on the reflector and the replacement step.

## Decision (2026-10-02): keep the `learn` workflow, store lessons as memory blocks

The capture → reflect → curate → approve pipeline stays exactly as built. Only the storage changes: each lesson becomes one training-memory block instead of a line in the `team-playbook` skill file.

**Mapping**
| Lesson | Memory block |
|---|---|
| id `L-xxxx` | `id` `training/rule/<readable-name>` |
| text (≤240 chars) | `content` |
| project vs workspace-wide | `scope: project | global` |
| kind | tags `training`, `rule`/`standard`, `learned` |
| provenance | `citations` |
| forgetting | `expires` |
| applied count | existing training meta `applied` |
| helpful/harmful, status (candidate/approved), supersedes/coexists, flagged | new keys in the training meta comment |

**Rules**
- Only the `learn` pipeline writes records tagged `learned`; the agent's `altimate_memory_write` must not create or edit them.
- Injection skips `candidate` records; approved learned rules are pinned (always included) in a stable, cache-friendly section without the changing `(applied Nx)` text.
- The skill path remains only for graduating stable lessons into a reviewed procedure.

**Backend prerequisites (blocking for team use)**
1. Team visibility for workspace memory (the reserved `visibility` field; today `list()` returns only the caller's records).
2. Verbatim storage for learned records (no server-side extractor rewrite).
3. A candidate → approved state so the workspace is the review gate.
4. Learned rules must not share the 50-blocks-per-scope cap with ordinary memory (or the cap must allow for them).

**Noted bug (not fixed, research only):** `altimate_memory_write`'s description tells the agent workspace memory is "the TEAM's memory … teammates' sessions read", but records are per-user (`memory-api.ts` `list()` reads "this user's mirrored records").
