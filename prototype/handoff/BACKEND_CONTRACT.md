# Backend Contract — Gateway Onboarding

*Extracted from the working stub (`prototype/stub-server/`). This is the exact
interface the real backend must implement: the CLI code that speaks it is
already written and tested against the stub. Sarav: §1–§3 are the login/web
surface. Anand: §4–§5 are provisioning and the driver/runtime dependencies.*

**Base URL:** the CLI resolves it from `ALTIMATE_BASE_URL` (env), defaulting to
`https://api.myaltimate.com`. All paths below are relative to it. The CLI
stores the result of onboarding as a 3-part credential
`{altimateUrl, altimateInstanceName, altimateApiKey}` in
`~/.altimate/altimate.json` and thereafter authenticates data-plane calls with
`Authorization: Bearer <api_key>` + `x-tenant: <instance>`.

---

## 1. Device authorization (standard OAuth device grant)

The wire contract intentionally mirrors what `packages/opencode/src/account/index.ts`
already speaks — do not invent variants.

### `POST /auth/device/code`
Request (JSON): `{ "client_id": "opencode-cli" }`
Response `200`:
```json
{
  "device_code": "dev_…",
  "user_code": "ABCD-EFGH",
  "verification_uri_complete": "/register?code=ABCD-EFGH",
  "expires_in": 900,
  "interval": 2
}
```
- `user_code` shape `[A-Z0-9]{4}-[A-Z0-9]{4,5}` (the TUI's copy-shortcut regex
  depends on it).
- `verification_uri_complete` is a **path**; the CLI prepends the base URL and
  opens the browser to it.
- Durations are **seconds** (the CLI converts to ms).

### `POST /auth/device/token`
Poll request: `{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
"device_code": "…", "client_id": "opencode-cli" }`

Success `200`:
```json
{ "access_token": "…", "refresh_token": "…", "token_type": "Bearer", "expires_in": 3600 }
```
Error `200` (OAuth-style body, not HTTP errors):
```json
{ "error": "authorization_pending" | "slow_down" | "expired_token" | "access_denied",
  "error_description": "…" }
```
The CLI polls every `interval` seconds, +5s on `slow_down`, until `expires_in`.

Refresh grant (same endpoint):
`{ "grant_type": "refresh_token", "refresh_token": "…", "client_id": "opencode-cli" }`
→ same success shape, or `400 { "error": "invalid_grant" }`.

> The pre-existing **console** login (`account/index.ts`) additionally calls
> `GET /api/user` → `{id, email}` and `GET /api/orgs` → `[{id, name}]` (bearer)
> after the token. The stub serves both; keep them.

## 2. Instance provisioning poll (bearer-authenticated)

The instance **name is entered on the web**, not in the CLI. After receiving the
access token the CLI silently polls:

### `GET /api/instance`   (`Authorization: Bearer <access_token>`)
Sequence of responses:
```json
{ "status": "awaiting_name" }                      // signed in; user still on the naming page
{ "status": "provisioning" }                       // name submitted; instance being created
{ "status": "ready", "instance": "acme-2", "api_key": "…" }
```
- `401` for a missing/unknown bearer.
- `ready` must return **both** the final instance name and the API key in one
  payload — this is the only channel the key ever travels through. The CLI
  never displays it. Key format is opaque (stub mints `alt_proto_<random>`).
- CLI poll cadence: token poll per `interval`; instance poll every 1.5s.
- Stub provisioning delay is 8s standing in for the real ~1 min; the CLI shows
  a spinner for however long it takes.

### `GET /api/user` (bearer) — `{ "id", "email", "suggested_instance" }`
`suggested_instance` = email domain's first label (`priya@acme.com` → `acme`).
The current CLI no longer calls this (the web page uses the session's value
directly), but keep the field: it's how the web pre-fill is derived.

## 3. Web signup surface (Sarav)

Stub pages to replicate in the real app (visuals already match production's
register skin):

- **`GET /register?code=<user_code>`** — signup. Google OAuth is the only OAuth
  provider; "or use email instead" expands an inline form (work email +
  password with live rule validation).
  - **Work-email restriction:** on the OAuth path, restrict to Google Workspace
    accounts via the **`hd` parameter** on the Google OAuth request (personal
    gmail accounts never appear in the chooser). On the email path, reject
    personal domains server-side (stub blocklist: gmail, googlemail, yahoo,
    hotmail, outlook, live, icloud, me, aol, proton, protonmail) with an inline
    "use your work email" error. Emit `signup_blocked_personal_email`.
- **OAuth callback / email verification** both mark the device session
  authorized and land the SAME browser tab on `/instance?code=<user_code>` —
  naming is part of the signup flow, not a separate visit.
- **`GET /instance?code=<user_code>`** — the naming page. Requires an
  authorized session (else 404); if already named, redirect to `/connected`.
  Field pre-filled with `suggested_instance`; always-visible help line
  ("This names your Altimate instance. You can rename it later.").
- **`GET /api/instance/check?name=<n>`** — live availability (the page calls it
  debounced ~350ms per keystroke and once on load):
  ```json
  { "valid": false, "error": "Use lowercase letters, numbers, - or _, starting with a letter or underscore." }
  { "valid": true, "available": false, "suggestion": "acme-2" }   // first free "<name>-N"
  { "valid": true, "available": true }
  ```
  Name rule (shared with the CLI's tenant validation): `^[a-z_][a-z0-9_-]*$`,
  compared lowercased. *Stub leaves this unauthenticated; the real endpoint
  should be rate-limited and/or bound to the signup session.*
- **`POST /web/instance`** (form: `code`, `name`) — server-side revalidation
  (regex + collision, collision response includes the suggestion), then reserve
  the name, start provisioning, redirect to `/connected`.
- **`GET /connected`** — "signed in / instance provisioning / return to your
  terminal; this tab can be closed."

## 4. Credential validation & re-auth (existing data-plane endpoint)

### `GET /dbt/v3/validate-credentials`
Headers: `Authorization: Bearer <api_key>`, `x-tenant: <instance>`.
- `200` valid · `401` unknown/expired key · `403` key valid but wrong tenant.

The CLI validates stored creds on launch and triggers a **silent re-auth**
(device flow again, before chat) only on 401/403-class failures — transport
errors must NOT invalidate (the CLI deliberately ignores them so a network blip
doesn't force re-login).

**Instrumentation:** the stub exposes `POST /dev/event` as a sink for CLI-side
events (`byok_validation_result`, `model_switch_blocked_no_credentials`, plus
server-side `device_code_issued`, `device_authorized`,
`signup_blocked_personal_email`, `instance_name_taken`, `instance_provisioning`,
`instance_ready`). Prototype-only — replace with real telemetry.

## 5. Driver / native-binding dependencies (Anand)

Everything the onboarding + activation flows assume is installed. These were
the observed failure points; bundling them is the real fix for the accepted
"driver gap":

| Dependency | Used by | Observed failure mode |
|---|---|---|
| `duckdb` npm package **native binding** (`lib/binding/duckdb.node`, node-pre-gyp postinstall) | jaffle-shop sample (`sample_setup`), DuckDB driver | **bun skips untrusted postinstalls** → module present but binding missing → `Cannot find module …duckdb.node` at first query. Must be trusted/bundled or prebuilt-shipped. |
| `snowflake-sdk` npm | Snowflake driver (discover's #1 real-world connection) | Not installed by default; discover reports "Needs snowflake-sdk npm package" and offers an install. Bundle it. |
| `dbt-core` + **`dbt-duckdb` adapter** (Python) | sample dbt runs (`dbt run`/`dbt test`), activation build-&-query job | `sample_setup` hard-checks `dbt --version` output for the duckdb plugin; if absent it flags dbt "not ready" and instructs `pip install dbt-duckdb`. A sample whose `dbt run` fails is worse than no sample — decide bundle vs. guided install. |
| `keytar` (optional) | credential store for warehouse connections | Falls back with a warning to `ALTIMATE_CODE_CONN_*` env vars / plaintext-sanitized `connections.json`. Works, but decide the prod posture. |

**Provisioning semantics (real backend):** name is reserved at `POST
/web/instance` submit; the API key is minted server-side only after
provisioning succeeds and is returned exclusively through the authenticated
`GET /api/instance` poll (never rendered in any web page); `ready` must be
idempotent for repeated polls.
