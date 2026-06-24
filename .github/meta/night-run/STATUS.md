# NIGHT-RUN STATUS (update each checkpoint; source of truth post-summarization)

## DONE
- Typecheck GREEN all 14 packages (3181->0). Code bundles. app-runtime/index import clean.
- Runtime circular-init: Layer.suspend on defaultLayer compositions + thunked LayerNode deps (core/effect/layer-node.ts supports thunk). 34+ checkpoints committed.
- Creds validated: FREE Ollama qwen3-coder-next @ 100.123.226.52:11434 (bulk e2e, $0); Azure key in config (gpt-4o-mini/gpt-5.5, real); Vertex via ADC (deepseek). OpenRouter env key NOT reachable non-interactively — skip.

## IN FLIGHT (background)
- a0de8473 sweep agent: Phase 0 — comprehensive Layer.suspend/thunk sweep across ~33 modules, running full `bun test` to confirm suite runs to completion. CRITICAL PATH.
- ad7c9a6b fork-inventory: spawned 4 sub-agents (altimate-tools DONE = all 76 tools+native present; telemetry DONE = preserved; TUI/branding + skills/agents pending). Output -> .github/meta/night-run/fork-inventory.md
- codex bbqskh555 upstream-inventory -> .github/meta/night-run/upstream-inventory.md (watcher bfmzhyrc5)
- be0lr1qgl e2e smoke: real Ollama run, trivial write task, log /tmp/e2e_smoke.log. Proves agent runs end-to-end.

## NEXT (gated on suite-green + inventories)
- Triage any bun test failures -> 0 (CRITICAL, do first when sweep reports).
- Then FAN OUT (disjoint slices, Claude+codex), each agent runs ONLY its scoped test file (never full suite concurrently):
  - P1 fork carry-forward regression tests (from fork-inventory.md; PRIORITIZE any flagged-dropped feature = real bug).
  - P2 upstream merge-correctness adversarial tests (from upstream-inventory.md, top 20-40 risk areas).
  - P3 expert coverage on critical paths (auth/provider/session/tool/server/mcp/lsp) — instruct: assert INTENDED behavior, real bugs -> test.todo + BUG note, NEVER weaken assertions.
  - P4 real e2e: bulk on FREE Ollama (sample ADE-bench/representative tasks), quality samples on Azure gpt-4o-mini; track spend BUDGET.md, cap $45.
  - P5 CLI/TUI smoke + visual spot-check (claude-in-chrome if web surface).
  - P6 consolidate: full suite green -> commit each -> PR draft. Marker --strict = bridge artifact (re-baseline note, NOT 167 edits). Build needs bun 1.3.14 (env note).

## LOOP HEALTH: background jobs notify; ScheduleWakeup heartbeat ~1500s fallback. Never end a turn without one or the other.

## CHECKPOINT 2 (fork-inventory done)
- fork-inventory.md COMPLETE: 19 categories, 5 P0. **DROPPED features: NONE.** 76 tools/83 native handlers/10+ drivers/21 skills/4 agent modes all present.
- At-risk (present, verify): (a) TUI feature plugins runtime-unverified -> P5 TUI smoke; auto-enhance dormant (no pre-submit interceptor), manual works. (b) FLAG finding: core/flag.ts = streaming/calm/yolo (24 importers, live); opencode/flag.ts = memory/training/permission flags + `declare const ALTIMATE_CLI_YOLO` (type-only, no value), my grep showed 0 importers -> P1 RUNTIME-RESOLUTION test (assert Flag.OPENCODE_PERMISSION + ALTIMATE_CLI_YOLO resolve; check opencode/flag.ts isn't dead). (c) branding GitHub-App block re-applied w/ upstream_fix marker -> bridge-guard before main. (d) reviewer agent lacks test -> P1 add.
- Doc drift (not regression): MEMORY "6 agents/11 skills" actually 4 agents/21 skills; validator/migrator/executive are SKILLS not agents.
- e2e smoke: runtime BOOTS clean (telemetry/project/db/migrations) but log stalls after migrations -> watching (model-call slow on remote Ollama, or hang in run path; 400s timeout will resolve). 

## CHECKPOINT 3 (inventories done, suite running)
- upstream-inventory.md DONE (37KB): UPI-01..~32 across 7 sections w/ P0/P1 + test ideas. P2 FAN-OUT = 1 agent/section:
  S1 Effect runtime/facades (UPI-01..03), S2 session/storage/projection (UPI-05..10), S3 tool API/schema/registry (UPI-11..14),
  S4 provider/model/LLM (UPI-16..21), S5 config/MCP (UPI-22..27), S6 server/httpapi/auth/SSE (UPI-28..32), S7 TUI extraction.
  Each agent: CHECK existing coverage (lots exists: test/upstream/*, test/session, test/tool, test/server, test/mcp, test/provider) then ADD adversarial gap-fillers only. Assert INTENDED behavior; real bug -> test.todo + BUG note.
- KEY: repo ALREADY has merge-adversarial suites (test/upstream/{v140-merge-adversarial,bridge-merge-invariants,-fuzz,-chaos,-runtime}, branding/*, altimate/validators/adversarial-wave-*). P2 = green + gap-fill, NOT from scratch.
- Sweep agent running FULL unit suite -> /tmp/bt3.log (started 06:04, ~400 files, 480s timeout). THIS gives real pass/fail = the gate.
- P1 concrete targets: flag runtime-resolution test (OPENCODE_PERMISSION confirmed live @config.ts:633), reviewer-agent test, TUI plugin smoke, auto-enhance dormancy note.
- e2e smoke (be0lr1qgl): output buffered; 400s timeout will flush. Runtime boots clean.

## CHECKPOINT 4 (existing-coverage survey)
- Repo ALREADY has ~400 merge-validation tests in test/upstream/: bridge-merge-e2e(62, real CLI), bridge-merge-invariants(43, ServiceMap id-uniqueness + SyncEvent/BusEvent registry), bridge-merge-runtime(17), bridge-merge-v3(88, Account.active await), bridge-merge(42, anthropic), v140-merge-adversarial(40, deps/patches), v140-merge-chaos(13, fuzz), altimate-features(42), github(24), release-only-merge(25).
- IMPLICATION: merge-correctness is heavily tested for v1.4.0+incremental. The v1.17.9 JUMP is the new delta. P2 = (a) confirm the ~400 still pass (sweep suite result = the proof), (b) ADD adversarial tests ONLY for v1.17.9-specific UPI risks not already covered. Do NOT duplicate existing test/upstream/* — agents must grep existing names first.
- e2e: weak local Ollama failed trivial task (EXIT 0, no file) = model capability, not merge bug. Retrying Azure gpt-4o-mini (b2d6oowfd) for true proof.
- GATE: sweep agent (a0de8473) full unit suite -> real pass/fail. Then triage->0, then fan out P1/P2/P3.
