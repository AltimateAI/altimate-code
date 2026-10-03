# Workspace learning loop (RSI) for altimate-code — design v1

Status: v2 — revised after adversarial critique (see `critique-v1.md` and the v2 section at the end). Date: 2026-09-30.
Inputs: `rsi-papers.md` (literature), `rsi-practice.md` (products/repos), codebase map (below).

## Goal

Demonstrate a working, autonomous, *measured* self-improvement loop in the altimate-code
harness that uses the Altimate workspace as the team distribution channel:

```
session (task) ──► external signal (CI / verifier / user correction)
     │                         │
     ▼                         ▼
   trace ───────────► Reflector (LLM, no tools) ──► JSON deltas
                                                      │
                                      Curator (deterministic): apply, cap, dedupe, scrub
                                                      │
                                         candidate playbook skill (staged)
                                                      │
                               Gate: val tasks, candidate vs current (hidden verifier)
                                                      │ promote only if better, no pass→fail
                                         project skill + history + `skill publish`
                                                      │
                                   workspace (tenant skills) ──► teammate bind-time sync
                                                      │
                                         next sessions load it (alwaysApply, bounded)
```

## Evidence-driven design decisions

| Decision | Why (source) |
|---|---|
| Learn only from **external** signal (verifier/CI/user correction), never self-judged success | SkillsBench: self-generated skills without feedback −1.3pp; SkillLearnBench "recursive drift"; Letta +36.8% with feedback vs +21.1% trajectory-only |
| Artifact = one **playbook skill** (SKILL.md), not memory | Codebase: workspace memory is private per user (`memory-api.ts:154`, `visibility:"private"`); skills are tenant-wide → only real team channel |
| **Delta** edits (ADD/EDIT/REMOVE/UPVOTE/DOWNVOTE) on itemised bullets with ids + helpful/harmful counters, never full rewrite | ACE (context collapse / brevity bias in Dynamic Cheatsheet & rewrite optimizers); Codex CLI diff-based forgetting |
| Deterministic **Curator** separate from LLM Reflector; hard caps (≤25 bullets, ≤4 KB) | ACE reflector/curator split; Claude Code "Auto Dream" exists because unbounded notes rot |
| **Gate** on a validation split with a verifier the agent cannot see; promote iff mean score ↑ and no pass→fail regression; rejected candidates archived | VALVE (−75% drawdown), DGM archive, SkillOpt bounded edits |
| Separate **held-out** split never seen by the improver, used only for reporting | Literature measurement guidance; PROCTOR/DGM reward-hacking |
| Provenance per bullet (source session, task id), history log, rollback | Copilot Memory citations; DGM archive |
| Secret scrubbing of trace digest before it reaches the reflector/workspace | Codex CLI redaction; memory-poisoning literature |

## Components to build

### In the product (`packages/opencode`)
1. **`learner` hidden built-in agent** (all tools denied) with a reflector prompt that returns strict JSON deltas.
2. **`altimate-code learn` command** (`src/cli/cmd/learn.ts`, logic in `src/altimate/learn/`):
   - `learn reflect --session <id> --feedback <file|-> [--skill <name>]` — builds a compact trace digest
     (user prompt, tool calls+args summarised, errors, final answer, files written) from the session
     store, scrubs secrets, calls the learner agent (self-invoked `run --agent learner --format json`),
     curator applies deltas to the *candidate* playbook at `.altimate-code/learn/<skill>/candidate/SKILL.md`.
   - `learn eval --suite <tasks.jsonl> --variant none|current|candidate --runs N` — generic eval harness:
     each task row = `{id, split, prompt, setup: <cmd that creates workdir>, verify: <cmd printing {pass,score,checks}>}`;
     runs `run` per task in an isolated workdir with the chosen skill variant installed; records
     pass/score/tokens/cost/turns/duration to `.altimate-code/learn/runs/*.jsonl`.
   - `learn promote [--publish]` — gate result → copy candidate to `.altimate-code/skills/<skill>/SKILL.md`,
     append `history.jsonl`, keep previous version for `learn rollback`; `--publish` calls the existing
     skill-publish path (workspace).
   - `learn loop --suite ... --iterations K` — autonomous: train tasks → verify → reflect on each
     (failure *and* success, contrastive) → gate on val → promote+publish or archive → repeat.
3. Playbook SKILL.md format:
   ```
   ---
   name: team-playbook
   description: Conventions this team's reviewers/CI enforce, learned from past sessions.
   applyPaths: ["dbt_project.yml"]
   ---
   <!-- learned-playbook v3; managed by `altimate-code learn` -->
   - [L-3f2a] Staging models: filter out soft-deleted rows (`where not _is_deleted`) and do not expose `_is_deleted`. <!-- h:4 x:0 -->
   ```

### Demo harness (`experiments/rsi-workspace/`)
- `fake-backend/` — faithful Bun fake of the workspace API (bindings, skills, memory) for 2 users / 1 tenant.
- `demo/` — dbt-duckdb "acme_shop" project; hidden CI conventions (naming, PK tests, cents→dollars,
  to_utc timestamps, soft deletes, build passes); tasks split train(3)/val(2)/heldout(2); verifier outside workdir.
- `run-demo.sh` — end-to-end: user A baseline on heldout → `learn loop` on train/val → publish →
  user B (fresh clone, same remote, different identity) binds → B's heldout runs with synced skill.

## Measurement protocol
- Model fixed (e.g. `anthropic/claude-sonnet-4-6` or haiku for cost), N=3 runs per task per arm.
- Arms on heldout: (a) no playbook, (b) learned playbook via local file (A), (c) learned playbook via
  workspace sync (B), (d) ablation: playbook produced by reflector *without* verifier feedback.
- Metrics: pass rate, mean check score, tokens, cost, turns; learning curve per iteration on val.
- Integrity: verifier/gold/tasks never inside workdir; assert workdir has no `verifier` path; grep
  transcripts for reads outside workdir; heldout never fed to reflector.

## Known product gaps to call out (from code)
1. Workspace memory is private per user; tool text says "team's memory" (overstates). Team learning must use skills.
2. ~~Skills sync only at bind time~~ (refuted in critique): `session/prompt.ts:394-400` re-syncs per turn, throttled to 5 min (`skill-sync.ts:298`). Real gap: a teammate can run up to 5 min on a stale playbook, and a very short first turn can race the cold sync.
3. No staged/candidate/approval state on the backend; any uploader's `alwaysApply` reaches every member (prompt-injection channel).
4. No first-class session-end hook; `session.idle` fires per turn; traces finalized only on shutdown.
5. Outcome telemetry (`agent_outcome`) goes to analytics, not a locally queryable store.
6. No eval harness for agent sessions besides heavy ADE-Bench.
7. Backend not runnable locally for dev; no shared fake server in tests.

## Open questions for critique
- Is self-invoking `run --agent learner` acceptable vs an in-process LLM call?
- `alwaysApply` vs `applyPaths` for the playbook (cost vs reach)?
- Is val=2 tasks × N=3 a meaningful gate, or should the gate be per-check score with a margin?
- Should promote require human approval by default in product (and `--auto` for the demo)?


## v2 changes after critique

| Critique | Resolution |
|---|---|
| Gap 2 factually wrong | Corrected above (5-min poll, not bind-only). |
| Demo too easy; verifier messages spoon-feed the rules | Data checks (soft-delete, UTC) now report **symptoms only** (row-count mismatch, join failure); lint checks may name the rule. 4 train / 4 val / 4 heldout + 2 **control** tasks the playbook must not be over-applied to. |
| Leakage: reflector sees val/heldout feedback | Harness asserts only `split=train` feedback reaches `learn reflect`; verifier, gold and tasks live outside every workdir; workdir is checked for leaked paths. |
| Gate statistically meaningless | Gate on **per-check** pass counts (≈ checks × tasks × runs), paired candidate-vs-current, with a margin; no task may lose a check it passed on all runs. Report raw counts, state that the demo is not powered for % claims. |
| Thin ablations | Arms on heldout+control: none · learned · learned-via-workspace (teammate) · gold playbook (upper bound) · no-feedback reflector (ablation). |
| Self-invoking `run --agent learner` | Reflector is an **in-process** `generateObject` call via the Provider service (same pattern as `Agent.generate`); no new agent, no session-store pollution. |
| Product surface too broad | Product ships only `learn reflect | show | promote | rollback | reject` + curator. Eval harness and loop stay in `experiments/rsi-workspace/`. |
| Poisoning / privacy | Curator **lint** rejects bullets with shell commands, paths outside the project, URLs, "skip/ignore/disable" verification phrasing, secrets; ≤ 25 bullets, ≤ 240 chars each. Provenance (session ids, task ids) stays in local `history.jsonl`, **never in the published SKILL.md**. `promote` shows a diff and asks for confirmation (`--yes` for automation); publishing requires explicit `--publish`. Playbook uses `applyPaths` (e.g. `dbt_project.yml`) rather than `alwaysApply`. Load-time size cap for workspace skills is listed as a product gap (not built here). |
| Real users have no verifier | `--feedback-kind verifier|ci|review|user` recorded per lesson; the demo proves the mechanism, not real-world lift. Real-world signal = CI failures, PR review comments and user corrections; gate degrades to replaying prior failing tasks. |
| Fleet divergence (project skill shadows workspace copy) | Single-owner policy for v1: the playbook has one maintainer checkout that runs `learn`; teammates consume via sync. Listed as a gap (no merge of concurrent learners). |
| Publish privacy default | Verified against the fake backend in the demo; real backend behaviour is unverified and called out. |
