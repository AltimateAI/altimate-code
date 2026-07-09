# Onboarding Prototype — Change Summary (both branches)

*For Sarav & Anand. Two branches exist; neither touches `main`. Everything under
`prototype/` is a throwaway stub standing in for the future backend. Everything
under `packages/` is real CLI code to productionize (a few demo env-flags inside
it are marked below). All demo/testing runs use `PROTO_FRESH=1`, which sandboxes
every credential/connection file into a temp dir — no real user files are read
or written.*

---

## Branch 1: `plg-onboarding-prototype` (v1 — onboarding funnel)

A fresh install of altimate-code used to drop the user into an empty chat: the
model picker never checked credentials, OpenCode Zen was the "recommended"
provider, connecting Altimate meant hand-pasting an `instance::key` string, and
there was no signup. This branch rebuilds the funnel end to end. On first launch
the curated model picker opens immediately (Altimate LLM Gateway recommended on
top with 10M-free-tokens framing; Anthropic/OpenAI/Google; Big Pickle honestly
labeled; search for the long tail), over a Claude-Code-style boot screen that
explains the product. Choosing the Gateway runs a browser signup against a local
stub of the future backend: Google OAuth (workspace accounts only) or a work-
email fallback, then an in-flow "Name your instance" page (pre-filled from the
email domain, live availability check), provisioning, and the API key delivered
machine-to-machine — the CLI polls silently and never prompts for the name or
shows the key. BYOK keys get two-stage validation after entry (invalid key →
two-option recovery with no "continue anyway"; failed tool-calling → retry /
gateway / typed-"continue" with a persistent ⚠ unreliable-model chip). Chat is
unreachable until a model actually works — enforced by guidance, not error
copy. Returning users with valid credentials skip all of it; an expired gateway
key triggers silent re-auth. Part 2 adds a one-time "Scan your environment?"
Yes/No gate after model setup (honest help text, no auto-scan): Yes hands off
to the repo's existing `/discover` when anything is found, with specific
why-plus-next-action messaging for each empty case; No becomes an intent
question. Sidebar and copy were reworked to match (jobs panel, community/docs
links, positioning copy).

## Branch 2: `plg-onboarding-prototype-v2` (adds Part 3)

Builds on branch 1 unchanged and adds the activation layer. A new `sample_setup`
CLI tool provisions a **real** jaffle-shop environment on demand: a DuckDB file
seeded from a deterministic generator (identical data every run — raw_customers
100, raw_orders 300, raw_payments 326) plus a small genuine dbt project (3
staging views, 2 marts, 13 schema tests, its own profiles.yml) pointing at it,
registered through the existing `warehouse.add` path so `/discover`,
`sql_execute`, `warehouse_test` and `schema_index` work against it unmodified.
Verified live: `dbt run` PASS=5, `dbt test` PASS=13. Every Part-2 endpoint now
finishes with an activation menu in JTBD language ("What would you like to
do?"): the connected path personalizes from scan results and offers
downstream-impact / SQL-PR-review / warehouse-cost; the no-data and declined
paths lead with "Try Altimate on a sample dbt project" followed by the
stack-agnostic jobs. Selecting a job starts it for real — jobs route to the
verified built-in skills (`dbt-analyze`, `sql-review`, `cost-report`), the
sample option runs `sample_setup` then presents a sample-scoped menu
(cost-report deliberately excluded there: DuckDB has no cost data), and
build-&-query runs real `dbt build` + `sql_execute`.

---

## File-by-file

### STUB — throwaway, stands in for the real backend (`prototype/`)

| File | What it is |
|---|---|
| `prototype/stub-server/server.ts` | Local Bun server on :8787 — all endpoints in the Backend Contract doc, plus page routing and structured JSON event log (stdout). |
| `prototype/stub-server/state.ts` | In-memory session state machine, issued-key registry, personal-email blocklist, instance-name collision set (seeded with `acme`), name suggestion. |
| `prototype/stub-server/pages.ts` | The web pages: `/register` (Google + progressive email form with live password rules, value section), Google account-chooser replica, `/instance` (name your instance: pre-fill, debounced live availability, inline validation), `/connected`, `/verify`, `/dev/inbox` demo mailbox. |
| `prototype/stub-server/ui.ts` | Shared page shell + design tokens sampled from the production register page (Poppins, `#3D6DD0` blue, `#F4F5F8` bg, etc.). |
| `prototype/assets/signup-design-reference.png`, `prototype/README.md`, `prototype/stub-server/package.json` | Design reference + docs. |

### REAL CLI — both branches (`packages/opencode/src/`)

| File | What changed |
|---|---|
| `altimate/api/client.ts` | `ALTIMATE_BASE_URL` env override (default unchanged); gateway device-flow client (start/poll-token/poll-instance incl. `awaiting_name`); BYOK stage-1 key ping (real endpoints for Anthropic/OpenAI/Google) + stage-2 tool-call check; **demo flags inside**: `PROTO_FAKE_VALIDATION`, `protoEvent()` instrumentation, `PROTO_FRESH` creds sandbox. |
| `auth/index.ts`, `auth/service.ts` | One guarded path each: `PROTO_FRESH` sandboxes `auth.json` (no effect otherwise). Demo-only. |
| `cli/cmd/tui/component/dialog-provider.tsx` | `PROVIDER_PRIORITY` reordered (Gateway first, Zen demoted) + labels; `qwen-plus` warnlist; `GatewayFlow` (device sign-in → **silent** instance poll → save creds; no name prompt, key never shown); BYOK failure dialogs (2-option invalid-key; retry/gateway/typed-continue with `// PM-DECISION` note); unreliable-provider flag. Auth-method screens untouched. |
| `cli/cmd/tui/component/dialog-model.tsx` | Unified READY / NEEDS-SETUP picker with credential gating; curated first-run picker with intro header; `useReady`/`markSetupComplete` readiness signal; Big Pickle confirm interstitial (default No). |
| `cli/cmd/tui/component/welcome-panel.tsx` *(new)* | The boot box (wordmark, readiness-aware tips, positioning copy) shared by home + session. |
| `cli/cmd/tui/routes/home.tsx` | Boot box layout; input bar pinned to bottom. |
| `cli/cmd/tui/routes/session/index.tsx` | Boot box pinned above the conversation (header consistency). |
| `cli/cmd/tui/routes/session/sidebar.tsx` | Jobs (JTBD) panel replaces Trace/MCP/LSP; community + docs lines (stable Slack vanity URL); dotted dividers; left border; stale Getting-started box removed. |
| `cli/cmd/tui/component/prompt/index.tsx` | Claude-style input bar (`›`, rules, hint row); first-run placeholder; submit gate (opens picker instead of erroring when no model is ready); ⚠ unreliable-model chip. |
| `cli/cmd/tui/component/prompt/autocomplete.tsx` | First-run slash menu filtered to safe commands; command/description column alignment; hides `onboard-connect`. |
| `cli/cmd/tui/component/dialog-command.tsx` | First-run command allowlist (`/connect`, `/help`, `/themes`, `/status`, `/exit`). |
| `cli/cmd/tui/component/dialog-scan-gate.tsx` *(new)* | Part-2 "Scan your environment?" Yes/No gate (verbatim locked copy); fires once on first reach of ready. |
| `cli/cmd/tui/app.tsx` | Picker-first trigger (fresh launch only); scan-gate fire-once trigger; returning-user silent re-auth; `/connect` opens the curated picker. |
| `command/index.ts` | Registers the hidden `onboard-connect` command. |
| `command/template/onboard-connect.txt` *(new)* | Part-2 orchestration prompt: scan/skip branches with the locked recovery copy. `discover.txt` is byte-for-byte unchanged. |
| `packages/opencode/package.json`, `packages/drivers/package.json`, root `bun.lock` | `snowflake-sdk` added (installed live via discover's driver-gap flow during testing). |

### REAL CLI — `plg-onboarding-prototype-v2` only

| File | What changed |
|---|---|
| `altimate/tools/sample-setup.ts` *(new)* | The `sample_setup` tool: deterministic DuckDB seed + real dbt project + connection registration + hard dbt/duckdb-adapter readiness check. |
| `tool/registry.ts` | Registers `sample_setup`. |
| `altimate/native/connections/registry.ts` | One guarded path: `PROTO_FRESH` sandboxes `connections.json` (demo-only). |
| `command/template/onboard-connect.txt` | Extended with the Part-3 activation menu + routing (sample → `sample_setup`; jobs → `dbt-analyze` / `sql-review` / `cost-report` skills; cost-report barred from the sample path). |

**Demo scaffolding to strip or keep behind env for production:** `PROTO_FRESH`
(4 guarded paths), `PROTO_FAKE_VALIDATION` (validation stubbing), `protoEvent`
(fires only when `ALTIMATE_BASE_URL` is set). Default behavior with none set is
unchanged.

**Accepted known issues carried forward (from the Part-2 locked spec):**
(1) driver gap — discover offers an npm install rather than guaranteeing a green
connection; real fix is bundling drivers (Anand, see Backend Contract §5);
(2) discover's raw shell commands trigger permission prompts at a sensitive
moment (noted, v2); (3) discover can surface plaintext secrets into the
transcript (needs redaction in prod; don't record it); (4) sample data now
exists (was the top v2 gap — shipped in the activation branch).
