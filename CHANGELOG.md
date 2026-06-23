# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.10] - 2026-06-22

### Fixed

- **The daily date no longer invalidates the cached system prompt across midnight.** The volatile "Today's date" line was the first entry in the cache-controlled system prefix, so a session left open across midnight within the cache TTL dropped its entire cached system prompt and paid to rebuild it. The date now rides the trailing user message — off the long-lived system-prefix cache and onto the rolling per-turn breakpoint that is rewritten every turn anyway — so the cached system bytes stay date-invariant and the agent still receives today's date each turn. (#950, fixes #949)

### Internal

- **The Windows installer Pester suite is deterministic on the updated `windows-latest` runner.** The harness now applies `PROCESSOR_*` overrides inside the child `pwsh` session instead of relying on Process-scope inheritance, which the new runner image re-initialized for the loader-managed `PROCESSOR_ARCHITECTURE` (it arrived blank → a spurious `Unsupported OS/Arch` failure). Test-only: the shipped `install.ps1` and the v0.8.9 binaries are unaffected — real users always have a populated `PROCESSOR_ARCHITECTURE`. (#959, fixes #958)
- **Added a v0.8.10 adversarial + coverage suite** that closes the prior test gap on the date fix — it exercises the trailing-user-message path (date reaches the model, only the last user turn is tagged, no accumulation across turns, survives an all-ignored user turn) plus a static regression guard on the Windows installer harness. (#950, #959)

## [0.8.9] - 2026-06-19

### Fixed

- **The non-interactive `run` guard no longer mis-handles a blank env var.** A blank/whitespace `ALTIMATE_NON_INTERACTIVE=` is now treated as unset, so it can't silently reintroduce the headless `run` hang that #937 fixed. (#937 follow-up)
- **Session transcript boolean query flags accept the common falsey strings.** `thinking`, `toolDetails`, and `assistantMetadata` now treat `false`/`0`/`no`/`off` (case-insensitive) as false, not just the literal `"false"`. (#941 follow-up)
- **Writing an MCP server entry refuses to clobber an unparseable config** (detected via `parse()` with an error sink, not the error-tolerant `parseTree()`), and `updatedAt` is preserved through config normalization so the datamate reconnect signal survives. (#893 follow-up)
- **dbt error bubbling strips the full ANSI escape family** (cursor/erase sequences from progress spinners), not just SGR color codes. (#933 follow-up)

### Changed

- **The headless `serve` startup upgrade check is jittered** (base + random, ~1–6s) so a fleet restarting together doesn't stampede the unauthenticated GitHub releases API in the same instant. (#940 follow-up)

### Internal

- **Diverged upstream constants are wrapped in `altimate_change` markers** (`DEFAULT_CHUNK_TIMEOUT`, the question-tool `output` field) so they survive upstream merges. (#844, #937)
- **Added a v0.8.9 adversarial test suite** covering the shipping code and the review fixes under hostile input (question-tool env matrix, MCP config parse-guard, startup-upgrade fail-safety + jitter).

## [0.8.8] - 2026-06-19

### Added

- **Windows now has a one-line PowerShell installer.** `irm https://www.altimate.sh/install.ps1 | iex` downloads the standalone binary from GitHub releases (AVX2-aware, with a baseline fallback), adds it to your user `PATH`, and supports `-Version`, `-NoPathUpdate`, and `-ForceBaseline`. `altimate upgrade` uses the same path on Windows. (#930)
- **IDE-aware datamate transport, MCP enabled-state persistence, and a `/mcps` command.** The active IDE's `mcp.json` datamate entry/URL is mirrored into `altimate-code.json` and reconnected when it changes; enabled/disabled state for MCP servers now persists to disk; `/mcps` lists and toggles servers; project `mcp.json` files are discovered recursively (project-scoped servers are discovered disabled, never auto-connected). (#893)
- **Session transcript REST endpoint for the datamates extension.** `GET /session/:id/transcript` returns the full conversation as formatted Markdown, with `thinking`, `toolDetails`, and `assistantMetadata` query flags. (#941)

### Changed

- **Headless `serve` now checks for and applies updates on startup.** When `autoupdate` is unset (the default) and a supported install method is present, `serve` performs a one-shot, best-effort self-upgrade shortly after start. It never restarts the running process and can never crash `serve` (errors are swallowed). Opt out with `autoupdate: false` or `"notify"` in config, or `OPENCODE_DISABLE_AUTOUPDATE=1`. (#940)
- **The per-chunk streaming watchdog timeout was raised from 2 minutes to 5 minutes** so slow warehouse/LLM streams are not aborted prematurely. (#844)

### Fixed

- **`dbt show`/`compile` failures now surface the real dbt error** instead of a generic "Could not parse", with inline SQL redacted from the message so secrets/PII don't leak into logs. (#933)
- **The question tool no longer hangs in non-interactive contexts.** `altimate run` is detected as headless and returns "Unanswered" (letting the agent decide) rather than blocking forever; `ALTIMATE_AUTO_ANSWER=first|last|<label>` can pre-answer. (#937)
- **Windows release archives are verified by checksum in both installers** before extraction, and latest-version resolution is more resilient to transient fetch failures. (#942, #946)

### Internal

- **`serve` logs the trace directory on startup** so operators can find session traces. (#929)
- **Added a release-validation regression suite** covering the merged PRs. (#952)

## [0.8.7] - 2026-06-10

### Added

- **Verified query optimization — `altimate_core_rewrite` now proves a rewrite is safe before suggesting it.** A new `verify_equivalence` mode composes the rewrite engine with the equivalence checker: a candidate rewrite is labeled **VERIFIED** only when the engine affirmatively returns `equivalent === true`; everything else (including the no-schema case) is still returned but labeled "review before applying." This is the gated core for one-click verified query optimization, so an optimization that silently changes results is never presented as safe. (#918)
- **Per-turn tool retrieval trims the tool-definition context flood.** Three flag-gated, default-off agent-loop reliability features: a per-turn tool subset (always-on core tools + lexical top-k, never dropping a tool referenced mid-trajectory) that cuts the ~78-tool definition payload sent each turn; grammar/JSON-Schema constrained decoding for local models (vLLM/LM Studio/llama.cpp); and a pluggable pre-execution critic gate for side-effecting tools. All default off, so the existing agent path is unchanged unless explicitly enabled. (#858)

### Changed

- **Upgraded the SQL engine `@altimateai/altimate-core` `0.4.0` → `0.5.1` and wired its new equivalence capabilities into the dbt PR reviewer.** The reviewer now forwards the project's SQL **dialect** hint to the equivalence engine, so dialect-specific compiled warehouse SQL (e.g. Snowflake semi-structured `col:field`) parses and the comparison is decided instead of abstaining on a syntax error, and it honors the engine's new authoritative **`decidable`** flag — abstaining when the engine itself says it could not decide, rather than guessing. An empty/auto-detect dialect is coerced to "no hint" so the engine is never handed an unknown dialect. (#925, #928)

### Fixed

- **The dbt PR reviewer is more reliable and less noisy.** Demo-parity hardening: tighter PII-review precision, reduced safe-refactor review noise, schema YAML catalog rules now run in review, and added DuckDB data-diff end-to-end coverage. (#919)
- **dbt review no longer misclassifies YAML files.** Schema/property YAML files are classified correctly so the right rules apply to them. (#920)
- **The `release-v0.8.5` adversarial test gate is pinned to a constant version** so it stops breaking on every subsequent release. (#923)

### Internal

- **Centralized code-review dispatch on PR ready.** A gated loop dispatches a centralized OCR/Gemini review when a pull request is marked ready for review. (#914)

## [0.8.6] - 2026-06-08

### Added

- **Session traces now work in headless `serve` mode — your VS Code "Altimate Code" chat sessions show up in `/traces` just like terminal sessions.** Sessions driven over `altimate serve` (the server behind the VS Code chat panel) had no TUI worker observing the event stream, so trace files were never written and `/traces` was always empty after a chat. The per-session tracing logic is now a shared `TraceConsumer` wired into both the TUI worker and `serve`, so IDE chat sessions produce the same incremental `ses_<id>.json` files — full multi-turn waterfall, recorded prompt, tool-call log, cost, and timing. `serve` now registers `SIGINT`/`SIGTERM`/`beforeExit` handlers that drain and finalize in-flight traces on shutdown (so a serve trace ends as `completed`, not `running`, and the process exits with signal-conventional codes), finalizes a session as soon as it is deleted, and finalizes all open sessions concurrently so a busy server isn't cut off mid-write by a container shutdown grace period. (#886)

## [0.8.5] - 2026-06-06

### Fixed

- **The `github/review` composite action can be downloaded by GitHub Actions again.** The release tree contained three VS Code image symlinks whose removed targets caused GitHub's action downloader to reject the entire archive before the review step started. The images are now self-contained files and a release-critical test prevents dangling links from returning.
- **A valid dbt manifest is no longer mislabeled as a lint-only run.** Manifest availability is now checked independently from changed-model lookup, so new models and other valid manifests receive the correct full-run status.
- **The release-version lookup is rate-limit resilient and never caches a floating `latest`.** The composite action now authenticates its GitHub release-API call with the workflow token (lifting the 60→1,000 req/hr unauthenticated limit) and skips the binary cache entirely when the version resolves to `latest`, so a single rate-limited or offline lookup can no longer pin a stale binary across all subsequent runs.
- **Session traces survive worker restarts, concurrency, and long sessions without corruption or false alarms.** Three reliability follow-ups to the v0.8.4 trace-durability fix: reconstructed in-flight spans are marked `interrupted` and render with an amber "⚠" instead of red (and are excluded from the session error count) so a restart isn't misread as a failure (#901); `getOrCreateTrace` no longer resurrects a `Trace` into a cache that a concurrent stream switch already cleared, preventing an orphan writer under a dead stream (#902); and the on-disk `ses_<id>.json` projection is bounded to `MAX_SERIALIZED_SPANS` (default 5000, override via `ALTIMATE_TRACE_MAX_SPANS`), keeping head + tail and eliding the middle so long sessions no longer grow the file without bound or pay O(n²) write cost (#903).

### Added

- **Direct GitHub onboarding and a live dbt review demo.** The GitHub App installer now opens GitHub's repository-selection screen directly, and the README/docs link to the public `dbt-pr-review-demo` pull requests.

### Security

- **The hosted Altimate API key is no longer placed on the `jq` process arg list.** The credential write reads the key from the environment inside the `jq` program, keeping it out of `argv` (which is visible to other processes and printed verbatim when `ACTIONS_STEP_DEBUG` enables `set -x`).

## [0.8.4] - 2026-06-05

A trace-durability patch. Open `/traces` mid-session and you'd see a rich waterfall — then the moment the agent finished its turn the view collapsed to a single "system-prompt" span, the Summary tab's *"What was asked"* showed *"No prompt recorded"*, and the Chat tab dropped every user turn but the last. The data was genuinely gone from disk, not just hidden in the viewer. This release stops the on-disk trace from being overwritten after each turn and makes the file authoritative across worker restarts. A five-persona pre-release review drove a follow-up wording fix so a reconstructed trace isn't misread as a failed run.

### Fixed

- **Session traces no longer lose their data after every agent turn — the waterfall, summary prompt, and chat tab all stay intact.** A `session.status === "idle"` handler in the shared TUI worker fired once *per turn* (not once per session), ending the `Trace` and evicting it from cache; the next event reconstructed a fresh `Trace` whose near-empty initial state overwrote the rich `ses_<id>.json` on disk with a one-span file. Symptoms: the **Waterfall** collapsed to a lone "system-prompt" span, the **Summary** tab's *"What was asked"* went to *"No prompt recorded"*, and the **Chat** tab kept only the last user turn. The destructive idle handler is removed (sessions are long-lived — finalization happens on shutdown and `MAX_TRACES` eviction only), trace reconstruction now **rehydrates from the on-disk file** before falling back to a fresh start, and each user prompt is recorded as its own `user-message` span so multi-turn sessions render every turn in order. Authored-text scoping keeps synthetic parts (MCP banners, decoded file contents, reminders) out of the prompt and chat surfaces. Distinct from the v0.8.1 trace-corruption fix (#865), which addressed intra-instance concurrency — this is the worker-level cache lifecycle. (#895)
- **A trace reconstructed after a restart no longer reads as a failed run.** When the on-disk trace is rehydrated (worker restart or `MAX_TRACES` eviction), any generation span still in flight is closed and marked so its boundary stays visible in the waterfall. The status message now states plainly that altimate-code restarted before the step finished recording and that this is **not an agent failure** — so an on-call reader debugging from a trace isn't sent chasing a phantom incident. (#895)

## [0.8.3] - 2026-06-04

A plan-mode reliability patch for the hosted gateway and other non-Anthropic models. Ask the `plan` agent to plan something benign — *"plan a feature to add a verify-output button"* — on `altimate-backend/altimate-default` (GPT-5.x) and it could refuse outright with *"I'm sorry, but I cannot assist with that request."* This release fixes the refusal at its source, hardens the fix against prompt-injection, and rewrites a warning that was misdiagnosing the symptom.

### Fixed

- **Plan mode no longer refuses benign requests on `altimate-default` and other non-Anthropic models.** The root cause was *how* altimate-code delivers its own plan instructions: a `<system-reminder>`-wrapped block attached as user-role text. Claude is trained to read that tag as authoritative system guidance, but GPT-5.x, Gemini, and other non-Anthropic models pattern-matched the same block — carrying `STRICTLY FORBIDDEN` / `ZERO exceptions` / `MUST` language — as a **prompt-injection attempt** and declined, returning *"I'm sorry, but I cannot assist with that request."* for ordinary developer tasks. altimate-code now **hoists those self-injected reminders into proper `role:"system"` messages** for non-Anthropic models, so they arrive as instructions rather than suspect user input; Anthropic models are unchanged. The hoist is scoped by **provenance** to altimate-code's own reminder parts — user-supplied files, MCP-resource bodies, and `data:`-URL content can never gain system-role priority, even when they begin with `<system-reminder>`. Gateway models are routed by `model.family` (via a shared `familyVendor` classifier) so a Claude- or Gemini-backed gateway model lands on the right base prompt instead of an Anthropic-style fallback. (#887, #888)
- **The "plan agent used no tools" warning is accurate — and no longer false-fires.** Previously the warning blamed the model's *tool-use capability* (misleading — these models are fully tool-capable) and could fire on the final text-only step of a **successful** multi-step plan session, making a working session look broken. The trip-wire now scans the conversation history for prior tool calls, so a session that already explored the codebase isn't flagged. When it does fire, the copy describes the observed symptom only ("stopped without calling any tools"), lists the likely causes, and offers concrete recoveries — ask it to investigate first, rephrase, or, if it keeps refusing, `/model` to a tier more eager to explore. The plan agent is also now instructed to **read or search the codebase before drafting** any plan, with an explicit escape hatch for trivial, fully-specified changes. See [Plan mode](https://docs.altimate.sh/data-engineering/agent-modes/#plan) and [Troubleshooting](https://docs.altimate.sh/reference/troubleshooting/). (#888)

## [0.8.2] - 2026-06-03

A small correctness patch. The dbt PR reviewer's deterministic engine never required an altimate API key — but two tool descriptions said it did, which could push the reviewer into lint-only mode and send users chasing a key they don't need. This release corrects that and documents what "lint-only" actually means.

### Fixed

- **`dbt_pr_review` no longer implies it needs an altimate API key.** The native `altimate-core` engine behind the reviewer (column-lineage blast radius, query equivalence, PII classification, A–F grade) runs **fully offline** via the bundled napi binary — there is no `altimate_core.init` and no API-key gate in that path. Two tool descriptions (`altimate_core_column_lineage`, `altimate_core_track_lineage`) still carried a stale Python-bridge-era line claiming *"Requires `altimate_core.init()` with API key"*, so a stuck **lint-only** run was mis-diagnosed as missing auth. The descriptions now state the tools run offline with no key. **Lint-only actually means the dbt `manifest.json` didn't resolve** (wrong path, stale manifest, or wrong working directory) — the [dbt PR Review docs](https://docs.altimate.sh/usage/dbt-pr-review/) now spell out how to fix it. The only thing that ever needs a key is the optional advisory LLM lane, which can never block a verdict. (#882)

## [0.8.1] - 2026-06-02

A reliability + correctness patch on top of 0.8.0. Highlights: **8 new Snowflake Cortex models** (with a config escape-hatch so you never wait for a release again), a **trace-corruption fix** for long-running sessions, and a **behavior change to the dbt PR reviewer** — it now always posts a GitHub *comment* and never a formal *approval*.

### Added

- **Snowflake Cortex — 8 new selectable models.** Closes the drift between altimate-code's hardcoded Cortex model list and Snowflake's current regional-availability matrix: adds `claude-opus-4-7`, `openai-gpt-5.1`, `openai-gpt-5.2`, `llama4-scout`, `llama3.3-70b`, `snowflake-llama-3.1-405b`, `mixtral-8x7b`, and `gemini-3.1-pro` (Claude + OpenAI tool-capable; the rest chat-only, the conservative default until tool calling is verified on Cortex). When Cortex adds a model before the next release, you can now add it yourself under `provider["snowflake-cortex"].models` in `altimate-code.json` and it merges into the picker — no fork, no waiting. See [Snowflake Cortex provider docs](https://docs.altimate.sh/configure/providers/). (#866)

### Fixed

- **dbt PR reviewer never posts a formal GitHub *Approve* — behavior change.** The reviewer's `APPROVE` verdict now posts a GitHub **COMMENT** review event (the "approved — no findings" outcome is in the comment body), never a formal *Approve*. A review bot must not be able to satisfy branch protection / required reviews and let a PR merge without human sign-off (observed on a real PR where the bot had auto-approved). The no-formal-approval invariant is now enforced at compile time. **Migration:** to block merges, gate on the verdict **check** (`--mode gate`), not on requiring this bot as a reviewer — if your branch protection previously *required the altimate bot's approval*, remove that requirement or those merges will stay blocked. (#870, #872)
- **Trace corruption in long-running sessions.** Two concurrency bugs in the observability tracer are fixed: bursty turns (an LLM step firing many tool calls back-to-back) could drop the tail of a burst from the trace file when the process exited in the debounce gap (M2), and a crash during a large trace export could be overwritten by the in-flight export and show a stale terminal status instead of `crashed` (M3). Trace files now reliably reflect what actually happened, scoped per session in the shared TUI worker. (#865)

Headlined by **dbt PR Review** — a Cloudflare-style, dbt/SQL-specialized code reviewer that emits a single **signed** verdict (`APPROVE` / `COMMENT` / `REQUEST_CHANGES`) where every *blocking* finding is backed by a deterministic `altimate-core` engine call over parsed SQL ASTs, not a model's opinion. An optional LLM lane adds advisory context but can never block. This release also adds a **native Trino driver**, the opt-in **completion-gate validators**, and reliability/cost fixes. A five-persona pre-release review drove a security hardening pass on the new `reviewer` agent (see Security).

### Added

- **dbt PR Review — signed, deterministic verdicts on dbt pull requests.** New `altimate review` CLI command and a composite GitHub Action (`github/review`). The deterministic engine (column-lineage / DAG blast radius, query equivalence on before/after model SQL, PII classification, A–F grade + anti-pattern lint) is the **only** layer that can block; an optional LLM reviewer is clamped to ≤ warning and excluded from the gate, so a `REQUEST_CHANGES` is always provable and replayable. Runs in CI with **zero warehouse access** (consumes `dbt compile` artifacts), and the verdict is HMAC-signable and tamper-evident. `comment` mode never blocks; `gate` mode fails the check on `REQUEST_CHANGES`. The advisory model/credentials are configured on the Action (hosted `altimate_api_key`, or bring-your-own `model` + `model_api_key`); omit them to run deterministic-only. See [dbt PR Review docs](https://docs.altimate.sh/usage/dbt-pr-review/) and the copy-paste workflow in `github/review/examples/`. Depends on `@altimateai/altimate-core` ≥ 0.4.0. (#856)
- **Native Trino driver.** First-class Trino support over HTTP(S) with catalog/schema introspection and None / Basic / Bearer-token auth. **Migration note:** the dbt `trino` adapter previously mapped to the PostgreSQL driver; it now uses the native driver. Existing profiles are auto-aliased (`database` → `catalog`, `token` → `access_token`) and otherwise compatible. `trino-client` is an optional dependency — install it (`npm install trino-client`) to use Trino. (#795)
- **Completion-gate validator framework.** A new opt-in harness-side check
  that runs after the LLM declares `finish === "stop"`. Two built-in
  validators for dbt projects: `dbt-tests-pass` (runs `altimate-dbt test`
  against modified models) and `dbt-schema-verify` (runs `altimate-dbt
  schema-verify` against modified models). On failure, the framework
  injects a synthetic user turn so the agent gets one more chance to fix
  the issue, bounded by a per-session retry budget. Two opt-in modes:
  `ALTIMATE_VALIDATORS_ENABLED=1` (enforcement + retries) and
  `ALTIMATE_VALIDATORS_SHADOW=1` (telemetry-only — measure "would have
  caught" rates without blocking). Default is **off** with zero overhead.
  Two new telemetry events (`validator_check`, `validator_retries_exhausted`).
  Configuration via `ALTIMATE_VALIDATORS_{MAX_RETRIES,TIMEOUT_MS,CONCURRENCY,DEBUG}`.
  See [Validators docs](https://docs.altimate.sh/data-engineering/validators/)
  for the full reference, performance characteristics, and the phased
  rollout plan. (#849)

### Fixed

- **`cancel()` race / idle-on-clean-exit.** A cancel arriving during normal loop teardown could leave a session without a `session.status:idle` event, leaving callers waiting on idle stuck. Idle is now emitted correctly on both the abort and clean-exit paths. (#845)
- **Prompt caching on the `altimate-backend` provider.** Enabled the `cache_control` trigger for the hosted provider so the litellm Anthropic fallback caches repeated prompt prefixes — cheaper and faster repeat turns (no-op on providers that ignore the marker). (#850)

### Security

- **`reviewer` agent hardened to deny bash.** The v0.8.0 pre-release review found that the new `reviewer` agent — advertised as "read-only" — had a bash allowlist (`git log *`, `cat *`, `ls *`) that was bypassable: shell redirects rode *inside* a matched command (`git log -p > ~/.ssh/authorized_keys` was allowed) and `cat *` could read arbitrary files (e.g. `~/.altimate/altimate.json`) and exfiltrate them through the PR comment the agent posts. Bash is now **denied** for the reviewer (it uses the structured `read`/`grep`/`glob` tools + the verdict engine, which does its own diffing); the agent description was corrected; and the reviewer prompt now treats PR content as untrusted input. The CI Action path was never affected — its LLM lane runs with no tools. (#856)

## [0.7.3] - 2026-05-24

A telemetry-driven hardening release. Five P0 fixes merged from a `telemetry-analysis-2026-05-21` pass — every one tied to a measured failure number from the App Insights pipeline. The headline wins are user-visible: `finops_*` tools now work without an explicit `warehouse=` parameter (auto-pick the first compatible connection); `project_scan` no longer crashes on hosts where `git` isn't in PATH (the silent 437-user regression was masked by the PII filter collapsing the binary name to `?` in error messages); and `webfetch` caches 404/410/451 responses for up to 30 minutes so the agent stops re-asking dead URLs. Two telemetry-only fixes (build-agent name normalization, Anthropic token-count semantics) clean up dashboard mis-bucketing without changing user-visible behavior.

A five-persona pre-release review drove a second hardening pass: HTTPS basic-auth credentials are now stripped from `git remote get-url origin` output before it reaches LLM-visible metadata or session transcripts; raw `git` stderr is routed through `Telemetry.maskString` to redact embedded emails and bearer tokens; `normalizeAgentName` gained C0 control-char stripping + NFKC normalization + a 64-char cap to neutralize log-injection and homoglyph-bucket attacks via custom agent configs; the webfetch failure cache now also drops auth-bearing query params (`token`, `api_key`, `signature`, `x-amz-signature`, etc.) from the cache key so presigned-URL secrets can't sit in an in-memory `Map` for 30 minutes; cache-hit error messages are prefixed with `(cached failure, Nm ago)` so an agent debugging a fast failure can tell cache vs. live network apart; and 34 adversarial tests pin every one of these regression classes plus the `warehouse_filter` / `warehouse` parameter disambiguation that caused LLM confusion.

### Dashboard query change

`tokens_input_total` is now **always** emitted on `generation` telemetry events (previously omitted when zero/null). Dashboards reading `tokens_input` to compute volume will under-report on Anthropic-cache-hit sessions — switch any "total input tokens consumed" queries to `tokens_input_total`. The old `tokens_input` field is preserved and reports uncached input tokens (clamped at zero so inconsistent provider counts can't produce negative cost). The two fields satisfy the invariant `tokens_input + tokens_cache_read + tokens_cache_write === tokens_input_total`.

### Fixed

- **`finops_*` tools auto-pick a warehouse when omitted.** All six finops tools (`finops_analyze_credits`, `finops_expensive_queries`, `finops_query_history`, `finops_role_*`, `finops_unused_resources`, `finops_warehouse_advice`) previously required an explicit `warehouse=<connection-name>` argument. Telemetry showed them at a 100% error rate because the LLM consistently guessed unconfigured warehouse names and got dead-end "Credit analysis is not available for unknown warehouses" errors with no enumeration of what *was* configured. The new `resolveFinopsWarehouse` helper centralizes resolution: if no warehouse is requested, it auto-picks the first configured connection whose driver type supports the operation (`snowflake` / `bigquery` / `databricks` for credit/sizing/usage tools; broader for query history; Snowflake-only for role-hierarchy). Errors now enumerate configured warehouse names and point at `warehouse_add` when nothing is configured. Trim is applied on the requested name (LLM whitespace edge cases) and type matching is case-insensitive (`"Snowflake"` / `"snowflake"` / `"SNOWFLAKE"` resolve identically). (#828, closes #827)
- **`project_scan` no longer crashes when `git` is missing from PATH.** Telemetry showed a 32% failure rate across 437 users with the masked error `"Executable not found in $PATH: ?"` — the binary name was being collapsed to `?` by the PII filter, hiding the real cause for two months. `Bun.spawnSync` *throws* when a binary isn't found (not just non-zero exit), and `project_scan` was running the throw unguarded. The new `safeSpawnSync` wrapper catches it cleanly and returns `null`, and `detectGit` distinguishes three states via `GitInfo.gitAvailable` + `gitError`: `git missing` (binary not in PATH — surface install hint), `git present but degraded` (non-128 exit code — corrupted `.git`, permission denied; surfaces exit code + masked stderr), and `git present, not a repo` (clean exit 128 — render "Not a git repository"). The `metadata.degraded` array always emits even when empty, sorted and deduplicated, so dashboard queries never have to null-coalesce. (#831, closes #830)
- **Build agent telemetry no longer reports 0% completion.** A rename from `"build"` → `"builder"` in the agent registry left three writer sites still emitting the legacy name: the TUI sent `agent: "build"` on session start, the plan-exit synthetic message wrote `lastUser.agent = "build"`, and the `agent_outcome` event read from that. The agent execution alias at `Agent.get()` masked the issue at runtime, but every dashboard saw a phantom `"build"` bucket with 0% completion alongside the real `"builder"` bucket. The new `normalizeAgentName` helper is the single source of truth — used by both `session_start` and `agent_outcome` emits so they can never drift, case-insensitive against the legacy name, plus C0-control-char strip + NFKC + 64-char cap so a malicious or hand-edited config can't inject newlines into App Insights or create a cardinality bomb. The TUI and plan tool now write `"builder"` directly. (#833, closes #832)
- **Anthropic `tokens_input` is no longer always 0 in telemetry.** `Session.getUsage` previously assumed OpenAI-style accounting (where `inputTokens` is the inclusive total including cached) — but Anthropic returns `inputTokens` exclusive of cached, so the subtraction `inputTokens - cacheRead - cacheWrite` produced 0 (or negative) on every cache-hit session. The new branch tests `metadata.anthropic || metadata.bedrock` and skips the subtraction for those providers. `tokens_input_total` is now always emitted as the inclusive total (so dashboards have a clean denominator), and `tokens.input` is clamped at zero — inconsistent provider counts (e.g. `inputTokens=1000, cachedInputTokens=2000`) can no longer leak negative cost into App Insights or session totals. Venice metadata path (`metadata.venice.usage.cacheCreationInputTokens`) is now covered with the same treatment as Anthropic/Bedrock. (#837, closes #836)
- **`webfetch` failure cache now persists known-bad URLs for 30 minutes (5 min for 451) and collapses LLM-generated URL variations.** Telemetry showed 486 residual webfetch 404 retries across the 14-day window (down from March's 2,222 but still meaningful) — the LLM kept fetching the same dead URL with different tracking parameters, fragments, and case variations and getting fresh 404s each time. The cache key is now the *normalized* URL: tracking params (`utm_*`, `fbclid`, `gclid`, `mc_*`, `_ga`, `_gl`, `igshid`, `mibextid`, HubSpot `_hsenc`/`_hsmi`, Marketo `mkt_tok`, Adobe `s_cid`/`s_kwcid`, Piwik/Matomo `pk_*`/`piwik_*`, `__cf_chl_*`) are stripped, query params are sorted by (key, value), the host is lowercased, the fragment is dropped, and HTTPS basic-auth userinfo (`user:pass@`) is removed. The functional `ref` param is deliberately *preserved* (GitHub raw URLs and git APIs use it to select branches/tags). Auth-bearing query params (`token`, `access_token`, `api_key`, `apikey`, `signature`, `sig`, `x-amz-signature`, `x-amz-credential`, `x-amz-security-token`, `x-goog-signature`, `x-goog-credential`) are dropped from the **cache key only** — the actual `fetch()` still uses the raw URL — so an S3 presigned URL that 404s doesn't leak its signature into the in-memory `Map` for 30 minutes. 451 uses a shorter 5-min TTL because it's observer-conditional (VPN swap unblocks). Cache-hit errors now prefix with `(cached failure, Nm ago)` so an agent debugging a fast failure can tell cache vs. live network apart. LRU re-touch on repeated failures via `delete-then-set` so a frequently-failing URL doesn't sit at the head of the FIFO and get evicted first under pressure (cache size cap is 500). (#839, closes #838)

### Privacy & Security (pre-release hardening pass)

- **`git remote get-url origin` output is now credential-stripped before it reaches LLM-visible metadata or session transcripts.** Pre-fix, `metadata.git.remoteUrl` shipped the URL verbatim — including embedded HTTPS basic-auth like `https://x-access-token:ghp_xxx@github.com/...` or `https://user:pass@gitlab.internal/...` — which then flowed to the LLM provider on every `project_scan` call and was preserved in the session transcript. The new `stripGitRemoteCredentials` helper sets `username` and `password` to empty on parseable URLs, preserves SSH-form remotes (`git@github.com:owner/repo.git` has no userinfo concept), and drops unparseable URLs entirely rather than risk leaking embedded creds. Flagged by the v0.7.3 compliance/chaos review.
- **`gitError.stderr` is masked via `Telemetry.maskString` before persisting.** Git stderr on auth failures and bad-object errors contains embedded HTTPS remote URLs (with userinfo), commit emails, and `/Users/<realname>/` paths. The masker (already redacting `sk-`, `Bearer`, and `<email>` in error strings elsewhere) now runs before the stderr is sliced to 240 chars and assigned to `metadata.git.gitError.stderr`. Mask-before-slice order is pinned by adversarial test so a refactor can't reorder them and surface a half-redacted email.
- **`normalizeAgentName` hardens against adversarial input.** Strips C0 control characters (`\x00-\x1f` + DEL) — a custom-agent config with `name: "x\nfake_event=hello"` would have split App Insights into two events; NFKC-normalizes so fullwidth/homoglyph agent names (`"ｂｕｉｌｄｅｒ"`) don't create separate telemetry buckets; caps length at 64 chars because agent names are slugs and anything larger is a cardinality bomb. Three new pinning tests guarantee each invariant.

### Changed

- **`warehouse_filter` parameter description disambiguated from `warehouse`.** With `warehouse` now optional, the previous description ("Filter to a specific Snowflake warehouse") was ambiguous next to the connection-name `warehouse` parameter. New description: "Filter result rows by an in-warehouse Snowflake compute name (NOT the connection name). Distinct from `warehouse`: `warehouse` picks which connection to query; `warehouse_filter` narrows which Snowflake virtual warehouse's queries are returned in the result set. Snowflake only." Applied to both `finops_analyze_credits` and `finops_query_history`. End-user persona flagged the LLM-confusion risk during pre-release review.
- **`DEFAULT_FINOPS_TYPES` is the canonical "supported by any cloud warehouse" type list.** Pre-fix, three handlers (`credit-analyzer`, `unused-resources`, `warehouse-advisor`) each declared the same `["snowflake", "bigquery", "databricks"]` literal as a local `const`. Now exported from `warehouse-resolver.ts`; adding a fourth driver (e.g. Redshift `account_usage`) is one edit, not three.
- **`docs/docs/data-engineering/tools/finops-tools.md` updated for the auto-pick behavior.** Pre-fix, the doc said `warehouse (required): Connection name` — directly contradicting the v0.7.3 code. Now lists `warehouse` as optional with the auto-pick semantics, includes a top-of-file `v0.7.3+` note about the change, and shows the bare (no-warehouse) invocation form in at least one example. PM persona flagged the doc/code drift as P0 pre-release.

### Testing

- **34 adversarial tests** in `release-v0.7.3-adversarial.test.ts` pin the regression classes:
  - **finops auto-pick** — code/doc/tool-description alignment (no `warehouse (required)` left in docs; "Optional" appears in tool descriptions; `warehouse_filter` description disambiguates from `warehouse`; `DEFAULT_FINOPS_TYPES` is single source of truth; resolver trims whitespace; resolver auto-picks on empty/undefined/whitespace).
  - **project_scan privacy** — `stripGitRemoteCredentials` present + sets `username`/`password` empty; `gitError.stderr` runs through `Telemetry.maskString`; mask-before-slice order; `safeSpawnSync` returns null on missing binary; `GitInfo.gitAvailable` + `gitError` distinguish three states; output line distinguishes "binary missing" from "not a repo".
  - **normalizeAgentName** — single declaration site (single source of truth); case-folds before "build" compare; strips C0 control chars; NFKC-normalizes; length-caps at 64; both `session_start` and `agent_outcome` route through the helper.
  - **webfetch cache key** — `AUTH_PARAMS_FOR_CACHE_KEY` enumerates `token`/`access_token`/`api_key`/`apikey`/`signature`/`sig`/`x-amz-signature`/`x-amz-credential`/`x-goog-signature`; presigned-S3 URLs with different signatures collapse; api_key/token variants all collapse; functional params (`page`, `q`) are NOT stripped; auth-param strip is case-insensitive; cache-hit error prefix wording is distinguishable; `isUrlCachedFailure` exposes `ageMs`; 451 has shorter TTL than 404/410.
  - **URL normalization privacy invariants** — userinfo stripped from cache key; utm/fbclid/mc_ tracking collapses; normalization is idempotent; invalid URL passes through verbatim.
  - **CHANGELOG presence** — release-skill backstop that catches a release commit without a 0.7.3 entry + all 5 merged PR numbers referenced.

### Deferred to follow-up issues

- [#840](https://github.com/AltimateAI/altimate-code/issues/840) Surface auto-picked warehouse name in `finops_*` tool output (currently `autoPicked: true` is computed but not rendered).
- [#841](https://github.com/AltimateAI/altimate-code/issues/841) Audit: webfetch failure cache crosses logical sessions in `altimate serve` daemon mode.
- [#842](https://github.com/AltimateAI/altimate-code/issues/842) Route the three compaction-summary `lastUser.agent` writes through `normalizeAgentName` (currently only the emit boundary is normalized; persisted state can still record legacy `"build"`).
- [#843](https://github.com/AltimateAI/altimate-code/issues/843) Audit: cost telemetry retention + re-identification policy (`tokens_input_total` + `cost` are now always emitted per generation event; document TTL and TOS alignment).

## [0.7.2] - 2026-05-21

A focused hotfix for v0.7.1's broken install endpoint plus a defensive pass on the upgrade fetch surface. v0.7.1 documented and embedded `https://altimate.ai/install` in the curl install path and in `altimate upgrade`'s in-place upgrader — that host is the marketing-site SPA and returns an HTML 404 for `/install`, so every curl install and every curl-installed user's `altimate upgrade` silently failed end-to-end. v0.7.2 swaps the host to `https://www.altimate.sh/install` (apex `altimate.sh` is still not routed to the Amplify Next.js app — tracked separately, drop the `www.` once apex DNS is fixed), wraps the upgrader fetch with a 15s bounded timeout, replaces the raw `AbortError: The operation was aborted` with an actionable error that names the URL, prints the manual re-install one-liner, and points at the GitHub releases fallback. Realigns the published GitHub Action (`github/action.yml`) with the v0.7.1 binary rename (`altimate-code` → `altimate`) and new install directory (`~/.altimate/bin`) — pre-fix, every Action consumer hit the broken URL on cache miss and then a missing binary even if the URL had worked. 30 adversarial tests pin the regression classes (URL eradication, cross-file host consistency, named-constant invariants, error-surface invariants, action.yml alignment, marker integrity, migration recovery surface, CHANGELOG presence).

**If you installed v0.7.1 via curl, your `altimate upgrade` will still fail until you re-install manually once:**

```bash
curl -fsSL https://www.altimate.sh/install | bash
```

After that, v0.7.2 and forward self-heal.

### Fixed

- **`Installation.upgradeCurl()` now fetches from `https://www.altimate.sh/install` instead of the unreachable `https://altimate.ai/install`.** v0.7.1 had pointed the in-place upgrader at the marketing site, which routes everything through a React Router SPA — `/install` rendered an HTML 404 page, the upgrader's `fetch` succeeded with a 200, the response body was the 404 HTML, and `bash` either executed the HTML and failed cryptically or hung mid-stream. The matching curl install one-liner in `install --help`, `README.md`, and `docs/docs/reference/troubleshooting.md` (three references) was broken the same way. www.altimate.sh now serves the install script via a Next.js route handler with `Content-Type: text/x-shellscript`. (#825, closes #309)
- **Published GitHub Action (`github/action.yml`) realigned with the v0.7.1 binary rename.** v0.7.1 renamed the curl-installed binary `altimate-code` → `altimate` and moved the install directory `~/.altimate-code/bin` → `~/.altimate/bin`, but the Action's cache `path:`, `$GITHUB_PATH` addition, and final `run:` step still referenced the legacy `altimate-code` name and path. Combined with the broken install URL, every Action consumer hit a 404 on cache miss followed by an empty `$PATH` and a `altimate-code: command not found` even after the install "succeeded". All four references updated in lockstep.
- **`altimate upgrade` (curl method) no longer hangs indefinitely on a stalled CDN/origin.** The fetch is bounded by `AbortSignal.timeout(UPGRADE_FETCH_TIMEOUT_MS)` (15s) so a TLS-rewriting corporate proxy, a hung CloudFront edge, or a slow-loris-style stall fails fast instead of blocking the user's terminal for minutes. Surfaced via CodeRabbit review on #825.

### Changed

- **Curl-upgrade fetch failures now surface an actionable error instead of `AbortError: The operation was aborted`.** Pre-fix, a timeout, a 404, a DNS failure, or a connection refused would propagate as `DOMException: The operation was aborted` (timeout) or `Error: Not Found` (HTTP non-2xx) — neither named the URL, the recovery path, or the fallback. The fetch is now wrapped in `try/catch` and the rethrown error reads: `"Could not download install script from https://www.altimate.sh/install: <cause>. Re-run the install manually: curl -fsSL https://www.altimate.sh/install | bash — or download a release binary directly from https://github.com/AltimateAI/altimate-code/releases/latest"`. HTTP non-2xx now also includes the numeric status (`HTTP 404 Not Found` instead of just `Not Found`).
- **`UPGRADE_INSTALL_URL` and `UPGRADE_FETCH_TIMEOUT_MS` extracted as named constants** inside the `altimate_change` block in `packages/opencode/src/installation/index.ts`. Pre-fix, the URL and timeout were duplicated string + literal across the source and the test assertion. A future timeout tune (15s → 20s) would have required three coordinated edits; now it's one. The adversarial test asserts the existence of the named constant separately from the literal value so the regression guard isn't brittle to constant extraction itself.
- **`altimate_change` marker block in `installation/index.ts` extended.** The v0.7.1 release did not mark the line where `upgradeCurl()` fetches the install script; v0.7.2 wraps the URL + timeout constants and the entire fetch+wrap block in a single marker pair so the next upstream bridge merge sees the intent and doesn't silently revert the URL or strip the timeout.

### Testing

- 30 adversarial tests in `release-v0.7.2-adversarial.test.ts` pinning the v0.7.2 surface:
  - **URL eradication** — 5 surfaces (`installation/index.ts`, `install`, `README.md`, `troubleshooting.md`, `github/action.yml`) each negative-asserted to not contain `altimate.ai/install`. The intentional `altimate.ai/discord` link in `docs/mkdocs.yml` is positively asserted as still present (different path, marketing-site contact info, intentionally out of scope).
  - **Cross-file host consistency** — the host used in the source `UPGRADE_INSTALL_URL` is automatically compared against every other reference in README, troubleshooting docs, install script, and action.yml. A future "drop the www." that updates the source but misses README will fail loudly.
  - **`install --help` examples** — both examples in the `--help` block asserted (a previous half-fix had updated only the first); negative assertion against the legacy host on the help block specifically.
  - **Bounded timeout** — `AbortSignal.timeout(` is wired, `UPGRADE_FETCH_TIMEOUT_MS = 15_000` is a named constant, the fetch references the constant by name, and a raw `AbortSignal.timeout(15_000)` literal is forbidden (would mean someone reverted the constant extraction).
  - **Error surface** — the fetch lives inside a try/catch, the rethrown error message names the URL, includes the manual re-install one-liner with the URL templated through the constant, points at the GitHub releases fallback, and surfaces HTTP status codes (`HTTP ${res.status} ${res.statusText}`).
  - **`github/action.yml` alignment** — install URL, cache path, `$GITHUB_PATH` addition, and final binary invocation all match the v0.7.1 rename; negative assertions against every legacy form. Action file existence asserted at `github/action.yml` (not `.github/action.yml`) since moving it would silently break every downstream consumer.
  - **Marker integrity** — URL/timeout constants live inside an `altimate_change` block; try/catch wrapper lives inside an `altimate_change` block; balanced start/end count across the file.
  - **Migration recovery surface** — troubleshooting doc still has the install-path section with the new URL; README curl one-liner matches the source's `UPGRADE_INSTALL_URL` host.
  - **CHANGELOG presence** — release-skill backstop that catches a release commit without a 0.7.2 entry.

## [0.7.1] - 2026-05-20

A focused provider-error pass plus the standalone-binary fix: the curl-installed binary now starts (previously crashed with `Cannot find module '@altimateai/altimate-core'`), is renamed to match the npm primary `bin` (`altimate-code` → `altimate` for the curl path only), and Alpine + Windows-on-ARM hit a clear early-exit instead of a cryptic gzip failure. Two 5-persona pre-release reviews (provider-error pass, then binary-fix + rename pass) drove the surface — 86 adversarial tests total pin the regression classes.

### Fixed

- **Curl-installed standalone binary no longer crashes with `Cannot find module '@altimateai/altimate-core'` on first run.** The `script/build.ts` marked altimate-core as `external` (NAPI native modules can't live inside Bun's single-file bunfs), and the release archive shipped only the raw Bun binary — no companion `node_modules`, no NODE_PATH-aware wrapper. CI smoke tests hid the bug by pre-setting NODE_PATH against the developer checkout before invoking the binary. The fix stages a per-target copy of altimate-core whose loader is rewritten to a one-line shim `module.exports = require('./altimate-core.<platform>.node')`, drops the matching `.node` file next to it, and uses a `Bun.build` `onResolve` plugin to redirect every `@altimateai/altimate-core` import to that shim. Bun statically sees a single require and embeds that one `.node` into bunfs. Result: ~176 MB self-contained binary, no companion files, no NODE_PATH dance. CI smoke tests now run with `NODE_PATH` cleared from `$RUNNER_TEMP`, plus an independent `strings`-based content assertion that exactly one platform `.node` is embedded — the v0.5.10 / v0.7.0 class of regression is pinned by three independent guards. (#820)
- **Alpine Linux (musl) and Windows on ARM64 install paths now fail fast with actionable messages instead of silent 404 → tar/unzip errors.** Pre-fix, `curl … | bash` on an unsupported target would write GitHub's 404 HTML to disk and die "not in gzip format". The curl `install` script, the npm bin wrapper (`packages/opencode/bin/altimate`), the npm `postinstall.mjs`, and `script/build.ts` all detect these platforms early and point to `apk add gcompat` (Alpine) or x64 emulation / WSL (Windows ARM). The musl-detection logic is also `pipefail`-safe (`ldd --version` exits non-zero on musl by design; the previous pipeline-form inherited that failure and silently missed every non-Alpine musl distro). (#820)
- **Curl install `--fail` on both download paths.** A 404 / WAF block / TLS-rewriting corporate proxy no longer writes the error page to disk and gets unzipped as a binary; `curl --fail` exits non-zero and the install bails cleanly. (#820)
- **`script/build.ts --target-index=N` for an out-of-range index exits non-zero.** Pre-fix, after the musl/win32-arm64 cull, an invalid index silently produced zero artifacts and CI "succeeded" with no binary. (#820)
- **`script/build.ts --single` on a musl-linux host refuses to build the unrunnable glibc target.** Pre-fix the build would succeed but the resulting binary couldn't load on the host. (#820)
- **`Installation.method()` recognises `~/.altimate/bin` as a curl install.** The same release that renames the curl-install dir would have broken `altimate upgrade` for curl-installed users without this; the `.opencode/bin` and `.local/bin` branches stay for back-compat. (#820)
- **Provider 4xx errors now show the inner error message instead of a raw JSON dump.** When any provider returned the standard `{error: {message, type, code}}` shape (OpenAI, Azure OpenAI, OpenRouter, etc.), `parseAPICallError`'s extraction chain short-circuited on the truthy parent `error` object, the `typeof errMsg === "string"` guard rejected it, and the parser fell through to dumping the raw response body — which appeared as `APIError: Bad Request: {?:?}` after telemetry redaction collapsed string values to `?`. Telemetry caught users retrying broken model selections 3+ times in the same session because the surfaced error gave no clue about the cause. Users now see actionable text such as `APIError: Bad Request: The model 'gpt-5-codex' does not exist or you do not have access to it.` The OR-chain is replaced with explicit-typeof ternaries that mirror `parseStreamError`'s pattern, so a truthy non-string at any tier cannot block a valid string further down the chain. (#789, closes #788)
- **Bedrock / AWS Lambda `errorMessage` shape is now extracted.** AWS APIs that return `{errorMessage: "...", errorType: "..."}` (Lambda style) previously fell through the OpenAI/Anthropic-shaped chain to a raw-body dump. Added `body.errorMessage` to the extraction ladder in both `parseAPICallError` and `parseStreamError`.
- **Streaming error path no longer dumps `Unknown: {"type":"error",...}` for non-OpenAI codes.** `parseStreamError` previously handled only 4 OpenAI error codes (`context_length_exceeded`, `insufficient_quota`, `usage_not_included`, `invalid_prompt`); everything else fell through to `JSON.stringify(e)`. Added a default fallback that runs the same string-typeof chain as `parseAPICallError`, so any extractable provider message becomes a clean api_error.
- **`model_not_found` no longer triggers a silent retry storm.** OpenAI 404s are forced retryable in general (some legitimate models 404 transiently), but `error.code === "model_not_found"` now short-circuits to `isRetryable: false` — the user sees the actionable error on attempt 1 instead of after 5 silent retries.

### Added

- **`altimate models` discoverability hint on model-not-found errors.** When `error.code === "model_not_found"`, the surfaced message now ends with `Run \`altimate models\` to see available models.` so the next step is one command away.
- **Provider-API-Errors troubleshooting reference** at `docs/docs/reference/troubleshooting.md` covering model-not-found, unauthorized, rate-limited, context-overflow, and HTML-page error classes.
- **Install-path troubleshooting section** at `docs/docs/reference/troubleshooting.md` covering "standalone binary not found after curl install" (the `altimate-code` → `altimate` rename), the legacy `Cannot find module '@altimateai/altimate-core'` crash with recovery instructions, Alpine/musl unsupported (with `apk add gcompat` workaround), and Windows-on-ARM unsupported (with WSL workaround). README also documents the curl-install option alongside the npm one.

### Changed

- **Curl-installed binary renamed `altimate-code` → `altimate`** to match the npm package's primary `bin` entry. The npm path continues to expose **both** `altimate` and `altimate-code`, so existing `npm install -g`/`pnpm i -g` users see no behavioural change. Homebrew installs are unchanged (the formula installs `altimate` and symlinks `altimate-code` for back-compat). Only the standalone (`curl … | bash`) channel is affected — it now ships a single self-contained `altimate` binary to `~/.altimate/bin/` (was `~/.altimate-code/bin/altimate-code`). CI users with scripts that called `altimate-code` after the curl install should switch to `altimate` or install via npm. The install script removes any stale `~/.altimate/bin/altimate-code` left over from a pre-v0.7.1 install. (#820)
- **`check_version` probes both `altimate` and `altimate-code` on PATH** so an upgrade from v0.7.0 doesn't always re-download even when the version already matches. (#820)
- **Curl install final banner mirrors the npm postinstall**: `altimate`, `altimate run "hello"`, `altimate --help`, and the same `https://altimate-code.dev` docs URL. Rosetta-detected x64 → arm64 swap now emits a one-line muted notice instead of being silent. (#820)
- **`Installation.method()` upgrade detection recognises `~/.altimate/bin`** as a curl install (in addition to the legacy `~/.opencode/bin` and `~/.local/bin` paths). (#820)
- **`_requiredExports` literal extracted from `@altimateai/altimate-core/index.js` is JSON.parsed and shape-checked** before being inlined into the per-target staged shim. Pre-fix, the regex match group was inlined verbatim — a malicious altimate-core that published an `index.js` whose `_requiredExports = ["x"]; <attacker JS>; const _foo = [` form would have embedded attacker JavaScript into every shipped binary. The validator now requires a pure JSON array of non-empty short string literals; anything else aborts the build. (#820)
- **`build.ts` asserts the on-disk `@altimateai/altimate-core` version matches `package.json` declaration** after `bun install --os=* --cpu=*`. Catches the stale-hoist scenario where a previous version lingers in `node_modules/.bun/` and the new build silently embeds yesterday's `.node`. (#820)
- **Per-target staging dir is wiped before each build** (pre-loop cleanup), not just after, so a previous build that crashed between staging and post-build cleanup can never leak a stale `.altimate-core-staged/` into the next build's resolution. (#820)
- **Curl install extracts only the expected binary member** from tar/zip archives (`tar --no-same-owner -xzf … "$binary_name"` / `unzip … "$binary_name"`), so a future build mistake that tars a directory of attacker-controlled paths can't write them outside the explicit member. (#820)
- **`install_from_binary` guards against cp-on-self**: `--binary ~/.altimate/bin/altimate` no longer truncates the destination to empty via POSIX `cp` semantics. (#820)
- **Build matrix and standalone install matrix now align** — only platforms with a published `@altimateai/altimate-core` NAPI prebuild produce a release archive. (#820)

### Removed

- **`linux-arm64-musl`, `linux-x64-musl`, `linux-x64-baseline-musl`, and `win32-arm64` archives** from the release build matrix. `@altimateai/altimate-core` has no NAPI prebuild for these targets; archives for them were never going to work. The npm wrapper (`bin/altimate`) and npm `postinstall.mjs` hard-error on these platforms with the same `apk add gcompat` / WSL workarounds the curl-install script uses. Re-added when upstream prebuilds ship. (#820)

### Privacy

- **`Telemetry.maskString` now redacts email addresses and internal hostnames.** Pre-fix, the JSON-quote masking rule incidentally collapsed everything inside provider error JSON to `?`. The provider-error fix unwraps that JSON, which means provider-side identifiers (caller emails, internal `*.local` / `*.internal` / RFC1918 / IPv6 loopback / ULA / link-local / AWS IMDS endpoints) now flow as plain English. Added explicit redaction patterns so they're masked before reaching telemetry, the share backend, or local session storage. The masker is kept in sync with `parseAPICallError`'s `maskInternalHost` (same internal-endpoint coverage); query-string and fragment characters (`+`, `#`, `,`, `;`) are inside the trailing char class so secrets past the `<internal-host>` marker don't survive. `sk-…` and `Bearer …` token redaction is unchanged.
- **`metadata.url` on `MessageV2.APIError` masks internal hosts and strips basic-auth userinfo.** When `error.url` points at `localhost`, `*.local`, `*.internal`, an RFC1918 IPv4, IPv6 loopback / ULA / link-local, or the AWS IMDS address (`169.254.169.254`), the host is rewritten to `internal-host.redacted` before the URL lands on the parsed error. Basic-auth userinfo (`user:pass@…`) is stripped on **every** URL — internal or public — since a credential in a public-host URL is at least as risky as one in an internal proxy. Public-host URLs are otherwise preserved verbatim for debugging.
- **`responseBody` is capped at 4KB** at the `parseAPICallError` boundary. Without this, a hostile or verbose gateway could persist a 100KB+ body into local storage and (for shared sessions) the share backend.

### Testing

- 46 adversarial tests covering JSON-scalar bodies, prototype-pollution attempts, 100KB error messages, malformed JSON, every-tier null/numeric extraction, Bedrock `errorMessage` precedence, the `parseStreamError` fallback for unknown codes, the `model_not_found` retry-storm carve-out, the `altimate models` hint, the responseBody cap, the metadata.url internal-host masking (incl. IPv6 loopback/ULA/link-local, AWS IMDS, public-host basic-auth userinfo strip, RFC1918 boundary checks, lookalike-hostname guards), and the new email / internal-host `maskString` patterns (incl. IMDS, IPv6, and query-fragment leak guards).
- 48 adversarial tests in `release-v0.7.1-binary-adversarial.test.ts` pinning the binary-fix + rename surface — install-method upgrade-path detection (`.altimate`/`.opencode`/`.local` triple-cover), curl-install hardening (Rosetta notice, cp-on-self guard, stale `altimate-code` cleanup, explicit tar/zip member extraction, dual `check_version` probe, musl + npm gcompat messaging, `--fail` on both curl paths, `pipefail`-safe ldd capture, no musl target-suffix construction), `_requiredExports` JSON.parse + shape-check rejection, altimate-core version pinning + actionable rebuild hint, staging-dir pre-loop wipe + post-build cleanup, empty-targets and musl-host build guards, build matrix excluding linux-musl + win32-arm64, smoke-test hermeticity (host-platform `findLocalBinary` filter + tmpdir cwd + content-level `strings` assertion), npm-wrapper + postinstall fail-fast parity for musl + win32-arm64, troubleshooting and README doc surface, archive-name + bin-rename cross-file invariants, and `release.yml` hermetic CI smoke tests + narrowed `publish-npm` permissions. Tests run together with the provider-error suite as the release-critical gate (`test/branding/ test/install/ test/skill/release-v0.7.1*`).
- Smoke tests (`test/install/smoke-test-binary.test.ts`) gained: hermetic `NODE_PATH`-cleared invocation from a fresh tmpdir (so Bun's compiled binary cannot walk the worktree for `node_modules`), and a content-level `strings`-based assertion that exactly one platform `.node` is embedded in the compiled binary — independent of any runtime resolution path, so a silent `onResolve` regression that embeds 5 platforms' worth of `.node` files would fire here even if the runtime test passes by accident. (#820)

## [0.7.0] - 2026-05-03

### Changed

- **Bridged to OpenCode upstream v1.4.0 across a history rewrite.** Upstream rewrote git history between v1.3.17 and v1.4.0 (2026-04-04), leaving zero common ancestor with our fork. A new `script/upstream/bridge-merge.ts` tool overlays v1.4.0's tree file-by-file: take v1.4.0's content for unmarked upstream-shared files, keep main's version entirely for files carrying `altimate_change` markers (61 files), keep `keepOurs` files unchanged (65 files), and drop excluded `skipFiles` (3676 files). PR #18186 (Anthropic provider exclusion handling) is reapplied programmatically. Net diff vs v0.6.1: 361 files, +88,823 / -34,416 LoC. The merge passed nine adversarial audit cycles and ships a 234-test bridge-merge regression suite plus 76-test E2E suite that fails CI loudly on every regression class we hit. (#757)
- **Pinned the dependency floor for the bridge merge.** Added overrides for `effect@4.0.0-beta.43`, `@effect/platform-node@4.0.0-beta.43`, and `@effect/platform-node-shared@4.0.0-beta.43` (beta.58 removed `ServiceMap` in favor of `Context`). Held back `@ai-sdk/*`, `@openrouter/ai-sdk-provider`, and `@opentui/*` from upstream's bumps. Restored upstream's `solid-js@1.9.10` patchedDependencies declaration (Solid Transition correctness, issue #2046).

### Added

- **`--dangerously-skip-permissions` flag on `altimate run`** (upstream PR #21266 backport). Aliased to our existing `--yolo` / `ALTIMATE_CLI_YOLO` branch. Strictly safer than upstream's version: `--yolo` honors explicit `deny` rules in session config, upstream's auto-approves anything not denied with no notion of deny rules. Documented in `docs/docs/usage/cli.md`.
- **`variant_list` TUI keybind** (upstream PR #21185 backport). Opens the "Switch model variant" dialog (`/variants`); hidden when no variants are configured. Schema entry in `config.ts`; documented in `docs/docs/configure/keybinds.md`.
- **Plain-text rate-limit retry detection** (upstream PR #21355 backport). `session/retry.ts` now retries Alibaba/DashScope and other providers that return non-JSON 429 responses.
- **Telemetry diagnostic fields on `agent_outcome`.** `final_tool`, `error_class`, and `reason` are now populated for non-completed outcomes (was empty in ~30% of `abandoned`/`aborted`/`error` runs). `reason` is PII-masked at extraction (capped 500 chars for `error`, 200 for `aborted`); `final_tool` includes MCP-namespaced names (e.g. `mcp__atlassian__getJiraIssue`); `error_class` derives from `classifyError` patterns. Documented in `docs/docs/reference/telemetry.md`.
- **`bridge-guard` skill** (`.claude/commands/bridge-guard.md`). Codifies the v1.4.0 audit playbook into a reusable runbook covering split-brain module pairs, brand-leak patterns, behavior-patch loss, logo/color regressions, internal-script binary names, and the three-layer safety net. Invoke as `/bridge-guard [PR#]`.

### Fixed

- **Permission split-brain — infinite ask loop.** v1.4.0 introduced an Effect-TS `Permission` service in `src/permission/index.ts`, but every runtime ask site still called `PermissionNext.ask` from the older module in `src/permission/next.ts`. The two modules each owned their own pending map: asks landed in `PermissionNext`'s map, the HTTP reply route looked them up in the Effect service's empty map, returned 200 without resolving the deferred. User-visible: clicking "Allow once" / "Allow always" / "Reject" did nothing, the prompt kept re-rendering. Routed both reply routes plus `GET /permission` to `PermissionNext`. Pinned with 4 static-text invariants, 1 tree-wide import scan, and 3 runtime end-to-end deadlock tests.
- **`mcp add` lost its 7-flag non-interactive mode.** Bridge merge overwrote `McpAddCommand` with upstream's interactive-only version. Scripts/CI calling `mcp add --name foo --type remote --url …` either hung (no TTY) or silently dropped into prompts ignoring args. Restored full `--name --type --url --command --header --oauth --global` flag block with markers.
- **`mcp remove` command (and `rm` alias) restored** — entirely lost during v1.4.0 merge. `mcp remove <not-found>` now exits non-zero (was exiting 0 because `process.exit(1)` inside the async Effect chain was swallowed).
- **`SessionStatus.set` / `cancel` async drift.** v1.4.0 made these async but six callers in `prompt.ts` and `processor.ts` were unawaited, racing the idle-state flush on shutdown. All call sites now await; `defer(cancel)` switched to `await using`.
- **`tool/plan.ts` PlanExitTool reject semantics.** v1.4.0 changed reject from `answer !== "Yes"` to `answer === "No"`, so dialog cancel / dismiss / network drop silently confirmed the agent transition (unsafe). Reverted to "reject on anything but explicit Yes".
- **SQLite `IMMEDIATE` transaction was silently `DEFERRED`.** `Database.transaction()` wrapper didn't accept the `behavior` option, so `SyncEvent.run`'s read-then-write sequence fell back to deferred locking — concurrent runs could interleave and produce duplicate sequence numbers / corrupt event log. Pass-through added; runtime test exercises 10 parallel writers to prove serialization.
- **Plugin hook isolation.** `Plugin.trigger()` invoked each hook's callback with no try/catch — a single buggy plugin (third-party or local: codex/copilot/gitlab/etc.) would crash the entire LLM call with a confusing unrelated stack. Wrapped in try/catch with logged failure; iteration continues across remaining hooks.
- **HTML escaping in OAuth/codex callback templates.** `${error}` was interpolated raw in `mcp/oauth-callback.ts` (real XSS) and `plugin/codex.ts`. Added `escapeHtml()` helper, applied at every interpolation.
- **Symlink escape in `containsPath` boundary checks.** `project/instance.ts` and `plugin/shared.ts` reverted to `Filesystem.contains()` (lexical) during the bridge merge; restored to `Filesystem.containsReal()` (resolves symlinks before checking project boundary).
- **Effect Service identifier collision (`@opencode/Account`).** `account/index.ts` and `account/service.ts` both registered the same id with two parallel ManagedRuntimes (undefined merge behaviour). Deleted dead `effect/runtime.ts` and `account/service.ts`; renamed `auth/index.ts` to `@opencode/Auth.cli` to disambiguate from the live `auth/service.ts`.
- **`chat.params` `maxOutputTokens` hook silently ignored.** `session/llm.ts` computed `maxOutputTokens` *after* the hook fired and never read back from `params.maxOutputTokens` — codex/copilot's own `output.maxOutputTokens = undefined` was a no-op, and any third-party plugin altering this field did nothing. Now matches upstream PRs #21220 + #21225.
- **`File.search()` race with initial scan.** Cache was empty when tests called search before the initial scan completed. `files()` now tracks the in-flight scan with a `pending` promise and awaits it on call.
- **`MessageV2.fromError` regressions.** "OAuth token refresh failed" now returns `MessageV2.AuthError` instead of `UnknownError`. `errorMessage()` surfaces stack location for empty-message Error instances. Context-overflow detection added for OpenAI-style `context_length_exceeded` codes.
- **`workspace-router-middleware.ts` typeerror under `OPENCODE_EXPERIMENTAL_WORKSPACES=1`.** Adaptor API was renamed `fetch → target` in v1.4.0; rewrote to `adaptor.target()` + `ServerProxy.http()` and skip routing for local targets.
- **`Truncate.init()` lost from `project/bootstrap.ts`.** Hourly scheduler that prunes `Global.Path.data/tool-output/tool_*` never re-registered, so the directory grew unboundedly. Restored.
- **`provider/models.ts` `setTimeout(…, 0)` deferral on initial refresh.** Removed during merge, re-introducing the circular-dep risk fixed by altimate `980efaab64`. Restored.
- **TUI mid-render display corruption.** `clipboard.ts`, `dialog-workspace-list.tsx`, `dialog-mcp.tsx` had `console.log` writing directly to the terminal mid-render. Restored structured `Log.Default.debug` calls and removed a stray workspace-result `JSON.stringify` debug-print.
- **Workspace SSE reconnect loop killed by transient network blips.** `control-plane/workspace.ts` lost its defensive `.catch(() => undefined)` and a `return` from the local-workspace branch was permanent rather than per-iteration. Restored both.
- **Branding restoration after v1.4.0 leaks.** Fixed in three batches: cycle-7 audit (196 leaks across 66 files: `$schema` URLs, system prompts, repo references, generated SDK strings, route descriptions); ASCII logo (`ALTIMATE | CODE` block letters were swapped for `OPEN | CODE`); brand colors on the startup logo (`theme.primary` warm orange + `theme.accent` purple were replaced with monochrome grey/white); `attach.ts` Basic-auth username (was `opencode:`, broke authentication against altimate-code servers); `cli/cmd/github.ts` AGENT_USERNAME / WORKFLOW_FILE / GitHub App slug / OIDC audience / branch prefix; CLI describe text in 8+ subcommands; `mcp` resolveConfigPath order (`altimate-code.json` precedence with `opencode.json` fallback for existing installs); plugin install path (`.altimate-code/` for new installs, keep `.opencode/` if it exists).
- **API-key leakage in masked strings.** `maskString` only redacted quoted spans. Added unquoted-API-key (`sk-`, `sk-ant-`, `sk-proj-`) and `Bearer …` patterns with a 20-char length floor (avoids false positives on short identifiers like `sk-foo`). All 9 existing `maskString` consumers pick this up.
- **`ERROR_PATTERNS` coverage for HTTP 5xx + rate-limit prose.** Real provider errors like `APIError: Service unavailable (503)` and `Rate limit exceeded. Retry after 60s` were classifying as `unknown` because patterns only matched the prefixed forms. Added phrases: `service unavailable`, `rate limit`, `rate_limit`, `retry after`, `too many requests`, `503`, `502`, `504` to the `http_error` class.
- **`marker-guard` strict mode on bridge-merge pushes to main.** PR-side guard already runs non-strict for `upstream/merge-*` head_refs, but the squash-merge push event has no head_ref — was failing on the hundreds of upstream files the bridge brings in. Now detects bridge/upstream-merge commits in the pushed range by subject (`grep -qiE '(bridge|merge) upstream'`) and downgrades strict→non-strict. (#782, closes #781)

### Security

- **API-key redaction at the diagnostic surface.** `Telemetry.deriveAgentOutcomeReason()` applies `maskString` to both `error` and `aborted` reasons before they enter the `agent_outcome.reason` field (which surfaces in our backend telemetry). `prompt.ts` extracts only `err.data.message` instead of `JSON.stringify(error.data)` (which leaked `responseBody` / `responseHeaders` / metadata).
- **Plugin hook crash containment.** A single plugin throwing in `chat.params` / `chat.headers` / any registered hook no longer takes down the entire LLM call (see Fixed).

### Internal

- **Three-layer regression backstop for bridge merges.** (1) `script/upstream/analyze.ts --branding` now catches bare `opencode` strings in user-visible contexts (yargs `describe`, console output, MCP `clientInfo.name`, User-Agent, OIDC audiences, GitHub workflow YAML, `spawn` binary names); skips lines inside `altimate_change` blocks. (2) New `MergeConfig.requireMarkers` allowlist of 38 files known to hold altimate behavioral patches; `bridge-merge.ts` treats them as `keepOurs` and hard-aborts the merge if any is missing markers. (3) Retroactive marker sweep added markers to 14 previously-unmarked files. CI runs `--branding` and `--require-markers --strict` on every PR.
- **9 audit cycles documented and pinned.** 310 tests across 8 files in `test/upstream/` (`bridge-merge`, `bridge-merge-invariants`, `bridge-merge-runtime`, `bridge-merge-v3`, `bridge-merge-e2e`, `v140-merge-adversarial`, `v140-merge-fuzz`, `v140-merge-chaos`, `v140-permission-deadlock`).
- **`tracing.ts` `flushSync` vs async `snapshot` race.** Crashed-trace file could be clobbered by an in-flight async snapshot completing its `fs.rename` after `flushSync`'s sync write. Added a `crashed` flag with two checkpoint reads on the async path. Plus `Recap.flush()` helper to replace `setTimeout(50)` waits in tests on slow CI runners.
- **GitGuardian whitelisting.** `.gitguardian.yaml` paths-ignore for the `protected.ts` deny-list (filenames like `.pgpass` / `id_rsa` / `credentials.json` are filenames, not credentials); split filename literals via `DOT + "name"` concatenation so the GG dashboard doesn't keep flagging them; replaced JWT-shaped synthetic tokens in the v140 adversarial suite with generic 36-char alphanumeric tokens.
- **`.github/meta/{commit,diff,pr-body-*}` untracked + gitignored.** Per CLAUDE.md these are transient scratch files; tracked instances were leaking false-positive branding hits and stale commit messages. Pattern broadened to `**/.github/meta/...` so nested paths are covered.
- **`globalThis.fetch` leak in `session-proxy-middleware.test.ts`.** Test stubbed `fetch` but never restored it, cascading into ~15 unrelated test failures (OAuth, ECONNRESET, HttpExporter, Discovery, live-trace-viewer). Now snapshots and restores in `afterEach`.
- **Restored `.github/TEAM_MEMBERS`.** Bridge merge replaced our 30-name list with upstream's 15-name list, removing 28 altimate maintainers including `anandgupta42` — `pr-standards.yml` was flagging every team member's PR with `needs:title` / `needs:compliance` and auto-closing after 2 hours.

### Testing

- **200+ new tests pinning every audit-cycle fix:** static-text invariants for service identifiers, async signatures, marker integrity, branding; runtime tests for `Database.transaction` IMMEDIATE serialization, `BusEvent.define` idempotency, `SyncEvent` ⊆ `BusEvent` registry bridge, `PlanExitTool` reject semantics, plugin trigger isolation; property-based fuzz of `maskString` (5×500 random iterations on unicode/control-chars/emoji), `deriveAgentOutcomeReason` field bounds; chaos: 100 parallel `deriveAgentOutcomeReason` calls, regex DoS resistance with relative-budget thresholds; E2E: spawns the CLI as a real user (`bun run src/index.ts <args>` with isolated `XDG_*` env vars) and visually inspects `--version`, `--help`, `mcp --help`, theme schemas, system-prompt files, etc.
- **Hardened flaky tests against parallel-suite contention.** Extracted pure helpers from `tui/thread.ts` to remove `mock.module()` calls that leaked across files. Replaced FIFO request-matching queue in `session/llm.test.ts` with a path-keyed Map (out-of-order requests no longer resolve another test's deferred). Added explicit `30_000ms` timeouts to slow-SDK tests. Local full suite: 7965 pass / 0 fail.

### Documentation

- **README refreshed for v0.5.12 through v0.6.1** — adds three Key Features entries (cross-dialect data parity, automated dbt unit tests, GitLab MR review), four providers (Altimate LLM Gateway, Databricks AI Gateway, Snowflake Cortex, LM Studio), Microsoft Fabric warehouse footnote, `/data-parity` and `/dbt-unit-tests` quick-demo examples, inline list of the 19 built-in skills. Source of truth is CHANGELOG.md; bullets are condensed restatements. (#784)

## [0.6.1] - 2026-04-24

### Fixed

- **BigQuery finops tools were broken — now work, in any region.** `finops_query_history` was failing 100% on BigQuery with `Unrecognized name: error_message at [11:5]`. Three separate bugs in the `INFORMATION_SCHEMA.JOBS` template: (a) `error_message` and `error_code` were read as top-level columns but they only exist inside the `error_result` struct — now reads `error_result.message` and `error_result.reason`; (b) `total_rows` is a `PARTITIONS` column, not `JOBS` — replaced with `CAST(NULL AS INT64) AS rows_produced`; (c) BigQuery's `state` returns `'DONE'`, not `'SUCCESS'`, so the summary loop was reporting every completed job as FAILED — now derives `execution_status` from `error_result IS NULL`. Every successful BQ job now reports as SUCCESS. (#739, closes #738)
- **BigQuery finops unusable outside US region.** All five finops modules (`finops_query_history`, `finops_analyze_credits`, `finops_expensive_queries`, `finops_warehouse_advice`, `finops_unused_resources`, `finops_role_grants`) hardcoded `` `region-US.INFORMATION_SCHEMA.*` ``. Now reads the BigQuery connection's configured `location` (e.g. `us`, `eu`, `us-central1`, `asia-northeast1`), sanitised via an `[a-z0-9-]` allowlist with a 64-char cap and hyphen trim. If `location` is unset the tool defaults to `us` — **set `location` explicitly on the BigQuery connection for non-US projects** or you will query the wrong region. Snowflake and Databricks paths are unchanged. (#739)

### Changed

- **`@altimateai/altimate-core` 0.3.0 → 0.3.1** — upstream patch release of the native SQL type-checker used by `altimate_core_validate` and the cross-dialect data-parity engine.

### Docs

- **New showcase page** (`docs/examples/`) with 12 end-to-end workflow demos — dbt peer review, column-level lineage diff, MS SQL → Fabric migration, Fabric platform admin, upstream schema change, NYC Taxi, Olist, Spotify, and more. (#742)
- **`location` field documented** on the BigQuery connection and called out on the finops tools page.

### Data handling

- `finops_query_history`, `finops_analyze_credits`, and `finops_warehouse_advice` read `user_email` (BigQuery), `user_name` (Snowflake / Databricks / ClickHouse), and raw `query_text` from warehouse system views. Results are returned to the agent and enter the LLM context window. No telemetry or backend upload. Review your tenant's data-handling policy before enabling finops tools in regulated (PII / PHI / PCI) environments.
- `finops_unused_resources` on BigQuery reads `INFORMATION_SCHEMA.TABLE_STORAGE`, which is an org-level view. Project-scoped service accounts typically require `bigquery.resourceAdmin` at the org to avoid a permission error.

### Internal

- `anti-slop` CI workflow is now advisory — labels + comments still fire on blocked-term hits, but the workflow no longer auto-closes PRs. Root cause: the repo's pull-request template embeds an HTML comment instructing AI to insert "PINEAPPLE", which `anti-slop.yml` also blocklists — every AI-assisted team-member PR was auto-closing within two minutes. (#741, closes #740)
- Marker-guard hotfix: the `isValidDatabricksHost` env-fallback path added in v0.6.0 straddled the post-push Marker Guard's `-U5` diff window; wrapped in an inline `altimate_change` marker pair to keep strict mode green.

### Testing

- New adversarial tests for v0.6.1 in `packages/opencode/test/skill/release-v0.6.1-adversarial.test.ts`: `sanitizeBqRegion` injection vectors (CRLF, null bytes, backticks, path traversal, Unicode homoglyphs, prototype-pollution-adjacent inputs), `interpolateBqRegion` idempotency and multi-placeholder safety, `bqRegionFor` registry edge cases, BIGQUERY_HISTORY_SQL column-name regression guards (all four #739 bugs), cross-module "every BQ template uses `{region}`" guard, and full-pipeline `buildHistoryQuery` behaviour including Snowflake / Databricks no-regression guards.

## [0.6.0] - 2026-04-21

### Added

- **Data parity (`data_diff` tool + skill)** — compare tables or SQL-query results row-by-row across Postgres, Snowflake, BigQuery, Databricks, ClickHouse, MySQL, Redshift, SQL Server, Microsoft Fabric, DuckDB, SQLite, and Oracle. Five algorithms: `auto` (JoinDiff same-dialect, HashDiff cross-dialect), `joindiff` (FULL OUTER JOIN), `hashdiff` (bisecting checksums — works at any scale without pulling data out), `profile` (column-level statistics, no row values leave the database), and `cascade` (profile first, then HashDiff on diverging columns). Partitioning supports date (`day`/`week`/`month`/`year`), numeric (`bucket_size`), and categorical (distinct values) modes so 100M+ row tables diff in independent batches. Auto-discovers comparable columns from `information_schema`, excludes audit/timestamp columns by name pattern AND by catalog default (`NOW()`, `CURRENT_TIMESTAMP`, `GETDATE()`, `SYSDATE`, `SYSTIMESTAMP`), and confirms exclusions with the user before diffing. (#493)
- **MSSQL and Microsoft Fabric support in data-parity** — dialect-aware date truncation (`DATETRUNC`), locale-safe date literals (`CONVERT(DATE, ..., 23)`), and seven Azure AD / Entra ID authentication flows (password, access-token, service-principal-secret, MSI-VM, MSI-app-service, default credential chain, token-credential) delegated to `tedious`. Upgrades `mssql` v11 → v12 with explicit `ConnectionPool` isolation and correct handling of unnamed-column result sets. (#705)
- **Databricks AI Gateway provider** — connect to Databricks serving endpoints (Foundation Model APIs) via PAT auth (`workspace-host::token`), with fallback to `DATABRICKS_HOST` / `DATABRICKS_TOKEN` environment variables. Registers 11 foundation models — Meta Llama 3.1 (405B / 70B / 8B), Claude Sonnet / Opus 4.6, GPT-5.4 / GPT-5 Mini, Gemini 3.1 Pro, DBRX Instruct, and Mixtral 8x7B. Host regex restricts credentials to `*.cloud.databricks.com`, `*.azuredatabricks.net`, and `*.gcp.databricks.com`. (#649, closes #602)
- **Amazon Bedrock custom-endpoints guide** — dedicated docs page covering bearer-token auth, AWS credential chain, `baseURL` configuration, cross-region model-ID prefixing, and troubleshooting. Provider key corrected from `bedrock` to `amazon-bedrock` across quickstart, providers, and models pages. (#706)
- **User-facing docs for the new features** — Databricks AI Gateway section in `configure/providers.md` and a full `data-engineering/guides/data-parity.md` covering supported warehouse pairs, algorithms, partition modes, Azure AD auth matrix for Fabric, and compliance guidance.

### Changed

- **`@altimateai/altimate-core` 0.2.6 → 0.3.0** — enables the cross-dialect data-parity engine, T-SQL dialect support for MSSQL/Fabric, and refined hashdiff bisection. Rebuilt native binaries published for all five supported platforms. (#717, closes #716)
- **Altimate connect dialog polish** — `/connect` now accepts `instance-name::api-key` directly (default URL `https://api.myaltimate.com`). The three-part `api-url::instance-name::api-key` form still works for custom and self-hosted instances. Provider display name "Altimate" → "Altimate AI"; default model display "Altimate AI" → "Altimate LLM Gateway". The internal provider ID (`altimate-backend`) and model ID (`altimate-default`) are preserved — existing `model.json` favorites, recents, and pinned `model:` entries in `opencode.json` continue to work without migration. (#724)

### Fixed

- **Text contrast on light terminal backgrounds** — dark foreground (`#1a1a1a` or `palette[0]` when available) replaces the near-invisible `palette[7]` on light-mode system themes, and inline code blocks now render on an opaque background instead of transparent. Eager `COLORFGBG` env-var detection narrowed to `bg === 7 || bg === 15` skips the 1-second OSC 11 query altogether on light terminals that don't support it (urxvt, gnome-terminal). (#712, closes #704)
- **Historical `tool_use` blocks after agent switches or MCP disconnects** — the LiteLLM-only `_noop` workaround is replaced by a general fix: tool names are extracted from both `tool-call` and `tool-result` blocks in message history (using `Object.hasOwn()` for prototype-pollution safety), validated against `/^[a-zA-Z0-9_-]{1,64}$/`, and registered as stubs that return "tool no longer available" if the model attempts to call them. Eliminates the Anthropic API 400 error "Requests with 'tool_use' and 'tool_result' blocks must include tool definition." (#703, closes [AI-678])
- **`/docs` command and config links point to `docs.altimate.sh`** — the TUI "Open docs" action, Cloudflare AI Gateway help text, Anthropic system prompt, and `Config.command` / `Config.agent` schema descriptions previously linked to the wrong domain. Also updates paths to the `/configure/` prefix that matches the actual mkdocs site. (#715, closes #714)

### Security

- **Databricks host validation hardened** — new `isValidDatabricksHost` helper rejects CRLF/whitespace (JS regex `$` matches before `\n` by default), and the env-fallback path now validates host before constructing the `baseURL`.
- **Tool-name validation** — stub registration ignores names with shell metacharacters, ANSI escapes, control characters, or lengths > 64, guarding against tampered session-file replays.
- **Restricted `az` inherited env** — `az account get-access-token` is invoked with a whitelisted environment (`PATH`, `HOME`, `AZURE_*`, locale) so unrelated secrets (`DATABRICKS_TOKEN`, cloud provider keys) are not inherited by `az` or any `az` extension.

### Testing

- 38 new adversarial tests covering Databricks host validation (CRLF, anchoring, attacker suffixes), PAT parsing edge cases, body transform, tool-name tainted-input guards, and `data_diff` tool-description release contract.
- 139-test consolidation across dbt helpers, file status, project-scan, session/llm, and MCP discovery — symlink cache round-trips, seed/test node exclusion, JSON array edge cases, sessionId sanitization, pagination boundary math, and connection-string masking. Two broken `${VAR}`-in-MCP-`command` tests removed (resolution was always restricted to `env` and `headers`). (#709)

### Compliance note

`data_diff` includes up to 5 sample diff rows in its tool output, which becomes part of the LLM conversation. For PII / PHI / PCI data, use `algorithm: "profile"` — column statistics compare without sending row values. The `data-parity` skill asks for explicit confirmation before running row-level diffs against tables whose names match common regulated patterns (`customers`, `patients`, `orders`, `payments`, `accounts`, `users`). A hard env-var opt-out for sample values is tracked in [#729](https://github.com/AltimateAI/altimate-code/issues/729).

### Breaking

- **`mssql` upgraded to v12**. Users with `mssql@^11` pinned at the application level will see "mssql.ConnectionPool is not available" on first SQL Server connection. Pin to `^12` or let altimate resolve.
- **SQL Server result sets now expose `_`-prefixed columns**. The internal `startsWith("_")` column filter (introduced for partition-discovery noise suppression) was removed because it also stripped legitimate aliases like `_p` used by the partition engine. Queries that relied on this implicit filtering will see the extra columns in results.

## [0.5.21] - 2026-04-13

### Added

- **Automated dbt unit test generation** — generate dbt unit tests (v1.8+) from your terminal with `/dbt-unit-tests` or the `dbt_unit_test_gen` tool. Detects testable SQL constructs (CASE/WHEN, JOINs, NULLs, window functions, division, incremental models) and assembles complete YAML with type-correct mock data across 7 dialects. Includes `input: this` mocks for incremental models, `format: sql` for ephemeral deps, and handles seeds/snapshots as first-class `ref()` deps. Five-phase skill workflow: Analyze → Generate → Refine → Validate → Write. Requires dbt-core 1.8+. (#673)
- **Manifest parse cache** — `loadRawManifest()` caches by path+mtime so large manifests (100MB+) are parsed once per session, not once per tool call.
- **Model/source descriptions in manifest** — `DbtModelInfo` and `DbtSourceInfo` now surface descriptions from `schema.yml`, giving downstream tools richer semantic context.
- **`adapter_type` on `DbtManifestResult`** — exposes the dbt adapter type (snowflake, bigquery, etc.) from manifest metadata for dialect auto-detection.

### Fixed

- **MCP env-var `$${VAR}` escape and chain-injection vulnerability** — the two-layer env-var resolution design allowed `$${VAR}` escapes to be re-resolved (breaking literal `${VAR}` passthrough) and enabled variable-chain injection where `EVIL_VAR="${SECRET}"` could exfiltrate secrets the config never referenced. Collapsed to a single resolution pass scoped to `env` and `headers` fields only. (#697, relates to #656)
- **MCP server environment variables passed as literals** — `${VAR}`, `${VAR:-default}`, and `{env:VAR}` patterns in MCP server `env` blocks were passed as literal strings to child processes, causing auth failures for tools like `gitlab-mcp-server`. (#666, closes #656)
- **`sql_explain` and `altimate_core_validate` input hardening** — reject empty/placeholder SQL and warehouse names before hitting the warehouse. `sql_explain` now generates dialect-aware EXPLAIN statements for 12+ warehouse types. Driver errors are translated into actionable guidance (e.g., "No warehouses configured — run `warehouse_add`"). `altimate_core_validate` now runs even without a schema (previously hard-failed), with a `(no schema)` indicator and clear instructions for providing schema context. (#693, closes #691)
- **`sql_explain` alternatives for unsupported warehouses** — BigQuery, Oracle, and SQL Server now return specific guidance (dry-run API, `DBMS_XPLAN`, `SET SHOWPLAN_TEXT ON`) instead of a generic "not supported" message.

## [0.5.20] - 2026-04-09

### Added

- **Altimate model auto-selection** — when Altimate credentials are configured and no model is explicitly chosen, `altimate-backend/altimate-default` is selected automatically. Respects the `provider` filter in config if set. No manual `/model` selection needed for first-time Altimate users. (#665)

### Fixed

- **Connection string passwords with special characters** — passwords containing `@`, `#`, `:`, `/`, or other URI-reserved characters are now automatically percent-encoded in `connection_string` configs. Previously these caused cryptic authentication failures because the URI parser split on the wrong delimiter. Already-encoded passwords (`%XX`) are left untouched. Affects all URI-based drivers (PostgreSQL, MongoDB, ClickHouse). (#597, closes #589)
- **`trace list` pagination** — `trace list` now supports `--offset` for navigating large trace histories, displays "Showing X-Y of N" with a next-page hint, and caps the TUI trace dialog at 500 items (up from 50) with an overflow message pointing to the CLI for the full set. (#596, closes #418)
- **ClickHouse edge-case hardening** — added tests for `LowCardinality(Nullable(...))` nullability detection, `Map`/`Tuple` wrapper handling, undefined type fallback, and SQL comment/string-escape edge cases in the LIMIT injection guard. (#599, closes #592)

### Testing

- 31 new adversarial tests covering connection string sanitization (injection, encoding edge cases, ReDoS, Unicode, null bytes), pagination boundary math (Infinity, NaN, fractional, negative inputs), and `Provider.parseModel` edge cases.

## [0.5.19] - 2026-04-04

### Added

- **`${VAR}` environment variable interpolation in configs** — use shell/dotenv-style `${DB_PASSWORD}`, `${MODE:-production}` (with defaults), or `$${VAR}` (literal escape) anywhere in `altimate.json` and MCP server configs. Values are JSON-escape-safe so passwords containing quotes or backslashes can't corrupt your config structure. The existing `{env:VAR}` syntax continues to work for raw text injection. (#655, closes #635)

### Fixed

- **Plan agent warns when the model refuses to tool-call** — if the plan agent's model returns text without invoking any tools, altimate-code now surfaces a one-shot TUI warning suggesting you switch models via `/model` instead of silently hanging. Telemetry event `plan_no_tool_generation` emitted for session-level diagnosis. (#653)
- **GitLab MR review: large-diff guard & prompt-injection hardening** — MRs exceeding 50 files or 200 KB of diff text are truncated upfront with a user-visible warning, and the review prompt explicitly frames MR content as untrusted input. (#648)
- **Atomic trace file writes** — `FileExporter` now writes to a temp file and renames, preventing partial/corrupt trace JSON on crash or SIGKILL. Stale `.tmp.*` artifacts older than 1 hour are swept during prune. (#646)
- **15s timeout on credential validation** — `AltimateApi.validateCredentials()` no longer hangs indefinitely if the auth endpoint stalls. (#648)
- **Shadow-mode SQL pre-validation telemetry** — measures catch-rate for structural errors (missing columns, tables) against cached schema before enabling user-visible blocking in a future release. Fire-and-forget, zero impact on the `sql_execute` hot path. No raw SQL, schema identifiers, or validator error text transmitted. (#643, #651)
- **GitLab docs rewrite** — replaced "work in progress" warning with a complete guide: quick-start, authentication, self-hosted instances, model selection, CI example. (#648)

### Testing

- 25 new adversarial tests covering env-var interpolation (JSON-escape safety, single-pass substitution, ReDoS, escape hatch, defaults), atomic write hygiene (race conditions, tmp sweep, sessionId sanitization), and telemetry identifier-leak guards. New ClickHouse finops/profiles/registry coverage. (#624)

## [0.5.18] - 2026-04-04

### Added

- **Native GitLab MR review** — review merge requests directly from your terminal with `altimate gitlab review <MR_URL>`. Supports self-hosted GitLab instances, nested group paths, and comment deduplication (updates existing review instead of posting duplicates). Requires `GITLAB_PERSONAL_ACCESS_TOKEN` or `GITLAB_TOKEN` env var. (#622)
- **Altimate LLM Gateway provider** — connect to Altimate's managed model gateway via the TUI provider dialog (select a provider → "Altimate"). Credentials validated before save, stored at `~/.altimate/altimate.json` with `0600` permissions. (#606)

### Fixed

- **Glob tool: timeout, home/root blocking, default exclusions** — glob searches now timeout after 30s (returning partial results) instead of hanging indefinitely. Scanning `/` or `~` is blocked with a helpful message. Common directories (`node_modules`, `.git`, `dist`, `.venv`) are excluded by default. (#637)
- **MCP config normalization** — configs using `mcpServers` (Claude Code, Cursor format) are auto-converted to `mcp` at load time. External server entries with `command` + `args` + `env` are transformed to altimate-code's native format. (#639)
- **Light theme readability** — fixed white-on-white text in light terminal themes by adding explicit foreground colors to markdown and code blocks. (#640)

## [0.5.17] - 2026-04-02

### Added

- **Custom dbt `profiles.yml` path resolution** — Altimate Code now resolves `profiles.yml` using dbt's standard priority: explicit path → `DBT_PROFILES_DIR` env var → project-local `profiles.yml` → `~/.dbt/profiles.yml`. Teams using `DBT_PROFILES_DIR` in CI get zero-friction auto-discovery. Jinja `{{ env_var('NAME') }}` patterns are resolved automatically. A warning is shown when `DBT_PROFILES_DIR` is set but the file is not found. (#605)

### Fixed

- **ClickHouse: SQL comment injection bypass** — Comments could previously mask write statements from the read-only LIMIT guard. String literals are now stripped before comment removal to prevent false matches. (#591)
- **ClickHouse: `LowCardinality(Nullable(...))` nullability** — Schema inspection previously reported these columns as non-nullable; now correctly detected as nullable. (#591)
- **ClickHouse: connection lifecycle guards** — All query methods now throw a clear error if called before `connect()`, preventing cryptic TypeErrors. (#591)
- **ClickHouse: `binds` parameter handling** — Queries with parameterized binds no longer throw a driver error; the parameter is safely ignored (ClickHouse uses `query_params` natively). (#591)
- **Stale file retry loops on WSL and network drives** — `FileTime.read()` now uses filesystem mtime instead of wall-clock, eliminating 782-iteration retry loops caused by clock skew on WSL (NTFS-over-9P), NFS, and CIFS mounts. Set `OPENCODE_DISABLE_FILETIME_CHECK=true` as escape hatch if needed. (#611)
- **Error classification: `file_stale` split and keyword fix** — `file_stale` is now a distinct error class; HTTP 4xx errors no longer misclassify as validation failures; restored `"does not exist"` keyword for SQL errors like `"column foo does not exist"`. (#611, #614)

## [0.5.16] - 2026-03-30

### Added

- **ClickHouse support** — Connect to ClickHouse Cloud, self-hosted clusters, or local Docker instances running ClickHouse 23.3+. Supports HTTP/HTTPS, TLS mutual auth, and dbt-clickhouse adapter auto-discovery. Includes MergeTree optimization guidance, materialized view design, partition pruning analysis, and query history via `system.query_log`. Requires `npm install @clickhouse/client` (#574)

### Fixed

- **Agent loop detection** — The agent now detects when a single tool is called 30+ times in a session (a pattern seen with runaway tool loops) and pauses for confirmation before continuing. Complements the existing same-input repetition detection (#587)
- **Improved error diagnostics** — Tool failures now report more specific error categories (`not_configured`, `file_not_found`, `edit_mismatch`, `resource_exhausted`) instead of generic "unknown" classification, improving support triage (#587)
- **Session environment metadata** — `session_start` telemetry now includes `os`, `arch`, and `node_version` for environment-based segmentation (#587)

## [0.5.15] - 2026-03-29

### Added

- **Plan agent two-step approach** — outline first, confirm, then expand; plan refinement loop with edit-in-place (capped at 5 revisions); approval phrase detection ("looks good", "proceed", "lgtm") (#556)
- **Feature discovery & progressive disclosure** — contextual suggestions after warehouse connection (schema, SQL, lineage, PII); dbt auto-detection recommending `/dbt-develop`, `/dbt-troubleshoot` (#556)

### Fixed

- **SQL classifier fallback security hardening** — invert fallback to whitelist reads (not blacklist writes), handle multi-statement SQL, strip line comments, fix `HARD_DENY_PATTERN` `\s` → `\b`; fix `computeSqlFingerprint` referencing undefined `core` after safe-import refactor (#582)
- **Edit tool nearest-match error messages** — `buildNotFoundMessage` with Levenshtein similarity search shows closest file content when `oldString` not found, helping LLM self-correct (#582)
- **Webfetch failure caching and actionable errors** — session-level URL failure cache (404/410/451) with 5-min TTL; status-specific error messages telling the model whether to retry; URL sanitization in errors to prevent token leakage (#582)
- **Nested `node_modules` in `NODE_PATH`** — `@altimateai/altimate-core` NAPI resolution now works for npm's hoisted and nested layouts (#576)
- **Null guards across 8 tool formatters** — prevent literal `undefined` in user-facing output for sql-analyze, schema-inspect, sql-translate, dbt-manifest, finops, and warehouse tools; DuckDB auto-retry on `database is locked` (#571)
- **Telemetry error classification** — add `http_error` class, expand connection/validation/permission patterns, redact sensitive keys in input signatures (#566)
- **Pre-release review findings** — remove dead code, fix `classifySkillTrigger()` unknown trigger handling, add null guards in lineage/translate tools (#580)
- **Binary alias hard copy** — use `cp` instead of symlink for `altimate-code` binary alias to fix cross-platform compatibility (#578)

### Testing

- Verdaccio sanity suite: 50 new tests across 3 phases, added to CI and release workflows (#560, #562)
- 12 new tests for `buildNotFoundMessage`, `computeSqlFingerprint`, and webfetch error messages (#582)

## [0.5.14] - 2026-03-28

### Added

- **MongoDB driver support** — 11th supported database with full MQL command set (find, aggregate, CRUD, indexes), BSON type serialization, schema introspection via document sampling, and cross-database queries; includes 90 E2E tests (#482)
- **Skill follow-up suggestions** — contextual "What's Next?" suggestions after skill completion to reduce first-run churn; maps 12 skills to relevant follow-ups with warehouse discovery nudge (#546)
- **`altimate-dbt build` without `--model`** — builds the entire dbt project via `unsafeBuildProjectImmediately`, replacing the separate `build-project` command (#546)
- **`upstream_fix:` marker convention** — new tag for temporary upstream bug fixes with `--audit-fixes` command to review carried fixes before upstream merges (#555)
- **Verdaccio-based sanity suite** — local npm registry test harness for real install verification, smoke tests, and upgrade scenarios (#503)

### Fixed

- **Locale duration days/hours swap** — `Locale.duration()` for values ≥24h showed wrong days/hours (total hours instead of remainder); e.g., 25h now correctly shows `1d 1h` (#529)
- **Dispatcher `reset()` not clearing lazy registration hook** — `reset()` only cleared handlers but left `_ensureRegistered` alive, causing flaky test failures (#529)
- **Impact analysis showing project-wide test count** — was using `manifest.test_count` (all tests in project) instead of counting only tests referencing the target model (#529)
- **Prototype pollution in `SkillFollowups.get()`** — `FOLLOWUPS["__proto__"]` traversed `Object.prototype`; fixed with `Object.hasOwn()` guard (#558)
- **Shallow freeze in `SkillFollowups.get()`** — `Object.freeze()` on array didn't freeze nested objects, allowing shared state mutation; fixed with deep copy (#558)
- **CI Bun segfault resilience** — Bun 1.3.x crashes during test cleanup now handled by checking actual pass/fail summary instead of exit code (#555)

### Testing

- 52 adversarial tests for v0.5.14 release: `SkillFollowups` injection/boundary/immutability, `Locale.duration` tier transitions, `Dispatcher.reset` hook cleanup (#558)
- Consolidated 39 test PRs — 1,173 new tests across session, provider, MCP, CLI stats, bus, and utility modules (#498, #514, #545)

## [0.5.13] - 2026-03-26

### Fixed

- **Pin `@altimateai/altimate-core` to exact version** — prevents npm from resolving stale cached binaries during install (#475)
- **Flaky `dbt Profiles Auto-Discovery` tests in CI** — stabilized tests that failed intermittently due to timing issues

### Changed

- **Bump `yaml` from 2.8.2 to 2.8.3** — dependency update in `packages/opencode` (#473)

## [0.5.12] - 2026-03-25

### Added

- **`altimate-dbt` auto-discover config** — `altimate-dbt` commands now auto-detect `dbt_project.yml` and Python from the current directory without requiring `altimate-dbt init` first; supports Windows paths (`Scripts/`, `.exe`, `path.delimiter`) (#464)
- **Local E2E sanity test harness** — Docker-based test suite (`test/sanity/`) for install verification, smoke tests, upgrade scenarios, and resilience checks; runnable via `bun run sanity` (#461)

### Fixed

- **`altimate-dbt` commands fail with hardcoded CI path** — published binary contained a baked-in `/home/runner/work/...` path for the Python bridge; `copy-python.ts` now patches `__dirname` to use `import.meta.dirname` at runtime (#467)

### Testing

- 42 adversarial tests for config auto-discovery and dbt resolution: `findProjectRoot` edge cases (deep nesting, symlinks, nonexistent dirs), `discoverPython` with broken symlinks and malicious env vars, `resolveDbt` with conflicting env vars and priority ordering, `validateDbt` timeout/garbage handling, Windows constant correctness, `path.delimiter` usage, `buildDbtEnv` mutation safety
- 484-line adversarial test suite for the `__dirname` patch: regex edge cases, ReDoS protection, mutation testing, idempotency, CI smoke test parity, bundle runtime structure validation

## [0.5.11] - 2026-03-25

### Fixed

- **README changelog gap** — updated README to reflect releases v0.5.1 through v0.5.11; previous README only listed up to v0.5.0
- **npm publish transient 404s** — added retry logic (3 attempts with backoff) to `publish.ts` for concurrent scoped package publishes that hit npm registry race conditions

## [0.5.10] - 2026-03-24

### Added

- **`altimate-code check` CLI command** — deterministic SQL checks (linting, formatting, style) that run without an LLM, suitable for CI pipelines and pre-commit hooks (#453)
- **Data-viz skill improvements** — lazy initialization, data-code separation, color contrast rules, icon semantics, field validation, and pre-delivery checklist (#434)

### Fixed

- **Snowflake Cortex not visible before authentication** — provider now appears in the provider list even when not yet authenticated (#447)
- **New user detection race condition** — first-run welcome flow and telemetry events could fire out of order or be skipped entirely (#445)
- **52 CI test failures from `mock.module` leaking across files** — test isolation fix for the new `check` command e2e tests (#460)
- **Missing `altimate_change` marker** — added required upstream marker on `isStatelessCommand` guard to pass Marker Guard CI (#457)

### Changed

- **Rename Recap back to Trace** — reverted the Recap branding to Trace across 29 files for better AI model comprehension of session recording concepts (#443)

### Testing

- Consolidated 12 hourly test PRs into single batch: slugify, hints sort, skill formatting, batch tools, filesystem utilities, wildcard matching — 1,680 new test lines (#439)
- `altimate-code check` unit + e2e test suites (1,687 lines) (#453)
- Snowflake Cortex provider visibility tests (#447)

## [0.5.9] - 2026-03-23

### Fixed

- **Codespaces support** — skip machine-scoped `GITHUB_TOKEN` that lacks repo access, cap provider retries to prevent infinite loops, fix phantom `/discover-and-add-mcps` command that was missing from builtin commands (#415)
- **`sql_analyze` reports "unknown error" for successful analyses** — tool returned error status even when analysis completed successfully (AI-5975) (#426)
- **Remove `semver` dependency from upgrade path** — replaced with zero-dependency version comparison to prevent users getting locked on old versions when `semver` fails to load (#421)
- **Ship `discover-and-add-mcps` as a builtin command** — moved from `.opencode/command/` config directory to embedded template so it works out of the box (#409)

### Testing

- Comprehensive upgrade decision tests covering version comparison, downgrade prevention, and edge cases (#421)
- Codespace E2E tests for `GITHUB_TOKEN` filtering, retry caps, and provider initialization (#415)

## [0.5.8] - 2026-03-23

### Fixed

- **dbt commands crash with `SyntaxError: Cannot use import statement`** — bundled `dbt-tools/` was missing `package.json` with `"type": "module"`, causing Node to default to CJS and reject ESM imports. Broken since v0.5.3. (#407)
- **Publish script idempotency** — re-running `publish.ts` without cleaning `dist/` would crash because the synthesized `dbt-tools/package.json` (no `name`/`version`) polluted the binary glob scan (#407)
- **Skill builder `ctrl+i` keybind** — ESC navigation and dialog lifecycle fixes in TUI skill management (#386)
- **Upgrade notification silently skipped** — multiple scenarios where the upgrade check was bypassed (#389)
- **Phantom `sql_validate` tool** — removed non-existent tool reference from analyst agent permissions, replaced with `altimate_core_validate` (#352)
- **CI test suite stability** — eliminated 29 pre-existing test failures: added `duckdb` devDependency, fixed native binding contention with retry logic and `beforeAll` connections, increased timeouts for slow bootstrap operations, added `--timeout 30000` to CI workflow (#411)

### Added

- **Trace (session recording)** — session trace with loop detection and enhanced viewer (#381)
- **ESM bundling regression tests** — 9 e2e tests verifying Node can load `altimate-dbt` via symlink, wrapper, and direct invocation paths

### Testing

- 133 new tests across 9 modules: finops role access, tool lookup, config path parsing, ID generation, file ignore/traversal, patch operations, session instructions/messages/summaries, shell utilities (#403)
- SQL validation adversarial + e2e test suites (#352)
- Provider error classification — overflow detection and message extraction (#375)
- Impact analysis DAG traversal and training import parsing (#384)
- RPC client protocol and `abortAfter`/`abortAfterAny` coverage (#382)
- Color, signal, and defer utility coverage (#379)
- MCP config CRUD + Locale utility coverage (#369)

## [0.5.7] - 2026-03-22

### Added

- **Impact analysis tool** — analyze downstream blast radius of dbt model/column changes across the DAG with severity classification (SAFE/LOW/MEDIUM/HIGH) and actionable recommendations (#350)
- **Training import tool** — bulk import training entries from markdown style guides, glossaries, and playbooks with dry-run preview and capacity management (#350)
- **CI check command** — `/ci-check` template for pre-merge SQL validation that analyzes changed files, checks dbt integrity, and generates CI-friendly reports (#350)
- **`--max-turns` budget limit** — CLI option to cap agent steps for CI/enterprise governance (#350)
- **LM Studio provider** — local Qwen model support via LM Studio (#340)
- **Improved onboarding** — first-time user hints on home screen, beginner-focused tips, practical quickstart examples (#350)
- **Expanded `/discover`** — detects additional cloud warehouse credentials (Snowflake, BigQuery, PostgreSQL, Databricks, Redshift) (#350)
- **Automated test discovery** — `/test-discovery` command for hourly test generation with critic validation (#364, #365, #366, #367)

### Fixed

- Yolo mode now respects explicit deny rules from session config instead of auto-approving everything (#350)
- Training limits increased from 20→50 entries per kind and 16KB→48KB budget for enterprise teams (#350)

### Testing

- E2E tests for trace viewer with adversarial cases (#353)
- Bash tool PATH injection tests (#366)
- `fn()` wrapper and `skillSource` trust classification tests (#367)
- `AsyncQueue`/`work()` utility and `State.invalidate` coverage (#364)

## [0.5.6] - 2026-03-22

### Added

- **Skill CLI command** — new top-level `altimate-code skill` with `list`, `create`, `test`, `show`, `install`, `remove` subcommands for managing AI agent skills and paired CLI tools (#342)
- **`.opencode/tools/` auto-discovery** — executables in `.opencode/tools/` (project) and `~/.config/altimate-code/tools/` (global) are automatically prepended to PATH in BashTool and PTY sessions (#342)
- **TUI skill management** — `/skills` dialog with domain-grouped skill browser, `ctrl+a` action picker (show, edit, test, remove), `ctrl+n` create, `ctrl+i` install from GitHub (#342)
- **Skill install from GitHub** — `altimate-code skill install owner/repo` clones and installs skills; supports GitHub web URLs, shorthand, local paths, and `--global` flag (#342)
- **Skill cache invalidation** — `State.invalidate()` and `Skill.invalidate()` with `GET /skill?reload=true` endpoint for cross-thread cache clearing (#342)
- **Snowflake Cortex AI provider** — use Snowflake Cortex as an AI provider for LLM completions (#349)
- **Telemetry for skill operations** — `skill_created`, `skill_installed`, `skill_removed` events (#342)
- **E2E smoke tests** — committed tests for skill lifecycle, git-tracked protection, symlink safety, GitHub URL normalization (#363)

### Fixed

- Symlink traversal protection during skill install — uses `fs.lstat` to skip symlinks and prevent file disclosure from malicious repos (#342)
- Git-tracked skills cannot be removed via `skill remove` or TUI — prevents accidental deletion of repo-managed skills (#342)
- GitHub web URLs (e.g., `https://github.com/owner/repo/tree/main/path`) correctly normalized to clonable repo URLs (#342)
- `.git` suffix stripped from install source to prevent double-append (#342)
- TUI skill operations use `sdk.directory` + `gitRoot()` instead of `Instance`/`Global` which only exist in the worker thread (#342)
- TUI install uses async `Bun.spawn` instead of blocking `Bun.spawnSync` to keep UI responsive (#342)
- Missing `altimate_change` markers in `dialog-skill.tsx` and `skill.ts` (#341, #344)

## [0.5.5] - 2026-03-20

### Added

- Auto-discover MCP servers from external AI tool configs (VS Code, Cursor, GitHub Copilot, Claude Code, Gemini CLI, Claude Desktop) — discovered project-scoped servers are disabled by default and require explicit approval; home-directory configs are auto-enabled (#311)
- Security FAQ documentation for MCP auto-discovery — covers trust model, security hardening, and how to disable (#346)

### Changed

- `auto_mcp_discovery` now defaults to `true` in config schema via `z.boolean().default(true)` — matches existing runtime behavior (#345)

### Fixed

- Add missing `altimate_change` markers for `experimental` block in `opencode.jsonc` — fixes Marker Guard CI failure on main (#344)

## [0.5.4] - 2026-03-20

### Added

- Show update-available indicator in TUI footer — when a newer version is available, the footer displays `↑ version · altimate upgrade` with responsive layout for narrow terminals (#175)
- Track per-generation token usage in telemetry — emit `generation` event with flat token fields (`tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`) for Azure App Insights compatibility (#336)

### Fixed

- Replace `better-sqlite3` with `bun:sqlite` for schema cache and SQLite driver — fixes `schema_index`, `schema_search`, `schema_cache_status`, and SQLite driver for all users on the released CLI binary (#323)
- Fix marker guard diff parser bug — context lines now correctly update `altimate_change` marker state, preventing false negatives that allowed marker leaks to pass CI (#338)
- Extend marker guard CI to run on push-to-main with zero-SHA guard — closes the gap where individual PRs pass but combined state of `main` has missing markers (#338)
- Add `import.meta.main` guard to `analyze.ts` so test imports don't trigger CLI side effects (#338)
- Add 21 unit tests for marker diff parser and run them in CI (#338)

## [0.5.3] - 2026-03-19

### Fixed

- Bundle skills, dbt-tools, and altimate-setup in shipped npm binary — skills now work in all distribution channels (npm, Homebrew, AUR, Docker) without relying on `postinstall` filesystem copies (#316)
- Exclude 220MB of unused `.node` binaries from dbt-tools bundle (#320)
- Documentation about warehouse connections updated (#318)

### Changed

- Added `altimate_change` markers to upstream-shared files and marker removal detection to CI — prevents markers from being silently stripped (#322)

## [0.5.2] - 2026-03-19

### Added

- Trace history dialog (`/trace` command) — browse, search, and open past session traces from the TUI (#297)
- Docs showcase examples with screenshots (#292)

### Fixed

- TUI trace dialog now respects custom `tracing.dir` config — previously always used default directory (#307)
- WebFetch `clearTimeout` leak — DNS failures no longer leak timer handles (#307)
- WebFetch User-Agent strategy inverted to honest-bot-first — reduces 403 blocks from TLS fingerprint mismatch (#303)
- Snowflake SDK stdout log noise suppressed in TUI via `additionalLogToConsole: false` (#305, #301)
- `cleanTitle` fallback in trace dialog no longer returns empty string (#307)
- Error logging added to `openTraceInBrowser` for debuggability (#307)
- `altimate_change` markers added to `webfetch.ts` for upstream merge compatibility (#307)

### Changed

- Snowflake SDK minimum version bumped to `^2.0.3` for log suppression support (#305)
- Removed brew from docs and README (#299)
- Fixed README typo (`altimate` → `altimate-code`) (#293)

## [0.5.1] - 2026-03-19

### Added

- Simplified agent modes: 3 primary modes (`builder`, `analyst`, `plan`) replacing 7 — cleaner UX with focused roles (#282)
- SQL write access control — `builder` prompts for approval on write queries, `analyst` blocks them entirely, destructive SQL (`DROP DATABASE`, `TRUNCATE`) hard-blocked (#282)
- `core_failure` telemetry with PII-safe input signatures — captures tool failures with masked SQL literals and redacted secrets (#245)
- `peerDependencies` for database drivers in published npm packages (#273)
- Comprehensive docs restructuring with new Changelog, Getting Started, and Tools reference pages (#284)

### Fixed

- Replace `escapeSqlString` with parameterized query binds in `finops/schema` modules (#277)
- Driver error messages now suggest `npm install` instead of `bun add` (#273)
- System prompt traced only once per session to avoid duplication (#287)

### Changed

- Bump `@altimateai/altimate-core` to 0.2.5 — adds Rust-side failure telemetry with PII masking
- Removed 5 agent prompts: `executive`, `migrator`, `researcher`, `trainer`, `validator` (#282)
- README cleanup and updated branding (#288)

## [0.5.0] - 2026-03-18

### Added

- Smooth streaming mode for TUI response rendering (#281)
- Ship builtin skills to customers via `postinstall` (#279)
- `/configure-claude` and `/configure-codex` built-in commands (#235)

### Fixed

- Brew formula stuck at v0.3.1 — version normalization in publish pipeline (#286)
- Harden auth field handling for all warehouse drivers (#271)
- Suppress console logging that corrupts TUI display (#269)

## [0.4.9] - 2026-03-18

### Added

- Script to build and run compiled binary locally (#262)

### Fixed

- Snowflake auth — support all auth methods (`password`, `keypair`, `externalbrowser`, `oauth`), fix field name mismatches (#268)
- dbt tool regression — schema format mismatch, silent failures, wrong results (#263)
- `altimate-dbt compile`, `execute`, and children commands fail with runtime errors (#255)
- `Cannot find module @altimateai/altimate-core` on `npm install` (#259)
- Dispatcher tests fail in CI due to shared module state (#257)

### Changed

- CI: parallel per-target builds — 12 jobs, ~5 min wall clock instead of ~20 min (#254)
- CI: faster release — build parallel with test, lower compression, tighter timeouts (#251)
- Docker E2E tests skip in CI unless explicitly opted in (#253)

## [0.4.1] - 2026-03-16
## [0.4.2] - 2026-03-18

### Breaking Changes

- **Python engine eliminated** — all 73 tool methods now run natively in TypeScript. No Python, pip, venv, or `altimate-engine` installation required. Fixes #210.

### Added

- `@altimateai/drivers` shared workspace package with 10 database drivers (Snowflake, BigQuery, PostgreSQL, Databricks, Redshift, MySQL, SQL Server, Oracle, DuckDB, SQLite)
- Direct `@altimateai/altimate-core` napi-rs bindings — SQL analysis calls go straight to Rust (no Python intermediary)
- dbt-first SQL execution — automatically uses `profiles.yml` connection when in a dbt project
- Warehouse telemetry (5 event types: connect, query, introspection, discovery, census)
- 340+ new tests including E2E tests against live Snowflake, BigQuery, and Databricks accounts
- Encrypted key-pair auth support for Snowflake (PKCS8 PEM with passphrase)
- Comprehensive driver documentation at `docs/docs/drivers.md`

### Fixed

- Python bridge connection failures for UV, conda, and non-standard venv setups (#210)
- SQL injection in finops/schema queries (parameterized queries + escape utility)
- Credential store no longer saves plaintext passwords
- SSH tunnel cleanup on SIGINT/SIGTERM
- Race condition in connection registry for concurrent access
- Databricks DATE_SUB syntax
- Redshift describeTable column name
- SQL Server describeTable includes views
- Dispatcher telemetry wrapped in try/catch
- Flaky test timeouts

### Removed

- `packages/altimate-engine/` — entire Python package (~17,000 lines)
- `packages/opencode/src/altimate/bridge/` — JSON-RPC bridge
- `.github/workflows/publish-engine.yml` — PyPI publish workflow

### Added

- Local-first tracing system replacing Langfuse (#183)

### Fixed

- Engine not found when user's project has `.venv` in cwd — managed venv now takes priority (#199)
- Missing `[warehouses]` pip extra causing FinOps tools to fail with "snowflake-connector-python not installed" (#199)
- Engine install trusting stale manifest when venv/Python binary was deleted (#199)
- Extras changes not detected on upgrade — manifest now tracks installed extras (#199)
- Windows path handling for dev/cwd venv resolution (#199)
- Concurrent bridge startup race condition — added `pendingStart` mutex (#199)
- Unhandled spawn `error` event crashing host process on invalid Python path (#199)
- Bridge hung permanently after ping failure — child process now cleaned up (#199)
- `restartCount` incorrectly incremented on signal kills, prematurely disabling bridge (#199)
- TUI prompt corruption from engine bootstrap messages writing to stderr (#180)
- Tracing exporter timeout leaking timers (#191)
- Feedback submission failing when repo labels don't exist (#188)
- Pre-release security and resource cleanup fixes for tracing (#197)

## [0.4.0] - 2026-03-15

### Added

- Data-viz skill for data storytelling and visualizations (#170)
- AI Teammate training system with learn-by-example patterns (#148)

### Fixed

- Sidebar shows "OpenCode" instead of "Altimate Code" after upstream merge (#168)
- Prevent upstream tags from polluting origin (#165)
- Show welcome box on first CLI run, not during postinstall (#163)

### Changed

- Engine version bumped to 0.4.0

## [0.3.1] - 2026-03-15

### Fixed

- Database migration crash when upgrading from v0.2.x — backfill NULL migration names for Drizzle beta.16 compatibility (#161)
- Install banner not visible during `npm install` — moved output from stdout to stderr (#161)
- Verbose changelog dump removed from CLI startup (#161)
- `altimate upgrade` detection broken — `method()` and `latest()` referenced upstream `opencode-ai` package names instead of `@altimateai/altimate-code` (#161)
- Brew formula detection and upgrade referencing `opencode` instead of `altimate-code` (#161)
- Homebrew tap updated to v0.3.0 (was stuck at 0.1.4 due to expired `HOMEBREW_TAP_TOKEN`) (#161)
- `.opencode/memory/` references in docs updated to `.altimate-code/memory/` (#161)
- Stale `@opencode-ai/plugin` reference in CONTRIBUTING.md (#161)

### Changed

- CI now uses path-based change detection to skip unaffected jobs (saves ~100s on non-TS changes) (#161)
- Release workflow gated on test job passing (#157)
- Upstream merge restricted to published GitHub releases only (#150)

## [0.3.0] - 2026-03-15

### Added

- AI-powered prompt enhancement (#144)
- Altimate Memory — persistent cross-session memory with TTL, namespaces, citations, and audit logging (#136)
- Upstream merge with OpenCode v1.2.26 (#142)

### Fixed

- Sentry review findings from PR #144 (#147)
- OAuth token refresh retry and error handling for idle timeout (#133)
- Welcome banner on first CLI run after install/upgrade (#132)
- `@altimateai/altimate-code` npm package name restored after upstream rebase
- Replace `mock.module()` with `spyOn()` to fix 149 test failures (#153)

### Changed

- Rebrand user-facing references to Altimate Code (#134)
- Bump `@modelcontextprotocol/sdk` dependency (#139)
- Engine version bumped to 0.3.0

## [0.2.5] - 2026-03-13

### Added

- `/feedback` command and `feedback_submit` tool for in-app user feedback (#89)
- Datamate manager — dynamic MCP server management (#99)
- Non-interactive mode for `mcp add` command with input validation
- `mcp remove` command
- Upstream merge with OpenCode v1.2.20

### Fixed

- TUI crash after upstream merge (#98)
- `GitlabAuthPlugin` type incompatibility in plugin loader (#92)
- All test failures from fork restructure (#91)
- CI/CD workflow paths updated from `altimate-code` to `opencode`
- Fallback to global config when not in a git repo
- PR standards workflow `TEAM_MEMBERS` ref corrected from `dev` to `main` (#101)

### Changed

- Removed self-hosted runners from public repo CI (#110)
- Migrated CI/release to ARC runners (#93, #94)
- Reverted Windows tests to `windows-latest` (#95)
- Engine version bumped to 0.2.5

## [0.2.4] - 2026-03-04

### Added

- E2E tests for npm install pipeline: postinstall script, bin wrapper, and publish output (#50)

## [0.2.3] - 2026-03-04

### Added

- Postinstall welcome banner and changelog display after upgrade (#48)

### Fixed

- Security: validate well-known auth command type before execution, add confirmation prompt (#45)
- CI/CD: SHA-pin all GitHub Actions, per-job least-privilege permissions (#45)
- MCP: fix copy-paste log messages, log init errors, prefix floating promises (#45)
- Session compaction: clean up compactionAttempts on abort to prevent memory leak (#45)
- Telemetry: retry failed flush events once with buffer-size cap (#45, #46)
- Telemetry: flush events before process exit (#46)
- TUI: resolve worker startup crash from circular dependency (#47)
- CLI: define ALTIMATE_CLI build-time constants for correct version reporting (#41)
- Address 4 issues found in post-v0.2.2 commits (#49)
- Address remaining code review issues from PR #39 (#43)

### Changed

- CI/CD: optimize pipeline with caching and parallel builds (#42)

### Docs

- Add security FAQ (#44)

## [0.2.2] - 2026-03-05

### Fixed

- Telemetry init: `Config.get()` failure outside Instance context no longer silently disables telemetry
- Telemetry init: called early in CLI middleware and worker thread so MCP/engine/auth events are captured
- Telemetry init: promise deduplication prevents concurrent init race conditions
- Telemetry: pre-init events are now buffered and flushed (previously silently dropped)
- Telemetry: user email is SHA-256 hashed before sending (privacy)
- Telemetry: error message truncation standardized to 500 chars across all event types
- Telemetry: `ALTIMATE_TELEMETRY_DISABLED` env var now actually checked in init
- Telemetry: MCP disconnect reports correct transport type instead of hardcoded `stdio`
- Telemetry: `agent_outcome` now correctly reports `"error"` outcome for failed sessions

### Changed

- Auth telemetry events use session context when available instead of hardcoded `"cli"`

## [0.2.1] - 2026-03-05

### Added

- Comprehensive telemetry instrumentation: 25 event types across auth, MCP servers, Python engine, provider errors, permissions, upgrades, context utilization, agent outcomes, workflow sequencing, and environment census
- Telemetry docs page with event table, privacy policy, opt-out instructions, and contributor guide
- AppInsights endpoint added to network firewall documentation
- `categorizeToolName()` helper for tool classification (sql, schema, dbt, finops, warehouse, lineage, file, mcp)
- `bucketCount()` helper for privacy-safe count bucketing

### Fixed

- Command loading made resilient to MCP/Skill initialization failures

### Changed

- CLI binary renamed from `altimate-code` to `altimate`

## [0.2.0] - 2026-03-04

### Added

- Context management: auto-compaction with overflow recovery, observation masking, and loop protection
- Context management: data-engineering-aware compaction template preserving warehouse, schema, dbt, and lineage context
- Context management: content-aware token estimation (code, JSON, SQL, text heuristics)
- Context management: observation masking replaces pruned tool outputs with fingerprinted summaries
- Context management: provider overflow detection for Azure OpenAI patterns
- CLI observability: telemetry module with session, generation, tool call, and error tracking
- `/discover` command for data stack setup with project_scan tool
- User documentation for context management configuration

### Fixed

- ContextOverflowError now triggers automatic compaction instead of a dead-end error
- `isOverflow()` correctly reserves headroom for models with separate input/output limits
- `NamedError.isInstance()` no longer crashes on null input
- Text part duration tracking now preserves original start timestamp
- Compaction loop protection: max 3 consecutive attempts per turn, counter resets between turns
- Negative usable context guard for models where headroom exceeds base capacity

### Changed

- Removed cost estimation and complexity scoring bindings
- Docs: redesigned homepage with hero, feature cards, and pill layouts
- Docs: reorganized sidebar navigation for better discoverability

## [0.1.10] - 2026-03-03

### Fixed

- Build: resolve @opentui/core parser.worker.js via import.meta.resolve for monorepo hoisting
- Build: output binary as `altimate-code` instead of `opencode`
- Publish: update Docker/AUR/Homebrew references from anomalyco/opencode to AltimateAI/altimate-code
- Publish: make Docker/AUR/Homebrew steps non-fatal
- Bin wrapper: look for `@altimateai/altimate-code-*` scoped platform packages
- Postinstall: resolve `@altimateai` scoped platform packages
- Dockerfile: update binary paths and names

## [0.1.9] - 2026-03-02

### Fixed

- Build: fix solid-plugin import to use bare specifier for monorepo hoisting
- CI: install warehouse extras for Python tests (duckdb, boto3, etc.)
- CI: restrict pytest collection to tests/ directory
- CI: fix all ruff lint errors in Python engine
- CI: fix remaining TypeScript test failures (agent rename, config URLs, Pydantic model)
- Update theme schema URLs and documentation references to altimate-code.dev

## [0.1.8] - 2026-03-02

### Changed

- Rename npm scope from `@altimate` to `@altimateai` for all packages
- Wrapper package is now `@altimateai/altimate-code` (no `-ai` suffix)

### Fixed

- CI: test fixture writes config to correct filename (`altimate-code.json`)
- CI: add `dev` optional dependency group to Python engine for pytest/ruff

## [0.1.7] - 2026-03-02

### Changed

- Improve TUI logo readability: redesign M, E, T, I letter shapes
- Add two-tone logo color: ALTIMATE in peach, CODE in purple

### Fixed

- Release: npm publish glob now finds scoped package directories
- Release: PyPI publish skips existing versions instead of failing

## [0.1.5] - 2026-03-02

### Added

- Anthropic OAuth plugin ported in-tree
- Docs site switched from Jekyll to Material for MkDocs

### Fixed

- Build script: restore `.trim()` on models API JSON to prevent syntax error in generated `models-snapshot.ts`
- Build script: fix archive path for scoped package names in release tarball/zip creation

## [0.1.0] - 2025-06-01

### Added

- Initial open-source release
- SQL analysis and formatting via Python engine
- Column-level lineage tracking
- dbt integration (profiles, lineage, `+` operator)
- Warehouse connectivity (Snowflake, BigQuery, Databricks, Postgres, DuckDB, MySQL)
- AI-powered SQL code review
- TUI interface with Solid.js
- MCP (Model Context Protocol) server support
- Auto-bootstrapping Python engine via uv
