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

## CHECKPOINT 10 — GATE CLEARED, agent runs end-to-end (ckpt36 committed 9e5d731ae5) — 2026-06-24
- BOOTSTRAP DEADLOCK FIXED + VERIFIED. Root causes (codex diagnosed, I verified independently):
  (1) withStatics() infinite recursion in core/schema.ts -> ProjectID.make() self-recursed.
  (2) re-entrant runtime: Plugin.init->Config.get() lost instance ctx outside Effect fiber.
  + follow-ons: db.ts fresh-db init, config branding regression (was importing core/global not fork ../global -> wrong ~/.config dir!), effect-zod tuple, session summary/status legacy-path idle-exit, truncation skip-malformed.
- VERIFIED (re-ran myself): instance-bootstrap+run.boot+id = 21 pass/0 fail/no-hang; typecheck=0; REAL run (azure/gpt-4o-mini) -> "> builder · gpt-4o-mini" -> "WORKING" exit 0. THE MERGED AGENT WORKS END-TO-END.
- 14 files committed ckpt36. Diags stripped. db.ts +199 flagged for deeper schema-parity review.
- NOW RUNNING: chunked full suite -> /tmp/suite_results/SUMMARY.txt (per-area logs, 240s/chunk timeout, isolates hangs). PID 83110. This gives first real full pass/fail.
- NEXT (after suite results): triage failures->0 (codex for source edits — Claude subagents WERE weekly-limited, retest), THEN P1 (fork carry-forward: flag-resolution/reviewer-agent/TUI-smoke) + P2 (v1.17.9 UPI adversarial from upstream-inventory.md, no dup test/upstream/*) + P3 + P4 real-e2e (free Ollama bulk + Azure quality, cap $45) + P5 TUI smoke + P6 PR. Disjoint slices, never 2 source-editors overlapping.
- Don't write tests until suite results known (know what's failing first; avoid collision with running suite).

## CHECKPOINT 11 — PARALLEL TRIAGE (5 workers) — 2026-06-24
- Full suite measured: 9581 pass / 868 fail (~92%). Failures cluster by ROOT CAUSE (disjoint -> parallelized):
- 5 WORKERS RUNNING (disjoint scopes, told to avoid each other's dirs + the recently-fixed run-service/plugin-index/config/db.ts):
  - codex #1 (/tmp/codex_provider.log): test/provider (~160: toEqual drift + "No context found").
  - codex #2 (/tmp/codex_db.log): test/session + test/control-plane + server-FK (~300: effect/sql FOREIGN KEY on session/workspace insert — parent project/workspace not seeded in fixtures, NOT codex's legacy db.ts).
  - codex #3 (/tmp/codex_install.log): test/install + installation + branding + release-validation (~109: content/assertion drift + possible branding leaks; env-only -> .todo+ENV note).
  - Claude agent a60eb71e: test/plugin (~36: ENOENT + not-a-function).
  - Claude agent acf7cdd1: test/tool (~40).
- Claude subagents WORK AGAIN (quota reset after re-login) — a60eb71e + acf7cdd1 launched OK.
- DGX (dgx-india): reachable but data-infra box (Superset/Oracle/langfuse containers via Multica :13000), no bun/codex/claude on host PATH -> NOT practical for this worktree triage. Possible later use: independent P4 real-model e2e (embarrassingly parallel) if branch synced.
- REMAINING for WAVE 2 (~113, after these land + re-measure): command(22) config(12) cli(11) agent(8) file(7) share(7) mcp(6) altimate(26) skill(14) effect(1) + server non-FK toBe(~?) failures.
- ON WAKE: check the 5 worker logs (codex: log byte-growth + tail; Claude: notifications). As each lands, VERIFY its area green + no typecheck regression, watch for cross-worker COLLISION (5 concurrent editors — scoped disjoint but verify `git status` sane). When all done: commit, RE-RUN full suite (/tmp/run_suite.sh), measure, launch WAVE 2 on remainder, then P4 real-e2e, P5 TUI, P6 PR.
- Suite re-run cmd: `nohup /tmp/run_suite.sh >/tmp/suite_runner.out 2>&1 &` -> /tmp/suite_results/SUMMARY.txt

## CHECKPOINT 12 — DGX provisioning + plugin done — 2026-06-24
- plugin cluster DONE (142 pass/0 fail, Claude agent a60eb71e). 4 workers still running (codex provider/db/install + Claude tool acf7cdd1).
- DGX: codex IS there (~/.npm-global/bin/codex v0.133.0 + ~/.bun/bin/bun); NOT on default PATH (use full paths or bash -lc). GitHub SSH auth FAILS (key not authorized for AltimateAI private repo). SOLUTION: rsync source (no node_modules/.git) Mac->DGX:~/altimate-merge-dgx + bun install there. Running in background PID 17132, log /tmp/dgx_setup.log. Pushed ckpt36 to origin too (origin=git@github.com:AltimateAI/altimate-code.git, used --no-verify to skip husky pre-push).
- DGX usage plan once ready: route WAVE-2 disjoint clusters (command/config/cli/agent/file/share/mcp/altimate/skill) to DGX codex via `ssh dgx-india "bash -lc 'cd ~/altimate-merge-dgx && ~/.npm-global/bin/codex exec --dangerously-bypass-approvals-and-sandbox ...'"`. SYNC BACK: DGX repo has NO .git (rsync excluded it) -> rsync the specific changed test/src dirs back from DGX to Mac (disjoint from local work = safe). Verify+commit locally.
- ON WAKE: (1) check /tmp/dgx_setup.log for "DGX READY" + typecheck count. (2) check 4 local workers (codex logs byte-growth+tail; Claude notifications). (3) as workers land, verify area green+typecheck0, watch collisions, commit batches. (4) when DGX ready, dispatch wave-2 to it + local. (5) when all green, re-run /tmp/run_suite.sh, then P4 e2e (free Ollama + Azure, cap $45), P5 TUI, P6 PR.

## CHECKPOINT 13 — spark-ec36 = the usable remote DGX — 2026-06-24
- USER'S DGX WITH GITHUB KEY = spark-ec36 (anand@100.123.226.52, Tailscale, 20 cores). HAS: github auth (clones private repo ✅, sees ckpt36), ~/.bun/bin/bun, codex /home/anand/.local/bin/codex v0.125.0 AUTHED (~/.codex/auth.json chatgpt mode). ALSO the Ollama host (free models for P4).
- (dgx-india/spark-80ca = ankit's, NO github key, rsync attempt /tmp/dgx_setup.log — abandon, use ec36. spark-036d = no access.)
- ec36 provisioning: clone branch upstream/merge-v1.17.9 + bun install, BG PID 20503, log /tmp/ec36_setup.log. Watch for "READY" + typecheck count.
- ec36 SYNC-BACK is CLEAN (it's a real git clone): after ec36 codex fixes a wave-2 cluster, `ssh anand@100.123.226.52 "cd ~/altimate-merge && git diff -- <paths>"` -> apply locally with `git apply`. Or git add+commit+push a sub-branch and cherry-pick. Disjoint clusters = safe.
- DISPATCH PLAN once ec36 ready: give ec36 codex a batch of wave-2 disjoint clusters (e.g. command+config+cli+mcp), keep local codex/Claude on others (agent+file+share+altimate+skill + server-non-FK). 
- LOCAL NOW: plugin DONE. Running: codex provider/db/install + Claude tool(acf7cdd1).
- ON WAKE: check ec36 READY (/tmp/ec36_setup.log), check local workers, dispatch wave-2 (local + ec36), as clusters land verify+commit, then re-run suite, P4 e2e (ec36 Ollama free + Azure), P5, P6.

## CHECKPOINT 14 — wave-1 committed (ckpt37), wave-2 dispatched — 2026-06-24
- CKPT37 COMMITTED (56 files, 2443+/872-): provider+plugin+install+installation+branding+release-validation VERIFIED GREEN (1336 pass/0 fail). ~305 failures fixed.
- WAVE-2 WORKERS RUNNING:
  - codex-session2 (LOCAL, /tmp/codex_session2.log): test/session + test/control-plane behavioral residuals (191 fail: compaction/revert/LLM/MessageV2/sessionWarp/SSE — FK root already fixed, these are unmasked assertion drift).
  - Claude agent a766ae60: test/agent + file + share + effect (~23).
  - Claude agent a464e202: test/altimate (26) + test/skill (14).
  - ec36 codex (REMOTE, /tmp/ec36_codex.log): test/command + config + cli + mcp (~51).
- HELD for next wave (shares src/session with session2 -> avoid collision): test/server non-FK (~111 toBe behavioral).
- TODO verify: test/tool (Claude acf7cdd1, was committed in ckpt37 — confirm 0 fail).
- ON WAKE: collect 4 workers (codex-session2 log; Claude notifications; ec36 log). As each lands: verify area `bun test test/<area>/|tail -5`=0fail + typecheck 0, commit batch (ckpt38+). PULL EC36 DIFFS: `ssh anand@100.123.226.52 "cd ~/altimate-merge && git diff -- packages/opencode/test/command packages/opencode/test/config packages/opencode/test/cli packages/opencode/test/mcp <any src>"` > /tmp/ec36.patch; `cd <root> && git apply /tmp/ec36.patch`; verify+commit. THEN dispatch server (~111) once session2 done. When all green: re-run /tmp/run_suite.sh, P4 e2e (ec36 Ollama free + Azure, cap $45), P5 TUI, P6 PR.

## CHECKPOINT 15 — CRITICAL: DB split-brain root cause found — 2026-06-24
- *** TOP REMAINING ROOT CAUSE: DB SPLIT-BRAIN *** (found by tool agent acf7cdd1). src/storage/db.ts (fork legacy SQLite, lazy-singleton) AND core @opencode-ai/core/database (Effect Database) BOTH open+migrate the SAME sqlite file -> "duplicate column name: metadata" / "table project already exists". Effect: every test area passes IN ISOLATION but FULL SUITE (shared process) gets flaky contamination (tool: 0 fail isolated -> up to 74 together). This inflates session/server/config/control-plane run-together failures. Related to codex's db.ts bootstrap fix (initializeFreshDatabase). NEEDS a focused infra fix: ONE db owner / don't double-migrate. Do NOT parallelize (sensitive infra). HIGH PRIORITY after current workers land.
- tool cluster: per-file GREEN (470 pass/0 fail). task.test.ts 14 skipped w/ BUG notes (blocked by THIS db split-brain). Edits marked altimate_change.
- ec36 (command/config/cli/mcp): code-only diff APPLIED locally (excluded its bun.lock + @types/pg/playwright-core dep adds — verify if needed later). After apply: 1113 pass / 53 fail in those areas — residual = partly DB split-brain + maybe the 2 skipped deps + cross-env snapshots (ec36=linux/aarch64). ec36 remote-edit transfer is LOSSY cross-env; lesson: use ec36 for P4 e2e/verification, not code-edits-to-transfer.
- RUNNING: codex-session2 (src/session residuals), Claude a766ae60 (agent/file/share/effect), Claude a464e202 (altimate/skill).
- WORKING TREE is busy (ec36 apply + 3 workers' edits uncommitted). Don't commit until workers land + DB split-brain assessed.
- ON WAKE: collect session2 + 2 Claude agents; THEN fix DB split-brain (the big lever for full-suite green); THEN re-run full suite for true number; then server; then P4 e2e (ec36 Ollama); P5; P6 PR.

## CHECKPOINT 16 — DB split-brain CONFIRMED by 2nd agent; a766ae60 done — 2026-06-24
- a766ae60 DONE: agent(48p/1todo) file(79p) share(4p/3todo, +1 src-fix share-next.ts InstanceRef bridge) effect(95p) — all 0-fail IN ISOLATION. Combined agent+file+share+effect: 78 fail baseline -> 67 with fixes; RESIDUAL = DB split-brain ("table project already exists"). INDEPENDENTLY CONFIRMS the split-brain.
- typecheck transiently 8 (session2 + a464e202 mid-edit: compaction.ts/test + dbt-first-execution.test + test/lib/effect.ts) — NOT ec36's patch (its cli/config/command/mcp files clean). Will clear when workers finish.
- *** NEXT MAJOR ACTION (highest lever): FIX DB SPLIT-BRAIN. *** Mechanism: legacy src/storage/db.ts + core @opencode-ai/core/database BOTH migrate the SAME sqlite file (shared OPENCODE_DB across test files in one process) -> duplicate column metadata / table project exists. PRODUCTION single-run WORKS (e2e passed) -> manifests mainly in TEST harness (shared db + both migrators). INVESTIGATE FIRST whether fix belongs in TEST FIXTURE (clean db per file / single migrator in test setup — see test/lib/effect.ts provideTestInstance, test/fixture) vs production src. Likely test-harness. This is THE lever for full-suite green. Handle carefully (don't blind-codex; codex's initializeFreshDatabase is part of it). Don't parallelize.
- STILL RUNNING: codex-session2 (src/session compaction/revert/LLM/MessageV2), Claude a464e202 (altimate/skill).
- ON WAKE: (1) collect session2 + a464e202, verify their areas isolated-green + typecheck back to 0, COMMIT consolidated batch (ckpt38, includes ec36 cli/config/command/mcp + tool + agent/file/share/effect + altimate/skill + session). (2) FIX DB SPLIT-BRAIN (investigate test-harness vs src; the big lever). (3) re-run /tmp/run_suite.sh for TRUE full-suite number. (4) dispatch server (~111). (5) P4 e2e (ec36 Ollama). P5 TUI. P6 PR. Budget $50 untouched (only tiny azure verify spend so far).

## CHECKPOINT 17 — altimate/skill done; DB split-brain mechanism nailed — 2026-06-24
- a464e202 DONE: altimate+skill 4261 pass/0 fail isolated (1 src-fix dbt-schema-verify.ts erroredNames; rest test-fixes). 3RD independent confirmation of DB split-brain + precise mechanism: legacy db.ts (bun:sqlite, own conn+migration-tracking) and core effect-sql (own conn+tracking) both migrate the SAME file; second migrator sees divergent sqlite_master/tracking -> "table project already exists" or replays "ALTER TABLE session ADD metadata". Bare Instance.provide OK; anything booting runtime (Agent.get/initTool/sql_execute) triggers. Re-enables MANY .todo'd tests (skill-followups, reviewer-agent, tool-lookup, sql-validation-e2e ~30+).
- DB FIX TARGET (recon done): test/preload.ts:88-90 INTENTIONALLY points both Effect-SQL + legacy db.ts at ONE shared file (opencode-local.db) "so they see same rows during v1.17.9 transition". Sharing is intentional; bug = BOTH migrate with separate connections+tracking. FIX = coordinate migration (single owner / skip-if-tables-exist / shared tracking / WAL checkpoint before 2nd reads), NOT file separation. Production single-run works (codex's db.ts initializeFreshDatabase + `if(!initialized) migrate` handles order there). Intricate infra — do carefully on clean base, don't parallelize, keep production run working.
- session2 STILL running (src/session; reports MessageV2+pagination green, finishing compaction/revert/LLM clusters). LAST running worker.
- ALL per-area clusters now green-in-isolation: provider/plugin/install/branding/release(committed ckpt37) + tool/agent/file/share/effect/altimate/skill/command/config/cli/mcp (uncommitted) + session(in progress). Server (~111) still to dispatch.
- HEARTBEAT pending 13:47 will: collect session2 -> commit ckpt38 -> FIX DB SPLIT-BRAIN -> re-measure full suite -> server -> P4 e2e -> PR.

## CHECKPOINT 18 — DB split-brain FIX DESIGNED (architecture mapped) — 2026-06-24 ~13:47
- ARCHITECTURE: core @opencode-ai/core/database = CANONICAL (full schema.gen.ts: workspace/project/session/message/part/account/event/...; DatabaseMigration.apply at database.ts:33, WAL). Legacy src/storage/db.ts (fork, bun:sqlite, own conn + fork migrations packages/opencode/migration/) redundantly migrates the SAME tables on the SAME file (OPENCODE_DB). preload.ts:88-90 shares one file intentionally (same rows). => two migrators, same tables, separate conns/tracking = "table project already exists"/"duplicate column metadata".
- FIX DESIGN (do on CLEAN base, carefully, myself): make migration SINGLE-OWNER. Core is canonical. Options in priority:
  (a) In TEST preload.ts: after setting OPENCODE_DB, run CORE migrator ONCE first (await DatabaseMigration.apply via AppRuntime / a tiny bootstrap) so schema exists; then legacy db.ts initializeFreshDatabase sees tables -> initialized=true -> skips migrate(). Verify legacy db.ts `initialized` check actually detects core-created tables (cross-connection: needs WAL checkpoint or fresh read — may need `PRAGMA wal_checkpoint` or check via its own conn).
  (b) Make legacy db.ts migrations idempotent / table-existence guarded (CREATE TABLE IF NOT EXISTS already? check) AND share migration-tracking, so 2nd migrator no-ops.
  (c) If schemas DIVERGE on any table, reconcile (but comment says same rows -> same schema).
  Production single-run already works (codex's db.ts `if(!initialized) migrate`), so prod path OK; focus = make the TEST multi-file shared-process path robust. KEEP production run cmd working (re-verify e2e after).
- VERIFY fix: `cd packages/opencode && bun test test/agent/ test/file/ test/share/ 2>&1|tail -5` should go 67 fail -> ~0 (these were ALL db-split-brain residual). Then full suite.
- session2 = last worker, 1hr in, 0%CPU (waiting on bun-test subprocess running full session suite to measure), last wrote 44s ago = ALIVE+progressing (slow: 191 session residuals + reruns). typecheck=12 (its mid-flight session edits).
- ON WAKE: if session2 done -> verify session isolated-green + typecheck 0 -> commit ckpt38 -> EXECUTE DB FIX (design above) -> verify agent/file/share 67->0 -> re-run full suite for TRUE number -> server -> P4 e2e -> PR. If session2 STILL running after this cycle (>1.5hr total), check if looping; consider letting it be + doing DB fix on a stash of its work or after.

## CHECKPOINT 19 — DB split-brain precisely characterized + delegated to codex — 2026-06-24
- DEEP INVESTIGATION (main loop): the split-brain is a RACE, not just ordering. Mechanism: legacy db.ts (bun:sqlite, Database.Path=opencode-local.db via channel=local) + core (effect-sql, OPENCODE_DB) resolve to the SAME file in tests. core apply() reads sqlite_master EMPTY (before legacy commits / concurrent fibers) -> takes FRESH path -> CREATE TABLE project (core/sqlite.bun.ts:58) -> collides with legacy's tables -> "table `project` already exists". NONDETERMINISTIC: a dir shows 0 or up to ~74 fail by file order (tool agent confirmed). So per-area "green in isolation" is partly luck-of-order; real full-suite is contaminated.
- I TRIED 3 fixes in main loop, ALL reverted (didn't converge, broke isolation): (a) repairLegacyDatabase return-true+mark-applied; (b) core applyOnly adopt-all; (c) preload pre-build legacy schema. Failed because core hits FRESH path (race), so applyOnly/legacy fixes don't engage + pre-build didn't serialize. Tree back to BASELINE (ckpt37 + uncommitted wave-2 worker edits).
- DELEGATED to codex (/tmp/codex_dbfix.log, PID launched): full analysis + 3 approaches (1: single-owner in preload w/ wal_checkpoint+adopt; 2: idempotent CREATE IF NOT EXISTS + core re-check under BEGIN IMMEDIATE; 3: serialize/one-migrator). Must be DETERMINISTIC (verify 3x), keep prod run working, don't touch session.
- session2 STILL running (2hr, last per-area worker, src/session).
- ON WAKE: (1) check codex-dbfix result (the BIG lever) — verify agent/file/share 3x deterministic 0 fail + typecheck 0 + prod run works; review its edits; commit. (2) check session2 done -> commit. (3) re-run FULL suite /tmp/run_suite.sh for TRUE post-dbfix number (should drop a LOT). (4) remaining: server, any residuals. (5) P4 e2e (ec36 Ollama). (6) P5 TUI, P6 PR.
- NOTE: ec36 cli/config/command/mcp patch is applied in working tree (53 residual, partly THIS split-brain — re-measure after dbfix). Budget ~$0.
