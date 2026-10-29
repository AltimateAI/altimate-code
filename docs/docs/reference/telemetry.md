---
title: "Telemetry — Altimate Code"
description: "Altimate Code collects usage telemetry by default. See what's collected, what identifies you when you sign in, and how to opt out."
---
# Telemetry

Altimate Code collects usage data to help us improve the product. Events from a machine that is not signed in to Altimate are anonymous; once you sign in, events also carry your Altimate user ID and tenant (see [User Identification](#new-user-identification)). This page describes what we collect, why, and how to opt out.

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
| `skill_used` | A skill is loaded (skill name, source — `builtin`, `global`, `project`, or `workspace`, and trigger — `user`, `auto`, or `suggestion` — no skill content) |
| `plan_revision` | A plan revision occurs in Plan mode (revision_number, action: `refine`, `approve`, `reject`, or `cap_reached`) |
| `feature_suggestion` | A post-connection feature suggestion is shown (suggestion_type, suggestions_shown, warehouse_type — no user input) |
| `sql_execute_failure` | A SQL execution fails (warehouse type, query type, error message, PII-masked SQL — no raw values) |
| `core_failure` | An internal tool error occurs (tool name, category, error class, truncated error message, PII-safe input signature, and optionally masked arguments — no raw values or credentials) |
| `first_launch` | Fired once on the first CLI run after an install or upgrade, triggered by a marker file the installer wrote — the installers themselves send nothing and contact no telemetry endpoint. Contains the installed version, `is_upgrade`, and `install_method` (`curl`, `powershell`, `npm`, `vscode-extension`, `local` for `install --binary`, or `unknown` for markers written before the field existed). `vscode-extension` starts appearing only once an extension build containing the marker write ships, so a zero share for it means the extension has not rolled out yet rather than no extension installs. No PII. **Reading `is_upgrade`:** it means "this machine had run altimate-code before", probed as whether `~/.altimate/machine-id` already existed — *not* "a binary was already present". A reinstall onto a machine that ever ran the CLI reports `is_upgrade: true`, and `altimate uninstall` leaves `machine-id` in place, so a metric excluding upgrades counts installs **per previously-unseen machine** and undercounts reinstalls onto known ones. (`is_upgrade` is a boolean in the event schema; it arrives in Application Insights `customDimensions` as a string, so KQL filters read `tostring(customDimensions.is_upgrade) != "true"`.) Delivery is at-most-once: the marker is deleted before the event flushes, so a process that dies first loses that install rather than re-firing it every launch. Local `--binary` installs report `version: "local"`. |
| `startup_ready` | Fired once per process when the top-level command can serve its first request or frame (`serve` listening, TUI transport resolved, `run` about to send its first prompt). Contains the command name, `duration_ms` since process start, and `fresh_install` (true when this process also emitted a non-upgrade `first_launch`). No PII. |
| `client_connected` | Fired once per process when the first client attaches to a running server, which separates "the backend started but no client connected" from "connected but never sent a message". Contains `surface` (the launching command: `serve`, `run` or `tui`, also sent on `startup_ready`) and `since_start_ms`. No PII. |
| `event_loop_stall` | A 250 ms monitor tick fired more than 1 s late, meaning the event loop was blocked for that long (for example an in-process dependency install). Contains the command name, `thread` (`main` or `worker`), `blocked_ms`, and `since_start_ms`. Capped at 20 per thread (the main thread and the TUI server worker each keep their own counter). No PII. |
| `altimate_base_registration` | Timing and outcome of each Altimate Base registration, whether triggered automatically at startup, by an explicit picker selection, or through the `POST /altimate/base/register` route an IDE calls (`origin: "server"`) (concurrent calls share one result, and a still-valid cached credential reports `success` without a network round trip): `result` (`success`, `network`, `http`, `response`, `cancelled`, `configuration`, or `error`), `duration_ms`, and the HTTP `status` when the result is `http`. Distinct from `altimate_base_register_result`, which records the onboarding-flow outcome. No gateway URL, response body, credential, or error text is included. |
| `task_outcome_signal` | Behavioral quality signal at session end — accepted, error, abandoned, or cancelled. Includes tool count, step count, duration, and last tool category. No user content. |
| `task_classified` | Intent classification of the first user message using keyword matching — category (e.g. `debug_dbt`, `write_sql`, `optimize_query`), confidence score, and detected warehouse type. No user text is sent — only the classified category. |
| `tool_chain_outcome` | Aggregated tool execution sequence at session end — ordered tool names (capped at 50), error count, recovery count, final outcome, duration, and cost. No tool arguments or outputs. |
| `error_fingerprint` | Error pattern for grouping — SHA-256 hash of the masked error message, error class, tool name, whether recovery succeeded, plus `error_message`. `error_message` contains only words from a fixed list of common error terms taken from the first line of the error; every other word is replaced with `<x>`, so no user text, identifiers, paths, values or SQL can appear (max 200 characters). |
| `sql_fingerprint` | SQL structural shape via AST parsing — statement types, table count, function count, subquery/aggregation/window function presence, and AST node count. No table names, column names, or SQL content. |
| `schema_complexity` | Warehouse schema structural metrics from introspection — bucketed table, column, and schema counts plus average columns per table. No schema names or content. |
| `validator_check` | A completion-gate validator ran on session end — validator name, `ok` boolean, step, retry count, `enforced` flag (false in shadow mode), and structured `details` (model counts, elapsed time, concurrency limit — no SQL or model content). Only emitted when `ALTIMATE_VALIDATORS_ENABLED=1` or `ALTIMATE_VALIDATORS_SHADOW=1`. See [Validators](../data-engineering/validators.md). |
| `validator_retries_exhausted` | A session terminated with unresolved validator failures after exhausting the synthetic-retry budget — names of the failing validators (no failure body content). |
| `onboarding_started` | The first-run setup gate opened (fresh launch with no usable model). |
| `model_picker_shown` | The provider picker was displayed. `trigger` distinguishes the first run from `/connect` and from the prompt gate (`altimate_base_back` is defined in the schema but no longer emitted — it recorded backing out of the old consent dialog, which no longer exists). |
| `provider_selected` | A provider row was chosen — `altimate_gateway`, `altimate_base`, `anthropic`, `openai`, `google`, `search_all`, or `other` for anything outside the curated five. `provider_id` carries the raw id only for publicly-known providers, so a provider you named yourself in config is reported as `other` with no name attached. `via_search` marks a pick made inside the full catalogue after choosing "Search all providers…". **Choosing search emits this event twice for one user** — once as `search_all`, then again with the provider actually chosen — so count distinct users or filter on `via_search`, not raw event count. Recorded at the moment of choice, so a sign-in that is then cancelled still counts. |
| `altimate_base_confirm_shown` / `altimate_base_choice` | Legacy — defined in the event schema but no longer emitted. These recorded the old consent dialog (shown, then `accept`/`cancel`), removed once Altimate Base moved to auto-registration with no confirmation step. |
| `altimate_base_register_result` | The registration outcome from a picker-driven selection (the welcome picker, the full catalogue, or the provider dialog): `success`, `rate_limited`, `unavailable`, `network`, or `error`. Optional `origin` is `welcome`, `model`, or `migration` (returning free-default users offered Altimate Base). Auto-registration at startup is reported separately, by `altimate_base_registration` above. No credential or gateway response body is included. |
| `gateway_device_code_issued` | The Altimate Gateway authorize URL was built and the browser open attempted. **Name note:** the flow is a browser loopback OAuth — there is no device code. The name follows the original event spec. |
| `gateway_auth_completed` / `gateway_auth_failed` | Gateway sign-in outcome. `reason` is `timeout`, `denied`, or `error` — never the underlying message, which can contain the instance name. An unrecognised callback state does not reject the pending attempt, so a CSRF mismatch surfaces as `timeout`. |
| `instance_connected` | Credentials received and saved. `time_to_connect_ms` runs from the start of the authorize call, so it includes the browser launch. The event names no instance itself; like every event sent after sign-in, it carries the account's `user_id` and `tenant` once they are resolved (see [User Identification](#new-user-identification)). |
| `onboarding_completed` | A model is ready and chat is live. |
| `telemetry_opted_out` | The last event from a machine that turns telemetry off, sent once (see [Disabling Telemetry](#disabling-telemetry)). Contains `opt_out_source` (`env` for an environment variable, `config` for `telemetry.disabled`), the machine ID, the CLI version and the client. It carries no account (`user_id`, `tenant`), project, session or launch ID. |
| `scan_gate_shown` / `scan_gate_choice` | The "scan your environment?" gate appeared, and what the user did — `scan`, `skip`, or `dismissed` (esc / click-away). |
| `environment_scan_completed` | A `project_scan` finished during onboarding — `has_dbt`, `has_warehouse`, `is_repo`, `connections_found`, and a bounded list of short `degraded` detection keys. No paths, hostnames, or connection details. Emitted only inside an onboarding session, and only once per session, so scans from `/discover` or a model-initiated call are excluded. |
| `sample_setup_completed` | The sample dbt project was materialised. `success`, `models`, `tables`, and `reused` — the tool is deliberately re-callable, so this is per invocation. The target path is never sent. |
| `activation_menu_shown` | The activation menu was (very likely) rendered. `variant` is `warehouse` or `no_data`. **Derived** — see the note below. |
| `activation_job_selected` / `first_job_completed` | Which activation job the user started and, where observable, finished. Completion is reported only for the job that was actually selected, so the two form a coherent pair. **Derived** — see the note below. |
| `first_prompt_sent` | The user's first typed message in an onboarding session. Slash commands are excluded, so the hidden `/onboard-connect` submission does not count. |
| `onboarding_abandoned` | The CLI exited during a first run without connecting. `last_stage` is the furthest point reached: `started`, `model_picker`, `provider_setup`, `altimate_base_confirm`, or `gateway_auth`. (`connected` is a funnel position but never a `last_stage` — reaching it means the run completed, which is not an abandonment.) Only emitted for a genuine first run — opening `/connect` as an existing user does not enter the funnel, and abandonment after setup completes is out of scope by definition. Emitted on the exit path under a bounded flush, so the measured rate is a lower bound — see [Delivery & Reliability](#delivery--reliability). |
| `review_run` | A dbt/SQL review completed or failed — `invocation` (`cli` for `altimate-code review`, `tool` for the `dbt_pr_review` tool), status, duration, and on success the verdict, the pre-gating verdict, mode, risk tier, and finding counts by severity and by category. No file paths, model or column names, finding titles or bodies, SQL, diff content, or repository/branch/PR names. |
| `review_post_outcome` | Whether a review was published to GitHub — `not_requested`, `not_attempted`, `target_unresolved`, `full`, `partial`, or `summary_failed`, plus duration. Emitted on the **CLI path only** — the `dbt_pr_review` tool completes reviews but never publishes, so a `review_run` with `invocation: tool` has no post event and that is not a failure. Within the CLI path there is exactly one per **completed** review: a review that failed emits `review_run: failed` and no post event, so absence there means the review failed rather than that an event was lost. `not_attempted` is publication requested but never reached (a bad `--output` path, a stdout write error). No repository, PR, or comment content. |
| `rule_proposal_shown` | A proposed-rule card was shown (or shown again for the same wording, `repeat`) — what raised it (`remember`, `shown_rule`, `recurrence`), the kind of change, whether it is a "Save as" choice, linked/owner, the buttons offered, whether it weakens verification, evidence session count, whether it came from a correction, how many paths it applies to, and its length. The card id is random. No rule text, quotes, paths or globs. |
| `rule_proposal_answered` | A card was answered or closed (`send`, `approve`, `approve_anyway`, `edit`, `dismiss`, `save_local`, `save_memory`, `expired`, `closed`) — `ok` or why it did not go through (`busy`, `not_available`, `verification_flagged`, `invalid_text`, `failed`), what happened (`sent`, `queued`, `approved`, `approve_failed`, `approve_retry`, `target_changed`, `exists`, `dismissed`, `saved_memory_project`, `saved_memory_global`, `saved_local`), wording edits so far, and time since the card was shown. No rule text. |
| `rule_proposal_skipped` | Corrections were checked after a turn and no card was shown — `card_open`, `no_renderer` (no attached client shows cards; the corrections are kept for a later check), `covered`, `no_draft`, `topic_dismissed`, `no_topic` or `failed`. The path checked (`shown_rule` or `recurrence`) is omitted when the check stopped before choosing one. |
| `rule_remember_routed` | Where a "remember …" save went — through `training_save` or the memory tool, to a card, a "Save as" card, memory, refused as not a one-line rule, or saved as before cards because learning/workspaces are off, the project is not linked, or no attached client shows cards. No text. |
| `rules_sync` | One rules sync — what started it (`refresh`, `session_start`, `manual`, `card`, `cli`, `import`), `ok` (the pull worked and every proposal to send went out), `failed` (a failed pull, proposals kept queued, or a run that threw: reason `error`), `off` or `skipped` with a fixed reason code, duration, and counts of rules, pending reviews, proposals sent, refused and still queued, review notices, and usage items. No rule text, error text, URLs or workspace names. |
| `rules_delivered` | Rules added to a session's context — at the start, for a request, or for a file the agent touched — with the number of rules (and how many are team rules), their total length, the session's running total, and the token budget. No rule text or file paths. |
| `rules_learning_changed` | The person turned learning from sessions on or off for a project, or back to the workspace's setting, with the resulting state and who decides it. |
| `rules_command` | `/rules` opened in a client (`view`), or a `learn` subcommand run (its name only, never its arguments). |

Each event includes a timestamp, session ID, a per-launch correlation ID (`launch_id` — a random value regenerated every process start, not persisted and not derived from your machine or identity; it exists only to group events from the same run), CLI version, and a machine ID (a random UUID stored in `~/.altimate/machine-id`, generated once and not derived from your hardware or identity). When the machine is signed in to Altimate, each event also carries `user_id` and `tenant`, described under [User Identification](#new-user-identification).

### Workspace events

These events describe projects linked to an Altimate workspace. A workspace is identified only by its numeric id (`workspace_id`, or `to_workspace_id` and `from_workspace_id` on a switch). No workspace name, project path, repository remote, skill content, memory content or prompt text is sent.

| Event | Description |
|-------|-------------|
| `workspace_linked` | A project was linked to a workspace and the server confirmed it. `how` is `bind_existing`, `create_and_bind`, `rebind_remote` or `rebind_path`. |
| `workspace_created` | A workspace was created from the CLI or the TUI. `how` is `create_and_bind`, or `create_unbound` when the link follows as a separate step. |
| `workspace_link_failed` | A link step failed. `how` names the step, and `reason` is a class: `auth`, `not_found`, `network`, `conflict` or `other`. No error text. |
| `workspace_unlinked` | A project was unlinked, with the workspace id when the CLI knew it. |
| `workspace_switched` | A linked project was moved to another workspace. `how` is `rebind_remote` or `rebind_path`. |
| `workspace_auth_expired` | A workspace call was answered 401: the sign-in has expired. Carries `endpoint` and `status`. |
| `workspace_api_error` | A workspace call failed. `status_class` is `4xx`, `5xx`, `network`, `timeout`, or `response` (a success status with an empty or unreadable body), plus the HTTP `status` when there was one. A 403 is reported here, not as expired auth. A status the caller handles as an answer is not a failure and is not reported, such as a 404 from the link lookups ("not linked") or from an unlink ("already unlinked"). `GET /users/me` is not a workspace call and is not reported. |
| `starter_shown` | The "what this workspace provides" starter was served after a link: to the TUI, to the IDE extension's chat, or printed by `altimate-code link`. It counts the starter being served, so a client that closes before rendering it is still counted. Contains the counts of skills and integrations when known, `knowledge` (`off`, `all`, `selected` or `unknown`) and `memory_enabled`. |
| `starter_action_picked` | The user chose an option from the TUI starter: `action` is `prompt`, `open` or `done`, with `prompt_index` (its position) for a suggested prompt. Never the prompt's text. |
| `workspace_memory_contributed` | A memory block was written back to the workspace's shared memory, including the existing blocks seeded when a project is linked. `block_count` is per write. No memory content. |
| `workspace_sync_failed` | Syncing the workspace's skills or memory to this project changed to failing. `kind` is `skills` or `memory`, and `reason` is a class. Sent once per change, not on every retry. |
| `workspace_engine_attach` | A session's connection to the workspace integration engine settled on an outcome (`attached`, `engine_missing`, `engine_too_old`, `connect_failed`, `disabled` or `unbound`), with the engine version and counts of integrations. Sent when the outcome changes, not every turn. |
| `workspace_engine_install_prompt` | The offer to install or update the engine: `action` is `shown`, `accepted`, `installed`, `install_failed`, `copied` or `declined`, with the `reason` and whether Node.js was found and its major version. |
| `workspace_engine_precedence` | Whether the workspace's integrations take precedence over the project's own connections, with counts of shadowed connection types and connections. Sent when the state changes. |
| `workspace_engine_redirect` | A `datamate_manager` call was refused because the project is linked to a workspace. Contains the tool and operation names. |
| `workspace_engine_error` | The engine failed at a stage (`attach`, `install` or `precedence`). `message` is masked (paths, credentials and quoted strings are replaced) and capped at 200 characters. |

Other rows gain workspace fields in a linked project:

- Every event carries `client: "altimate-code"`, which names the product that sent it. `source` still says how the CLI was launched.
- Rows of a turn in a linked project carry that project's `workspace_id`: `session_start`, `session_end`, `first_prompt_sent`, `first_job_completed`, `skill_used`, `skill_published`, `memory_injection`, `agent_outcome`, `task_classified`, `task_outcome_signal`, `tool_chain_outcome`, `core_failure`, `error_fingerprint`, `plan_revision`, `sql_quality` and `tool_call`.
- `session_end` counts the workspace skills, memory blocks and integration calls the session used. `memory_injection` counts the workspace's blocks. `task_outcome_signal` says whether workspace context was used.
- A call to a workspace integration through the engine is reported as a `tool_call` with `tool_type: "mcp"` and `via_workspace: true`. As for other tools, there are no arguments or outputs, and an error message is masked and capped at 500 characters.
- An `endpoint` value is a route label with every id and path segment replaced by `:id`, for example `POST /datamate-project-bindings/bind`. It never contains an id, a file path or a query string.

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

When telemetry is disabled, a machine with an existing machine ID sends one final `telemetry_opted_out` event, then nothing: no further events and no requests to the telemetry endpoint until telemetry is turned back on. The event carries only the machine ID, the opt-out source, the CLI version and the client — see the event table above. With it, an opted-out machine can be counted instead of looking like a client that stopped working.

- The event is sent only if `~/.altimate/machine-id` already exists. A machine that never ran with telemetry on sends nothing.
- Once the telemetry endpoint accepts the event, Altimate Code writes the marker file `~/.altimate/telemetry-opted-out`, and later launches send nothing. If the endpoint cannot be reached, no marker is written and a later launch tries again.
- While the event is being sent, a short-lived `~/.altimate/telemetry-opted-out.sending` file stops a second process from sending it too.
- Turning telemetry back on removes the marker, so a later opt-out is recorded again.
- No account lookup is made while telemetry is disabled.

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
- Your email address, in any form (when you are signed in, events carry your Altimate user ID and tenant instead — see below)
- Tool arguments or outputs
- AI prompt content or responses

Error messages are truncated to 500 characters and scrubbed of file paths before sending.

### New User Identification

What identifies the sender of an event depends on whether the machine is signed in to Altimate:

- **Not signed in:** A random UUID is generated using `crypto.randomUUID()` on first run and stored at `~/.altimate/machine-id`. This ID is not tied to your hardware, operating system, or identity — it is purely random and serves only to distinguish one machine from another in aggregate analytics. It is also the Application Insights user ID (`ai.user.id`).
- **Signed in to Altimate:** Events also carry `user_id`, your Altimate user ID (a UUID), and `tenant`, the name of your Altimate instance; `ai.user.id` is your user ID instead of the machine ID. These identify your account, so signed-in events are not anonymous. To find them, Altimate Code makes one `GET /users/me` request to the Altimate API with the credential you signed in with, and caches the answer at `~/.altimate/telemetry-identity.json` (readable only by you). The cache holds the user ID, the tenant and a fingerprint of the credential — no API key or token. A new credential is looked up again; a sign-out, or a credential the API rejects, removes the cache. No email address, hashed or not, is sent.

These identifiers are sent only while telemetry is enabled. The final `telemetry_opted_out` event carries the machine ID and nothing that identifies your account, and no `/users/me` lookup is made while telemetry is disabled. Disable telemetry entirely with `ALTIMATE_TELEMETRY_DISABLED=true` or the config option above.

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
- `error_fingerprint` for error pattern grouping, with a one-line error message built from a fixed vocabulary of common error words
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
