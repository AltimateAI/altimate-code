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

## CHECKPOINT 5 (CRITICAL: bootstrap hang found) — ckpt35 committed
- DISCOVERY: runtime is NOT broken for pure tests (24/24 pass), BUT bootstrap-heavy paths HANG (infinite): `bun test test/project/instance-bootstrap.test.ts` hangs; headless `run` cmd boots->migrations->hangs (both Ollama+Azure, no agent loop, no file). This is why the full suite produced no results (a bootstrap-triggering test hangs -> bun test killed at timeout -> buffered output lost) AND why e2e made no file.
- ROOT CAUSE (isolated via stash): the broad Layer.suspend sweep (ckpt35, ~29 extra modules) traded the AppRuntime TDZ for a LAYER-BUILD DEADLOCK. Stash of sweep edits -> hang gone (TDZ returns). Hypothesis: Layer.suspend over-applied; per-module makeRuntime (run-service.ts, shares global memoMap) builds a 2nd ManagedRuntime from a suspended defaultLayer -> non-memoized rebuild cycle -> deadlock when a Promise-wrapper fires during AppLayer/bootstrap .init().
- ACTION: agent ac997276 bisecting which suspend(s) deadlock; fix = revert unnecessary suspends (only facade-cyclically-imported modules need it) / break real import cycle / fix makeRuntime, while keeping TDZ fixed + typecheck 0. Verify: bootstrap+run.boot+httpapi-session+id tests pass, run-smoke creates file.
- BLOCKS: full suite, e2e (P4), most of P1/P2/P3 validation. THIS IS THE GATE NOW (not just suite-green). Do NOT spawn source-editing agents until this lands (would collide).
- e2e infra otherwise works; creds validated (free Ollama + Azure). Inventories done (no fork drops; upstream UPI risk list ready). ~400 existing merge tests in test/upstream/*.

## CHECKPOINT 6 (hang root-cause localized, delegated to codex) — 2026-06-24
- SUBAGENT CONSTRAINT: 2 Claude agents died to WEEKLY usage limit (reset Jun 27 / after user re-login). Using CODEX (separate quota) for the critical hang-fix; I drive coordination in main loop.
- HANG localized: AppLayer build is FINE (trivial AppRuntime effect runs ~1s). Hang is in INSTANCE-BOOTSTRAP path WITH instance context, BETWEEN fork-db first-use migration (src/storage/db.ts:142) and runBootstrap's first init (no 'before plugin.init' log prints). NOT shared-memoMap alone (per-runtime memoMap didn't fix). Likely: a per-module makeRuntime Promise wrapper (28 callers, run-service.ts:35) fires mid-bootstrap, builds a 2nd ManagedRuntime from a suspended defaultLayer -> re-entrant layer-build deadlock under InstanceLayer scoping.
- Fix delegated: codex (task /tmp/codex_hangfix.txt, log /tmp/codex_hangfix.log, watcher bllmpjvpr-watch). Codex to instrument run-service getRuntime + bootstrap + instance-provide, find the re-entrant build, apply minimal fix (prefer: delegate per-module wrappers to shared AppRuntime / break real import cycle so suspends can drop / memoize per-instance layers), keep typecheck 0 + TDZ fixed, verify bootstrap+run.boot+id tests pass + run-cmd completes. NOT committing (I review).
- Clean base: HEAD=ckpt35 (b23baec1c1), src clean (0 modified). All my diagnostic edits reverted.

## CHECKPOINT 7 (HANG PINPOINTED) — 2026-06-24
- CODEX IS ALIVE (PID 74508, working hang-fix; my watchers exited spuriously — ignore, codex still running). It left active diag instrumentation in 6 files (run-service, bootstrap, instance-layer, instance-store, project, session/prompt). DO NOT edit those files (collision with codex).
- HANG PINPOINTED via diags: cli/bootstrap.ts -> InstanceRuntime.load -> AppRuntime.runPromise(InstanceStore.Service.use(store=>store.load)) -> InstanceStore.boot -> Project.fromDirectory. Last flushed diag (even to file, unbuffered) = "[diag Project.fromDirectory] after db select true". Hang is in project.ts fromDirectory BETWEEN the db-select (row found, existing project) and the db-upsert — code block is fromRow(pure)/discover(flag-off)/object-construction/sandboxes.filter(existsSync)/insert+updateSet. All appears SYNC. Either a sync infinite loop OR an async-wait not yet identified OR the next Database.use (upsert) re-entrant-deadlocks.
- CORRECTION to earlier: "AppLayer build is fine" was misleading — trivial Effect.sync needs ZERO services so builds nothing. But heavy services (Database/Config/Plugin/InstanceStore) DO build fine individually (708ms). So hang is in fromDirectory EXECUTION, not layer build.
- All 5 service-layer builds OK. Likely culprit narrowed to project.ts:~298-350. Codex is on it.
- STAND DOWN: let codex finish (don't duplicate/collide). On next wake: check codex result (/tmp/codex_hangfix.log tail, git status for its fix), verify bootstrap test passes + typecheck 0 + run-cmd completes, REMOVE all leftover [diag] instrumentation (grep -rn "\[diag" src), commit ckpt36, then resume P1/P2/P3/P4 fan-out.

## CHECKPOINT 8 (codex found REAL root cause — db migration on fresh db) — 2026-06-24
- CODEX STILL RUNNING (process-poll watchers give FALSE alarms — pgrep races on codex subprocess spawns; rely on ScheduleWakeup heartbeat, NOT watchers).
- BETTER ROOT CAUSE (codex): the hang is `migrate(db, entries)` in src/storage/db.ts on a FRESH/EMPTY SQLite db. NOT (only) the Layer.suspend deadlock. Reconciliation: the suspend sweep fixed the TDZ, which EXPOSED this db-migration hang underneath. My earlier "stash removes hang" was misleading — stash restored the earlier TDZ that short-circuits BEFORE reaching the db migrate. So there are TWO layers: TDZ (fixed by suspends) + db-migrate-on-fresh-db hang (codex fixing now).
- CODEX FIX (in progress, db.ts): add initializeFreshDatabase(sqlite, entries) that creates base schema + seeds drizzle journal for empty db files; then `if (!initialized) migrate(db, entries)`. Re-running instance-bootstrap test to verify.
- REVIEW CONCERNS for when codex finishes: (1) does skipping migrate on fresh-db produce the CORRECT final schema (== running all migrations)? (2) why does migrate() actually hang on fresh db — is codex fixing the symptom or cause? (3) keep the Layer.suspend sweep ONLY if still needed for TDZ (may be reducible). (4) REMOVE all [diag] instrumentation (grep -rn "\[diag" src) before commit. (5) verify typecheck 0 + bootstrap/run.boot/id tests pass + run-cmd completes a turn.
- NEXT: on wake, check codex result, review fix per above, strip diags, commit ckpt36, then full suite + P1/P2/P3/P4 fan-out.

## CHECKPOINT 9 ($(date +%H:%M)) — codex iterating well through the runtime stack
- codex ALIVE 25min+, log 4.1MB growing. Fixed chain so far: db-migration-on-fresh-db (db.ts initializeFreshDatabase) -> zod() AST-walker tuple support (util/effect-zod.ts, for config plugin specs) -> NOW running real run-cmd repro (azure/gpt-4o-mini) to verify end-to-end. Driving to a working run.
- codex doing real azure verify runs (minimal spend, logged in BUDGET.md).
- DO NOT interfere (codex editing source + running verifies). Let it complete its verify loop.
- When codex done: review ALL its edits (db.ts fresh-db init correctness, effect-zod tuple, any others), strip [diag], verify (bootstrap+run.boot+id tests + typecheck0 + run-cmd), commit ckpt36, resume P1-P6.
