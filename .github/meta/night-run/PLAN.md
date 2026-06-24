# Overnight Validation & Hardening Run — v1.17.9 merge
Branch: upstream/merge-v1.17.9. Mandate: validate the merge is correct, every fork change carried
forward + tested, generate adversarial/expert/e2e tests, run REAL model tests ($50 budget), ship by AM.
Maximal parallelism (Claude agent waves + codex exec on disjoint slices). Don't wait for the user.

## Budget: $50 hard cap (file: BUDGET.md). Phases 0-3 FREE (no LLM). Real-model spend ONLY phase 4.
Creds: OpenRouter key in ~/.config/altimate-code/config.json ; Vertex via gcloud ADC (project altimate-models).

## Phases
- P0 SUITE GREEN (in progress, sweep agent): bun test runs to completion + triage failures to 0.
- P1 FORK CARRY-FORWARD: enumerate fork features/commits; write tests asserting each survived the merge.
- P2 UPSTREAM MERGE-CORRECTNESS: identify the significant upstream changes that landed; adversarial tests
  they integrated correctly (SAMPLED — 3254 commits, target the systemic rewrites + risky areas).
- P3 EXPERT/COMPREHENSIVE TESTS: multi-agent + codex broad coverage on critical paths (auth/provider/
  session/tool/server/mcp/lsp), adversarial edge cases.
- P4 REAL E2E w/ LIVE MODELS ($50): run the merged agent end-to-end vs real models (OpenRouter cheap +
  Vertex), sampled ADE-bench/spider tasks; capture pass/fail; HARD budget cap, track spend.
- P5 CLI/TUI SMOKE + visual spot-check (claude-in-chrome / run CLI), capture output.
- P6 CONSOLIDATE + SHIP: full suite green, commit each phase, PR draft, marker re-baseline note, bun-version note.

## Status log (append per checkpoint)
- $(date 2>/dev/null || echo now): plan created; P0 in progress (sweep agent); typecheck GREEN all pkgs.
