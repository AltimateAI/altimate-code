---
title: "Telemetry — Altimate Code"
description: "Altimate Code collects anonymous usage telemetry by default. See what's collected and how to opt out."
---
# Telemetry

Altimate Code collects anonymous usage data to help us improve the product. This page describes what we collect, why, and how to opt out.

## What We Collect

We collect the following categories of events:

| Event | Description |
|-------|-------------|
| `session_start` | A new CLI session begins |
| `session_end` | A CLI session ends (includes duration) |
| `session_forked` | A session is forked from an existing one |
| `generation` | An AI model generation (step) completes — model ID, provider ID, agent, finish reason, cost, duration, and token breakdown: input, output, and when available: reasoning tokens (reasoning models only), cache-read tokens (prompt cache hit), cache-write tokens (new cache entry). No prompt content. |
| `tool_call` | A tool is invoked (tool name and category — no arguments or output) |
| `native_call` | A native engine call completes (method name and duration — no arguments) |
| `command` | A CLI command is executed (command name only) |
| `error` | An unhandled error occurs (error type and truncated message, but no stack traces) |
| `auth_login` | Authentication succeeds or fails (provider and method, but no credentials) |
| `auth_logout` | A user logs out (provider only) |
| `mcp_server_status` | An MCP server connects, disconnects, or errors (server name and transport) |
| `provider_error` | An AI provider returns an error (error type and HTTP status, but no request content) |
| `engine_started` | The native tool engine initializes (version and duration) |
| `engine_error` | The native tool engine fails to start (phase and truncated error) |
| `upgrade_attempted` | A CLI upgrade is attempted (version and method) |
| `permission_denied` | A tool permission is denied (tool name and source) |
| `doom_loop_detected` | A repeated tool call pattern is detected (tool name and count) |
| `compaction_triggered` | Context compaction runs (strategy and token counts) |
| `tool_outputs_pruned` | Tool outputs are pruned during compaction (count) |
| `environment_census` | Environment snapshot on project scan (warehouse types, dbt presence, dbt materialization distribution, snapshot/seed counts, feature flags, but no hostnames or project names) |
| `context_utilization` | Context window usage per generation (token counts, utilization percentage, cache hit ratio) |
| `agent_outcome` | Agent session outcome (agent type, tool/generation counts, cost, outcome status). Also includes diagnostic fields populated for non-completed outcomes: `final_tool` (last tool name, including MCP-namespaced like `mcp__atlassian__getJiraIssue`), `error_class` (classified via `classifyError` patterns or `unknown`), and `reason` (PII-masked error message — capped at 500 chars for `error`, 200 chars for `aborted`; `no_tools_invoked` for `abandoned`; `user_cancelled` fallback when no explicit reason). API key prefixes (`sk-`, `sk-ant-`, `Bearer …`) are redacted at extraction. |
| `error_recovered` | Successful recovery from a transient error (error type, strategy, attempt count) |
| `mcp_server_census` | MCP server capabilities after connect (tool and resource counts, but no tool names) |
| `context_overflow_recovered` | Context overflow is handled (strategy) |
| `skill_used` | A skill is loaded (skill name, source — `builtin`, `global`, or `project`, and trigger — `user`, `auto`, or `suggestion` — no skill content) |
| `plan_revision` | A plan revision occurs in Plan mode (revision_number, action: `refine`, `approve`, `reject`, or `cap_reached`) |
| `feature_suggestion` | A post-connection feature suggestion is shown (suggestion_type, suggestions_shown, warehouse_type — no user input) |
| `sql_execute_failure` | A SQL execution fails (warehouse type, query type, error message, PII-masked SQL — no raw values) |
| `core_failure` | An internal tool error occurs (tool name, category, error class, truncated error message, PII-safe input signature, and optionally masked arguments — no raw values or credentials) |
| `first_launch` | Fired once on first CLI run after installation. Contains version and is_upgrade flag. No PII. |
| `task_outcome_signal` | Behavioral quality signal at session end — accepted, error, abandoned, or cancelled. Includes tool count, step count, duration, and last tool category. No user content. |
| `task_classified` | Intent classification of the first user message using keyword matching — category (e.g. `debug_dbt`, `write_sql`, `optimize_query`), confidence score, and detected warehouse type. No user text is sent — only the classified category. |
| `tool_chain_outcome` | Aggregated tool execution sequence at session end — ordered tool names (capped at 50), error count, recovery count, final outcome, duration, and cost. No tool arguments or outputs. |
| `error_fingerprint` | Hashed error pattern for anonymous grouping — SHA-256 hash of masked error message, error class, tool name, and whether recovery succeeded. Raw error content is never sent. |
| `sql_fingerprint` | SQL structural shape via AST parsing — statement types, table count, function count, subquery/aggregation/window function presence, and AST node count. No table names, column names, or SQL content. |
| `schema_complexity` | Warehouse schema structural metrics from introspection — bucketed table, column, and schema counts plus average columns per table. No schema names or content. |
| `validator_check` | A completion-gate validator ran on session end — validator name, `ok` boolean, step, retry count, `enforced` flag (false in shadow mode), and structured `details` (model counts, elapsed time, concurrency limit — no SQL or model content). Only emitted when `ALTIMATE_VALIDATORS_ENABLED=1` or `ALTIMATE_VALIDATORS_SHADOW=1`. See [Validators](../data-engineering/validators.md). |
| `validator_retries_exhausted` | A session terminated with unresolved validator failures after exhausting the synthetic-retry budget — names of the failing validators (no failure body content). |
| `onboarding_started` | The first-run setup gate opened (fresh launch with no usable model). |
| `model_picker_shown` | The provider picker was displayed. `trigger` distinguishes the first run from `/connect`, from declining Big Pickle, and from the prompt gate. |
| `provider_selected` | A provider row was chosen — `altimate_gateway`, `altimate_free`, `anthropic`, `openai`, `google`, `big_pickle`, `search_all`, or `other` for anything outside the curated set. `provider_id` carries the raw id only for publicly-known providers, so a provider you named yourself in config is reported as `other` with no name attached. `via_search` marks a pick made inside the full catalogue after choosing "Search all providers…". **Choosing search emits this event twice for one user** — once as `search_all`, then again with the provider actually chosen — so count distinct users or filter on `via_search`, not raw event count. Recorded at the moment of choice, so a sign-in that is then cancelled still counts. |
| `big_pickle_confirm_shown` / `big_pickle_choice` | The Big Pickle interstitial was shown, and what the user decided (`accept`/`cancel`). |
| `free_gemini_confirm_shown` / `free_gemini_choice` | The Gemini Flash (Free) disclosure interstitial was shown, and what the user decided (`accept`/`cancel`). Every dismissal that is not an explicit accept — Escape, click-away, picking another row — is recorded as `cancel`. |
| `free_gemini_register_result` | The outcome of the free-tier registration that runs after an `accept`: `success`, `rate_limited` (gateway velocity limit), `unavailable` (gateway maintenance or kill switch), `network` (gateway unreachable), or `error`. Never carries error text. |
| `gateway_device_code_issued` | The Altimate Gateway authorize URL was built and the browser open attempted. **Name note:** the flow is a browser loopback OAuth — there is no device code. The name follows the original event spec. |
| `gateway_auth_completed` / `gateway_auth_failed` | Gateway sign-in outcome. `reason` is `timeout`, `denied`, or `error` — never the underlying message, which can contain the instance name. An unrecognised callback state does not reject the pending attempt, so a CSRF mismatch surfaces as `timeout`. |
| `instance_connected` | Credentials received and saved. `time_to_connect_ms` runs from the start of the authorize call, so it includes the browser launch. No instance or tenant name is sent. |
| `onboarding_completed` | A model is ready and chat is live. |
| `scan_gate_shown` / `scan_gate_choice` | The "scan your environment?" gate appeared, and what the user did — `scan`, `skip`, or `dismissed` (esc / click-away). |
| `environment_scan_completed` | A `project_scan` finished during onboarding — `has_dbt`, `has_warehouse`, `is_repo`, `connections_found`, and a bounded list of short `degraded` detection keys. No paths, hostnames, or connection details. Emitted only inside an onboarding session, and only once per session, so scans from `/discover` or a model-initiated call are excluded. |
| `sample_setup_completed` | The sample dbt project was materialised. `success`, `models`, `tables`, and `reused` — the tool is deliberately re-callable, so this is per invocation. The target path is never sent. |
| `activation_menu_shown` | The activation menu was (very likely) rendered. `variant` is `warehouse` or `no_data`. **Derived** — see the note below. |
| `activation_job_selected` / `first_job_completed` | Which activation job the user started and, where observable, finished. Completion is reported only for the job that was actually selected, so the two form a coherent pair. **Derived** — see the note below. |
| `first_prompt_sent` | The user's first typed message in an onboarding session. Slash commands are excluded, so the hidden `/onboard-connect` submission does not count. |
| `onboarding_abandoned` | The CLI exited during a first run without connecting. `last_stage` is the furthest point reached: `started`, `model_picker`, `provider_setup`, `big_pickle_confirm`, `free_gemini_confirm`, or `gateway_auth`. (`connected` is a funnel position but never a `last_stage` — reaching it means the run completed, which is not an abandonment.) Only emitted for a genuine first run — opening `/connect` as an existing user does not enter the funnel, and abandonment after setup completes is out of scope by definition. Emitted on the exit path under a bounded flush, so the measured rate is a lower bound — see [Delivery & Reliability](#delivery--reliability). |
| `review_run` | A dbt/SQL review completed or failed — `invocation` (`cli` for `altimate-code review`, `tool` for the `dbt_pr_review` tool), status, duration, and on success the verdict, the pre-gating verdict, mode, risk tier, and finding counts by severity and by category. No file paths, model or column names, finding titles or bodies, SQL, diff content, or repository/branch/PR names. |
| `review_post_outcome` | Whether a review was published to GitHub — `not_requested`, `not_attempted`, `target_unresolved`, `full`, `partial`, or `summary_failed`, plus duration. Emitted on the **CLI path only** — the `dbt_pr_review` tool completes reviews but never publishes, so a `review_run` with `invocation: tool` has no post event and that is not a failure. Within the CLI path there is exactly one per **completed** review: a review that failed emits `review_run: failed` and no post event, so absence there means the review failed rather than that an event was lost. `not_attempted` is publication requested but never reached (a bad `--output` path, a stdout write error). No repository, PR, or comment content. |

Each event includes a timestamp, anonymous session ID, a per-launch correlation ID (`launch_id` — a random value regenerated every process start, not persisted and not derived from your machine or identity; it exists only to group events from the same run), CLI version, and an anonymous machine ID (a random UUID stored in `~/.altimate/machine-id`, generated once and never tied to any personal information).

### Notes on the review events

- `degraded` is a fidelity flag, not a warehouse flag. It is set when a review found no reviewable
  files, had no usable manifest for the changed models, or surfaced a finding whose analysis was
  undecidable. It does not mean "no warehouse was connected".
- The category breakdown counts findings that were actually surfaced — after de-duplication, rubric
  exclusion, and the severity threshold. It is not a count of raw rule detections, and it is grouped
  by category rather than by individual rule.
- Reviews run through the `dbt_pr_review` tool also emit the standard `tool_call` event. They are
  the same review; count `review_run` rather than both.

### A note on the derived activation events

`activation_menu_shown`, `activation_job_selected`, and `first_job_completed` are **inferred, not observed**. The activation menu is not a UI element: it is text the model writes from a prompt template, and the user picks a job by replying in free text. Nothing in the CLI can see either moment directly.

They are therefore inferred from the closest deterministic signals — the menu from the command dispatch or the completed environment scan, the job from the first matching tool or skill invocation that follows. Treat the counts as **lower bounds**, and note two specific gaps:

- The "something else" branch has no tool signature at all and is never counted.
- `first_job_completed` only fires for jobs with a real completion signal. Skill-driven jobs (downstream impact, SQL review, cost) load an instruction bundle and then do their work through other tools, so their completion is not observable and they are absent from this event rather than wrongly counted in it.

## Delivery & Reliability

Telemetry events are buffered in memory and flushed periodically. If a flush fails (e.g., due to a transient network error), events are re-added to the buffer for one retry. On process exit, the CLI performs a final flush to avoid losing events from the current session.

No events are ever written to disk. If the process is killed before the final flush, buffered events are lost. This is by design to minimize on-disk footprint.

The final flush is **time-bounded** so that quitting never hangs the shell: 2 seconds on the main thread and 5 seconds in the TUI worker. When that budget expires the in-flight request is aborted and its events are dropped rather than retried — a retry would only re-queue them into a buffer that is cleared moments later, to be shipped under the next launch's correlation id.

The practical consequence is a known bias, not a silent one: events emitted **on the exit path** are the most likely to be lost on a slow or unreachable network, and `onboarding_abandoned` is emitted *only* on that path. So a measured abandonment rate is a **lower bound** — under-reporting is the failure mode, never over-reporting, since a dropped event can only remove an abandonment from the count. Read drop-off numbers as a floor, and treat a change in them as meaningful only if network conditions are comparable.

## Why We Collect Telemetry

Telemetry helps us:

- **Detect errors** by identifying crashes, provider failures, and engine issues before users report them
- **Improve reliability** by tracking MCP server stability, engine initialization, and upgrade outcomes
- **Understand usage patterns** to know which tools and features are used so we can prioritize development
- **Measure performance** by tracking generation latency, tool call duration, and startup time

## Disabling Telemetry

To disable all telemetry collection, add this to your configuration file (`~/.config/altimate-code/altimate-code.json`):

```json
{
  "telemetry": {
    "disabled": true
  }
}
```

You can also set the environment variable:

```bash
export ALTIMATE_TELEMETRY_DISABLED=true
```

When telemetry is disabled, no events are sent and no network requests are made to the telemetry endpoint.

### Test runs are excluded

Test runners never reach the default telemetry endpoint. Telemetry is suppressed when `NODE_ENV=test`,
`BUN_TEST`, `VITEST`, or `JEST_WORKER_ID` is present. This exists because test processes regenerate
their machine ID on every run, so without the exclusion they dominate install and active-machine counts.

Running in CI is **not** excluded — that is ordinary product usage (for example
[altimate-code-actions](https://github.com/AltimateAI/altimate-code-actions) wraps this CLI), so
`CI` and `GITHUB_ACTIONS` on their own do not suppress anything.

Two escape hatches exist for reporting from a test run deliberately:

- Set `APPLICATIONINSIGHTS_CONNECTION_STRING` to your own endpoint — an explicitly-configured sink
  is always honoured, which is how the project's own telemetry tests work.
- Set `ALTIMATE_TELEMETRY_FORCE=true` to use the default endpoint anyway.

`ALTIMATE_TELEMETRY_DISABLED` and the config opt-out take precedence over both.

## Privacy

We take your privacy seriously. Altimate Code telemetry **never** collects:

- SQL queries or query results
- Code content, file contents, or file paths
- Credentials, API keys, or tokens
- Database connection strings or hostnames
- Personally identifiable information (your email is SHA-256 hashed before sending and is used only for anonymous user correlation)
- Tool arguments or outputs
- AI prompt content or responses

Error messages are truncated to 500 characters and scrubbed of file paths before sending.

### New User Identification

Altimate Code uses two types of anonymous identifiers for analytics, depending on whether you are logged in:

- **Anonymous users (not logged in):** A random UUID is generated using `crypto.randomUUID()` on first run and stored at `~/.altimate/machine-id`. This ID is not tied to your hardware, operating system, or identity — it is purely random and serves only to distinguish one machine from another in aggregate analytics.
- **Logged-in users (OAuth):** Your email address is SHA-256 hashed before sending. The raw email is never transmitted.

Both identifiers are only sent when telemetry is enabled. Disable telemetry entirely with `ALTIMATE_TELEMETRY_DISABLED=true` or the config option above.

The [Gemini Flash (Free)](../configure/providers.md#gemini-flash-free) tier uses a **separate** identifier, deliberately not the machine ID above: a random secret minted only when you accept its disclosure, stored with your other credentials, and sent to the free-tier gateway only as a SHA-256 hash. It exists to hold that install's usage budget, and it is never used for telemetry — the two datasets are not joined. Declining the free model, or never opening it, means the identifier is never created.

### CLI Authentication Flow

When you sign in using the CLI browser auth flow (`altimate auth login`), the anonymous machine ID (a random UUID persisted at `~/.altimate/machine-id` — a device/installation identifier, reused across sessions) is included in the authorization URL and associated with your account in product analytics. This is used solely to correlate CLI install events with authenticated accounts in aggregate funnel analytics — it is not used for advertising or cross-site tracking. Your telemetry opt-out suppresses this: when you disable telemetry — via `ALTIMATE_TELEMETRY_DISABLED=true` **or** the `telemetry.disabled` config option — the machine ID is omitted from the authorization URL entirely. The machine ID is associated with your account in PostHog for this funnel analysis, separate from the Azure Application Insights pipeline used for other CLI telemetry events.

### Data Retention

Telemetry data is sent to Azure Application Insights and retained according to [Microsoft's data retention policies](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure). Aside from the PostHog auth-attribution described above, we do not maintain a separate data store for event telemetry. To request deletion of your telemetry data, contact privacy@altimate.ai.

## Network

Telemetry data is sent to Azure Application Insights:

| Endpoint | Purpose |
|----------|---------|
| `eastus-8.in.applicationinsights.azure.com` | Telemetry ingestion |

For a complete list of network endpoints, see the [Network Reference](network.md).

## For Contributors

### Naming Convention

Event type names use **snake_case** with a `domain_action` pattern:

- `auth_login`, `auth_logout` for authentication events
- `mcp_server_status`, `mcp_server_census` for MCP server lifecycle
- `engine_started`, `engine_error` for native engine events
- `provider_error` for AI provider errors
- `session_forked` for session lifecycle
- `environment_census` for environment snapshot events
- `context_utilization`, `context_overflow_recovered` for context management events
- `agent_outcome` for agent session events
- `error_recovered` for error recovery events
- `task_outcome_signal`, `task_classified` for session quality signals
- `tool_chain_outcome` for tool execution chain aggregation
- `error_fingerprint` for anonymous error pattern grouping
- `sql_fingerprint` for SQL structural analysis
- `schema_complexity` for warehouse schema metrics

### Adding a New Event

1. **Define the type** — Add a new variant to the `Telemetry.Event` union in `packages/opencode/src/altimate/telemetry/index.ts`
2. **Emit the event** — Call `Telemetry.track()` at the appropriate location
3. **Update docs** — Add a row to the event table above

### Privacy Checklist

Before adding a new event, verify:

- [ ] No SQL, code, or file contents are included
- [ ] No credentials or connection strings are included
- [ ] Error messages are truncated to 500 characters
- [ ] File paths are not included in any field
- [ ] Only tool names are sent, never arguments or outputs
