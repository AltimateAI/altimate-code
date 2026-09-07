# Altimate Base — E2E Test Suite: Spec, Harness Design, Parallel Partition

Status: Phase 1 (research + design) complete. Not yet implemented.
Scope: PR #1199, branch `codex/altimate-base-release-final`.
Author: research/design pass, 2026-09-04. No test code was written by this pass — this
document is the contract 4-6 implementer agents build against.

Code read for this plan (all on `codex/altimate-base-release-final`, worktree
`.claude/worktrees/agent-a322d28e57f3ba696`):
- `packages/opencode/src/altimate/free/capability.ts` (consent authority)
- `packages/opencode/src/altimate/free/client.ts` (register/authorizedFetch/gatewayUrl/error mapping)
- `packages/opencode/src/altimate/free/consent.ts` (registration consent gate)
- `packages/opencode/src/altimate/free/store.ts` (credential file store)
- `packages/opencode/src/altimate/free/url.ts` (gateway URL validation)
- `packages/opencode/src/provider/provider.ts` (`altimate-free` provider loader, model def, `defaultModel()`)
- `packages/opencode/src/provider/error.ts` (`ProviderError.parseAPICallError` Altimate Base branches)
- `packages/opencode/src/cli/tui/worker.ts` (the ONE legitimate `issueArmer()` call site)
- `packages/opencode/test/altimate/altimate-base.test.ts` (existing 706-line unit suite — this
  plan does NOT duplicate its coverage; see "What's already covered" below)
- `packages/opencode/test/provider/error.test.ts`, `test/provider/provider.test.ts` (existing
  cross-cutting coverage)
- Gateway contract, cross-referenced against `/Users/anandgupta/codebase/altimate-gateway`:
  `issuer/main.py`, `issuer/litellm_client.py`, `issuer/config.py`, `litellm/config.yaml`,
  `litellm/custom_callbacks.py`, `docs/USING-ALTIMATE-BASE.md`.

**IMPORTANT gateway-contract caveat (flagged, not guessed away):** the gateway repo's checked-out
`main`/`feat/serving-autoscaler` still serves `MAX_OUTPUT_TOKENS=16384` with no
`SERVED_CONTEXT_TOKENS` clamp. The 131072/65536 + dynamic remaining-context-clamp contract that
altimate-code's PR #1199 (and this plan) assumes lives only on gateway branch
`chore/litellm-1.99.0` (commit `22971bc`, PR #14/#15), which is **74 commits ahead of gateway
`main` and not yet merged**. Everything below about the gateway's served limits describes the
`chore/litellm-1.99.0` behavior. See "Branch coordination risk" in Deliverable 4.

---

## What's already covered (do not re-implement)

`test/altimate/altimate-base.test.ts` already hermetically covers, via `spyOn(globalThis, "fetch")`
+ isolated `XDG_*`/`OPENCODE_TEST_HOME` dirs + the real `issueArmer()`/`issueRedeemer()` pair:

- Gateway URL precedence + rejection of unsafe URLs (partial — see gaps below).
- Fresh registration, hash-only transmission, dedicated 0600 store, no leak into `auth.json`.
- Unforgeable consent (forged token, self-armed foreign store, second `issueArmer`/`issueRedeemer` throws).
- Idempotent re-registration (reuse of a live credential, no network call).
- Malformed/hostile registration responses (wrong origin, wrong path, wrong model, pre-expired).
- Malformed on-disk credential record repair (only after explicit consent).
- Install-secret persistence across a lost response (retry reuses the same secret/hash).
- Network vs. HTTP-status vs. malformed-response failure classification.
- In-flight registration cancellation (AbortSignal) and logout-race cancellation.
- `authorizedFetch`: fails closed with no credentials, blocks cross-origin targets, overwrites a
  stale `Authorization` header, disables redirects, reads the credential store exactly once per
  call, never replays a rotated credential issued for a different origin, retries once against a
  credential rotated by another consented process.
- The 401 consecutive-count / persist-on-2nd-401 / reset-on-any-non-401 state machine, including
  the "concurrent write during the response" race variants.
- The registration consent gate's arm/register wiring in isolation (bounded pending tokens, TTL expiry).

This plan's job is the **gap** between that file and a genuine end-to-end contract test: model
catalog surfacing, the gateway-URL edge cases that file's "prefers new override" test doesn't
enumerate, the rate-limit/budget/byte-limit **message mapping** (`describeRateLimit`,
`describeRequestTooLarge` — see flagged gap below), the context/output-limit clamp behavior, and
the full register→provider-list→inference round trip against one shared fake gateway.

**Confirmed untested today (verified by grep, not assumed):**
- `FreeTier.describeRateLimit` / `FreeTier.describeRequestTooLarge` have **zero direct unit tests**
  in `altimate-base.test.ts`. They're only exercised indirectly through
  `test/provider/error.test.ts`'s `ProviderError.parseAPICallError` tests, which cover exactly two
  paths: `throttling_error` with an empty detail (generic burst-limit message) and the byte-limit
  413. **Not covered anywhere**: the `throttling_error` + `"Limit type: tokens"` branch (the
  non-retryable per-minute-token message), and **both** `budget_exceeded` branches
  (`"ExceededBudget: User="` vs. `"Budget has been exceeded"` vs. the generic fallback). This is a
  real gap, not a maybe — Suite 3 below closes it.

---

## Gateway contract reference (traced from code, `chore/litellm-1.99.0`)

| Concern | Where enforced | Value / shape |
|---|---|---|
| Register endpoint | `issuer/main.py:137` `POST /register` | body `{install_secret_hash, cli_version}` → `{api_key, base_url, model, expires_at}` |
| Registration velocity limit | `issuer/main.py:163` via `gate.check_registration_velocity(ip)` | `429 registration_rate_limited`, `Retry-After` header |
| Registration gate dependency-down | `issuer/main.py:152` | `503 dependency_unavailable`, `Retry-After: 30` |
| Registration rotation timeout | `issuer/main.py:188` | `503 registration_timeout`, `Retry-After: 2` |
| Kill switch (both /register and inference) | `litellm/custom_callbacks.py` `_KillSwitch`, `issuer/main.py:143` | `503 maintenance` |
| Served route allowlist | `custom_callbacks.py:494` `ALLOWED_CALL_TYPES` | non-chat-completion call types → `403 route_not_allowed` |
| Served model allowlist | `custom_callbacks.py:501` | wrong `model` string → `403 model_not_allowed` |
| Request byte limit | `custom_callbacks.py:516` `_enforce_request_size` | `MAX_REQUEST_BYTES=1048576` (1MB); over → `413 request_too_large`, message `"Request is {size} bytes; the free tier limit is {MAX_REQUEST_BYTES} bytes."`, wrapped in LiteLLM's `provider_specific_fields.error` shape (matches `describeRequestTooLarge`'s regex) |
| Output token cap | `custom_callbacks.py:69` `MAX_OUTPUT_TOKENS=65536` | clamps `max_tokens`/`max_completion_tokens` down, never up; defaults it if the client sent neither |
| **Dynamic remaining-context clamp** | `custom_callbacks.py:561` `_clamp_generation_params` | `effective_max = min(MAX_OUTPUT_TOKENS, SERVED_CONTEXT_TOKENS(131072) - estimated_prompt_tokens - CLAMP_MARGIN(512))`; if that's `< OUTPUT_TOKEN_FLOOR(1024)`, the clamp is **skipped entirely** and the request is passed through unmodified so the provider/SGLang returns its own honest over-context error |
| `n` forced to 1 | `custom_callbacks.py:591` | silently rewritten, not rejected |
| Per-key requests-per-minute | `issuer/litellm_client.py:411` `rpm_limit` | `KEY_RPM_LIMIT` env, default `10` |
| Per-key tokens-per-minute | `issuer/litellm_client.py:412` `tpm_limit` | `KEY_TPM_LIMIT` env, default `262144`; enforced by **LiteLLM's own built-in limiter**, not gateway code — its native `throttling_error` body is what `describeRateLimit`'s `/Limit type: tokens/` regex matches |
| Per-key/principal wallet budget | `issuer/litellm_client.py` `ensure_principal`/`sync_wallet_budget` | `GRANT_NEW_PRINCIPAL_USD=0.25` one-time grant per install-secret-derived principal, no reset duration; exhausted → LiteLLM's `auth_checks.py:653` message `"ExceededBudget: User={id} over budget. Spend={x}, Budget={y}"` |
| Global daily ceiling (all keys) | `litellm/config.yaml:105` | `max_budget: 50`, `budget_duration: 1d`; exhausted → LiteLLM's generic `"Budget has been exceeded! Current cost: ... Max budget: ..."` |
| Key TTL | `issuer/litellm_client.py:410` | `KEY_TTL=7d` |
| Content policy | `custom_callbacks.py:539` `_enforce_content_policy` | text-only message parts; non-text part types → `400 content_type_not_allowed` |
| Client params allowlist | `custom_callbacks.py:117` `ALLOWED_CLIENT_PARAMS` | anything else silently stripped, not rejected |
| Response caching | `litellm/config.yaml:110` | disabled — no cross-user cache bleed |

Note the two distinct 429 "budget" surfaces the client must tell apart from a message string alone
(no error code distinguishes them at the HTTP layer beyond the shared `type: "budget_exceeded"`):
per-principal wallet exhaustion (7-day key lifetime, no reset — "resets tomorrow" in the current
client message is **arguably inaccurate** for the wallet case, since the wallet has no
`budget_duration`; only the global daily ceiling actually resets daily) vs. the global $50/day
ceiling. Flagged as an ambiguity below, not silently corrected.

---

## Deliverable 1 — Scenario Inventory

Each row: **Suite** (from the partition in Deliverable 3) · **Scenario** · **Expected behavior, traced to a specific line**.

### A. Registration & install-secret lifecycle (mostly covered by existing file — new suite adds only the gaps)

| Scenario | Expected behavior | Source |
|---|---|---|
| Fresh anonymous register, no prior state | `POST {gateway}/register` with `install_secret_hash` (sha256 hex) + sanitized `cli_version`; credential written to dedicated store | `client.ts:265-337` |
| Register response missing `expires_at` | Accepted — `expires_at` is optional (`expiresAtPresent` check only fires if present) | `client.ts:302-317` |
| Register response with `expires_at` present but unparseable/past | Rejected as `RegistrationError("response")` | `client.ts:305-317` |
| Gateway returns `429 registration_rate_limited` | `describeRegistrationFailure(429)` → `"Too many Altimate Base registrations from this network right now. Try again later."`, `kind: "http"`, `status: 429` | `client.ts:166,294` |
| Gateway returns `503` (maintenance/dependency/timeout — all three issuer paths return 503) | `describeRegistrationFailure(503)` → `"Altimate Base is temporarily unavailable. Try again later."` | `client.ts:167,294` |
| Gateway returns some other 4xx/5xx (e.g. 400 malformed request, 500) | Generic `"Altimate Base registration failed (HTTP {status})."` | `client.ts:168` |
| Consent gate maps registration outcomes | `createRegistrationConsentGate.register()`: `429→"rate_limited"`, `503→"unavailable"`, network kind→`"network"`, else→`"error"`; `cancelled` kind→`ok:false, result:"error"` with the raw cancellation message | `consent.ts:23-55` — **not directly tested today**; existing file tests the gate's arm/consume wiring but never asserts the `RegistrationResult.result` discriminant against a real `429`/`503` from `registerAfterConsent`. |
| Malformed JSON register response body | `response.json().catch(() => undefined)` → falls into the empty-body branch → `RegistrationError("response")` | `client.ts:297` |
| `install_secret_hash` regex the gateway itself validates | Gateway: `400 invalid_request` if not 64 lowercase hex chars — client always sends a valid one, so this is a **gateway-contract sanity check**, not a client-behavior test; still worth one assertion that a malformed hash the fake gateway would reject never actually gets sent | `issuer/main.py:146-147`, `client.ts:85-87` |

### B. Consent gate / unforgeability (covered by existing file — no new suite needed; listed for completeness)
Fully covered: default-no (no arm ever called without an explicit `issueArmer()`), TUI-is-the-only-armer (`issueArmer()`/`issueRedeemer()` each throw on 2nd call — proven directly), arm-once/redeem-once, self-armed foreign store is inert against `registerAfterConsent`. **No new tests needed here.**

### C. Model catalog / provider surfacing (NEW — no coverage of the *catalog* shape, only isolation)

| Scenario | Expected behavior | Source |
|---|---|---|
| `altimate-free/altimate-base` appears in `Provider.list()` only when `credentialsForLoad()` resolves | `autoload: true` branch requires non-undefined creds; unregistered → `autoload: false`, model absent from the connected set (though the static `database[FreeTier.PROVIDER_ID]` entry always exists — "registered" vs. "connected" is the real distinction to test) | `provider.ts:382-398,1512-1554` |
| Model `limit` is exactly `{context: 131072, output: 65536}` | Static fallback value; **must literally equal** whatever the fake gateway advertises for this plan's assertions to mean anything against the real contract | `provider.ts:1533` |
| Model capabilities: `reasoning: true`, `toolcall: true`, `attachment: false`, `image` output `false` | | `provider.ts:1534-1542` |
| A project `provider.altimate-free` config block cannot rename/re-endpoint/re-model the provider | Already covered in `error.test.ts` ("pinned to the hosted Qwen contract") — re-verify in the new provider-isolation suite only if the harness needs its own instance of this check; otherwise skip, it's genuinely covered | `provider.ts:1185-1187`, `error.test.ts` |
| `Provider.defaultModel()` selects `altimate-free/altimate-base` only as last resort, never when any other provider is connected, never via a project `provider:` allowlist naming it explicitly | `provider.ts:2208-2231` — **UNTESTED**: no test found exercising `defaultModel()`'s Altimate Base branch at all | grep confirms no hits in `test/` for `defaultModel` + `altimate-free` together |
| A `recent` model.json entry naming `altimate-free/altimate-base` is honored only if `!hasProviderAllowlist` | `providerAllowed()` check inside the `recent` loop | `provider.ts:2174-2186` |
| Altimate Base is excluded from the "sort candidates" pass and reachable only via the explicit last-resort branch | `candidates` filter excludes `FreeTier.PROVIDER_ID` | `provider.ts:2216-2229` |
| `Provider.sort()` priority list includes `"altimate-base"` (replacing legacy "Big Pickle") | | `provider.ts:2133` |

### D. Inference happy path (NEW — full round trip against fake gateway; existing file never calls a real `/v1/chat/completions` shape end to end through the provider)

| Scenario | Expected behavior | Source |
|---|---|---|
| `authorizedFetch` used as the provider's `fetch` option round-trips a `/v1/chat/completions` call and returns content | `provider.ts:395` wires `fetch: FreeTier.authorizedFetch` directly into the AI SDK's OpenAI-compatible provider options | `provider.ts:390-397` |
| Managed API key placeholder never appears in serialized `Provider.Info`/options (only the real key, injected by `authorizedFetch`, is sent over the wire) | | `client.ts:15`, `error.test.ts` "not.toContain(sk-altimate-base)" pattern reused |
| Credential store isolation from `auth.json` (already covered) | — | `altimate-base.test.ts:118-139` |

### E. Rate limiting / budget / byte-limit message mapping (NEW — the flagged gap)

| Scenario | Expected behavior | Source |
|---|---|---|
| 429 `throttling_error`, detail matches `/Limit type: tokens/` | `describeRateLimit` → `{message: "This request is too large for Altimate Base's per-minute token limit. Start a new session or shorten the context, then try again.", retryable: false}` | `client.ts:499-506` |
| 429 `throttling_error`, no "Limit type: tokens" (generic burst), with `retry-after` header | `{message: "Too many requests to Altimate Base right now. Try again in {N}s.", retryable: true}` | `client.ts:507-509` (the no-retry-after variant — "Try again shortly." — is already covered in `error.test.ts`; the retry-after-present variant is **not**) |
| 429 `budget_exceeded`, detail contains `"ExceededBudget: User="` | `{message: "You've used today's free Altimate Base allowance. It resets tomorrow—switch models to keep going.", retryable: false}` — **untested anywhere** | `client.ts:511-517` |
| 429 `budget_exceeded`, detail contains `"Budget has been exceeded"` | `{message: "Altimate Base has reached its shared daily limit. It resets tomorrow—switch models to keep going.", retryable: false}` — **untested anywhere** | `client.ts:518-523` |
| 429 `budget_exceeded`, detail matches neither substring | Generic `"The daily Altimate Base limit has been reached..."` fallback — **untested anywhere** | `client.ts:524-527` |
| 429 with unparseable/absent body | `describeRateLimit` returns `undefined` → `error.ts` falls through to the generic API-error path (not the Altimate-Base-specific rewrite) | `client.ts:493-496`, `error.ts:360-375` |
| 413 `request_too_large`, message includes the `"Request is N bytes; the free tier limit is M bytes"` pattern | `describeRequestTooLarge` extracts KB values and produces `"...(179KB against a 125KB limit)"` — the KB-extraction regex itself is untested (only the end-to-end 413 case in `error.test.ts` is covered, which happens to include a matching body, but no test isolates the regex's parsing) | `client.ts:548-552` |
| 413 without the `request_too_large` code (e.g., unrelated provider 413) | `describeRequestTooLarge` returns `undefined`; falls through to `context_overflow` handling in `error.ts:349` | `client.ts:541`, `error.ts:349-357` |
| These mappings apply **only** when `providerID === FreeTier.PROVIDER_ID`; another provider's 429/413 with an identical body is left alone | Already directly covered in `error.test.ts` for the throttling/byte-limit cases; extend for `budget_exceeded` | `error.ts:335,360` |

### F. Token/context limits (NEW — this is the dynamic-clamp contract, currently invisible to any TS-side test)

| Scenario | Expected behavior | Source |
|---|---|---|
| Input well within 131072, no `max_tokens` set | Fake gateway clamps output to `min(65536, 131072 - prompt - 512)`; assert the **client surfaces whatever completion comes back** without complaint — this is really a fake-gateway-fidelity test, since the TS client has no client-side context accounting of its own | `custom_callbacks.py:561-588` — TS side has **no equivalent logic**; the model `limit.context/output` values are advisory to the AI SDK's own truncation, not enforced client-side |
| Requested `max_tokens` above 65536 | Fake gateway clamps down silently (200, not an error) — confirm the TS client doesn't misinterpret a silently-clamped response as an error | `custom_callbacks.py:583-586` |
| Prompt so large that `context_bound < OUTPUT_TOKEN_FLOOR (1024)` | Fake gateway does **not** clamp at all — passes the oversized request through; real SGLang would then return its own context-overflow error, which the client must handle via the generic `isOverflow`/413 `context_overflow` path (NOT the Altimate-Base-specific 413 rewrite, since that only fires for `request_too_large`, a distinct error code from context overflow) | `custom_callbacks.py:568-581`, `error.ts:349-357` |
| Reasoning tokens count toward the output cap | Documented design intent (`provider.ts:1531` comment: "reasoning tokens count toward output") — the fake gateway can simulate this by returning a response whose `reasoning_content` + `content` combined implies the cap was respected; there is no separate client-side accounting to test, so this is effectively a documentation/regression-of-intent check, not a behavioral one | `provider.ts:1526-1533` comment |

**Ambiguity flagged, not guessed:** whether "input within 131072 accepted / over 131072 rejected" should be a *client* behavior at all is unclear from the code — the TS client performs **no pre-flight token counting or context-limit enforcement**; the `limit.context/output` fields are purely advisory metadata read by the AI SDK / TUI for its own compaction heuristics upstream of `authorizedFetch`. Testing "over 131072 rejected" therefore either (a) tests the AI SDK's generic compaction behavior (out of scope for this suite — that's shared machinery, not Altimate-Base-specific), or (b) tests the fake gateway's simulation of SGLang's real over-context error, which is Suite F's actual job. **Product decision needed:** should this suite assert anything about client-side pre-flight limiting, or is "the gateway enforces it, the client surfaces whatever error comes back" the whole contract? This plan assumes the latter (option b) — flag to the PR author before an implementer builds tests that assume otherwise.

### G. Gateway URL resolution (mostly covered — one gap)

| Scenario | Expected behavior | Source |
|---|---|---|
| `ALTIMATE_BASE_GATEWAY_URL` set | Wins over everything | `client.ts:66-69`, tested |
| Only `ALTIMATE_FREE_GATEWAY_URL` set (legacy) | Used | tested |
| Neither env var set, no embedded default (source-mode/tests) | Throws `ConfigurationError`, "not configured" message | `client.ts:71-77`, tested |
| Neither env var set, **embedded `ALTIMATE_BASE_DEFAULT_GATEWAY_URL` present (release build)** | Falls back to the embedded default — **untested**: the existing test file can't easily set this (it's a build-time `declare const`), but the fallback branch (`client.ts:64-69` `embedded` value) is otherwise dead code as far as the test suite is concerned. Needs either a build-injected test double or an explicit note that this is only exercisable via the release build process, not unit tests. | `client.ts:18,64-69` |
| Malformed URLs (http, userinfo, query, fragment, non-URL) | Rejected, tested exhaustively | `url.ts`, `altimate-base.test.ts:100-114` |
| Trailing slashes normalized | Tested | `url.ts:10` |
| `normalizeGatewayUrl` unit-level (not through `gatewayUrl()`) | Not separately tested — acceptable, `gatewayUrl()`'s tests exercise it indirectly and completely | — |

### H. Credential lifecycle / error handling (mostly covered — two gaps)

| Scenario | Expected behavior | Source |
|---|---|---|
| Expiry → refresh | Covered (`credentialsForLoad` returns undefined once expired; explicit consent re-registers) | tested |
| Rejected credential → refresh on next explicit consent | Covered | tested |
| 401 counter reset on non-401 (including non-2xx) | Covered exhaustively, including the "concurrent write" races | tested |
| Gateway 5xx during inference (not registration) | `authorizedFetch` has **no special handling** for 5xx — it just returns the `Response` as-is (status !== 401 → clears the unauthorized counter and returns). This needs a test asserting the response passes through untouched (no crash, no swallowed error) so callers (the AI SDK layer) can handle it via the generic error path — **untested today** | `client.ts:461-464` |
| Connection failure / timeout during inference | `authorizedFetch` calls raw `fetch` with no try/catch around the initial `send(active)` — an exception (network error, abort) **propagates as a thrown error**, not a `Response`. Confirm this doesn't crash the process and surfaces as a catchable rejection through the AI SDK's own error handling — **untested today**, and worth confirming this asymmetry (registration wraps network errors into `RegistrationError`, inference does not wrap them at all) is intentional | `client.ts:429-450` — no try/catch around `send(active)` |
| Malformed JSON response body during inference | Not the client's problem — passed through to the AI SDK's own JSON parsing, which is shared machinery, out of scope | — |

---

## Deliverable 2 — Hermetic Test-Harness Design

### Design summary

One fake gateway module, `test/altimate/_fixtures/fake-gateway.ts`, implementing the two real
routes (`POST /register`, `POST /v1/chat/completions`) plus deterministic knobs for every error
mode in the table above. It is **not an HTTP server** — it's a `fetch`-shaped handler installed via
`spyOn(globalThis, "fetch")`, exactly the pattern `altimate-base.test.ts` already uses. This keeps
tests hermetic (no port binding, no `bun:test`-vs-real-network races, no CI firewall concerns) and
consistent with the one harness pattern already proven in this codebase. A real local HTTP server
was considered and rejected: it adds port-allocation flakiness and doesn't buy anything, since
`authorizedFetch`/`registerAfterConsent` both go through the global `fetch`, which is already the
seam the existing suite uses.

Each implementer's suite file:
1. Imports the isolated-XDG-home bootstrap (extracted from `altimate-base.test.ts`'s top-of-file
   pattern into a shared helper — see below) so every suite gets its own temp credential store.
2. Imports `FakeGateway` and installs it with `spyOn(globalThis, "fetch")`.
3. Claims `issueArmer()` **once per test file** (it's process-global and one-shot — if two suite
   files run in the same worker process, only the first claim wins; see "Cross-file consent
   isolation" below for why this is safe under `bun test`'s default file-per-worker model, and the
   one thing implementers must NOT do).
4. Uses `FakeGateway`'s knobs to script each scenario, and its optional request log to assert what
   was actually sent.

### Cross-file consent isolation (must read before writing Suite B, C, D, or F)

`issueArmer()`/`issueRedeemer()` are **process-global singletons** (`capability.ts:63-65`), each
claimable exactly once **per process**, not per file. `bun test` runs each test file in its own
worker process by default (confirmed by the existing suite's comment at `altimate-base.test.ts:76-82`
treating this as safe), so each suite file gets its own fresh module instances and can safely call
`FreeTierCapability.issueArmer()` at module scope, exactly like the existing file does. **Do not**
call `issueArmer()` more than once within one file, and do not assume any ordering or sharing
between suite files — each is independent. If a future harness change makes `bun test` share
workers across files, this assumption breaks; flag it if `--parallel=1`-style config changes are
ever made to the TypeScript CI job.

### Shared fixture: `test/altimate/_fixtures/altimate-base-harness.ts`

Extract the isolated-environment bootstrap (`XDG_*`/`OPENCODE_TEST_HOME` + cleanup) from
`altimate-base.test.ts:1-74` into this shared file so every new suite imports it instead of
re-copy-pasting. **This is the one piece of shared refactor allowed to touch the existing test
file** — pull the setup into the fixture, then have `altimate-base.test.ts` import from it too, so
there is exactly one isolated-environment implementation. Everything else in
`altimate-base.test.ts` stays as-is.

```ts
// test/altimate/_fixtures/altimate-base-harness.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeEach } from "bun:test"

const ISOLATED_ENV = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_TEST_HOME",
] as const

/**
 * Call once at module scope in each suite file, BEFORE importing
 * `../../src/altimate/free/*` (the client reads Global.Path lazily per-call, but isolating env
 * before any import keeps every suite file identical to how the existing altimate-base.test.ts
 * already does it).
 */
export function isolateAltimateBaseHome(prefix: string) {
  const original = Object.fromEntries(ISOLATED_ENV.map((key) => [key, process.env[key]]))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  process.env.XDG_DATA_HOME = path.join(home, "data")
  process.env.XDG_CONFIG_HOME = path.join(home, "config")
  process.env.XDG_CACHE_HOME = path.join(home, "cache")
  process.env.XDG_STATE_HOME = path.join(home, "state")
  process.env.OPENCODE_TEST_HOME = home

  afterAll(() => {
    for (const key of ISOLATED_ENV) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    fs.rmSync(home, { recursive: true, force: true })
  })
  return home
}

/** Call in beforeEach: clears gateway env vars, then sets the fake gateway URL. */
export function resetGatewayEnv(gatewayUrl: string) {
  delete process.env.ALTIMATE_BASE_GATEWAY_URL
  delete process.env.ALTIMATE_FREE_GATEWAY_URL
  process.env.ALTIMATE_BASE_GATEWAY_URL = gatewayUrl
}
```

### Fake gateway: `test/altimate/_fixtures/fake-gateway.ts`

```ts
// test/altimate/_fixtures/fake-gateway.ts
import { spyOn } from "bun:test"

export const GATEWAY_URL = "https://gateway.test"
export const MODEL_ID = "altimate-base"

export interface RegisterCall {
  url: string
  installSecretHash: string
  cliVersion: string
}
export interface ChatCall {
  url: string
  authorization: string | null
  body: unknown
}

type RegisterMode =
  | { kind: "ok"; apiKey?: string; expiresAt?: string | null; baseUrl?: string; model?: string }
  | { kind: "http"; status: number; headers?: Record<string, string> }
  | { kind: "network" }
  | { kind: "malformed-json" }

type ChatMode =
  | { kind: "ok"; content?: string; status?: number }
  | { kind: "throttle-tokens" } // 429 throttling_error, "Limit type: tokens"
  | { kind: "throttle-burst"; retryAfterSeconds?: number } // 429 throttling_error, generic
  | { kind: "budget-wallet" } // 429 budget_exceeded, "ExceededBudget: User="
  | { kind: "budget-global" } // 429 budget_exceeded, "Budget has been exceeded"
  | { kind: "budget-unknown" } // 429 budget_exceeded, neither substring
  | { kind: "too-large"; requestBytes?: number; limitBytes?: number }
  | { kind: "unauthorized" } // 401
  | { kind: "server-error"; status?: number } // 5xx
  | { kind: "timeout" } // never resolves until aborted
  | { kind: "malformed-json" }

/**
 * Fetch-shaped fake for the two real gateway routes. Install with `.install()` in `beforeEach`,
 * script the next response with `.registerNext()` / `.chatNext()`, and read `.registerCalls` /
 * `.chatCalls` to assert what was actually sent. One instance per test file (or per describe
 * block, for isolation from another block's scripted responses); do not share across files.
 */
export class FakeGateway {
  registerCalls: RegisterCall[] = []
  chatCalls: ChatCall[] = []
  private registerQueue: RegisterMode[] = []
  private chatQueue: ChatMode[] = []
  private spy?: ReturnType<typeof spyOn>

  registerNext(mode: RegisterMode) {
    this.registerQueue.push(mode)
    return this
  }
  chatNext(mode: ChatMode) {
    this.chatQueue.push(mode)
    return this
  }

  install() {
    this.spy = spyOn(globalThis, "fetch").mockImplementation(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith("/register")) return this.handleRegister(url, init)
        if (url.includes("/v1/chat/completions")) return this.handleChat(url, init)
        throw new Error(`FakeGateway: unhandled URL ${url}`)
      }) as typeof fetch,
    )
    return this
  }

  restore() {
    this.spy?.mockRestore()
    this.spy = undefined
  }

  private async handleRegister(url: string, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(String(init?.body))
    this.registerCalls.push({ url, installSecretHash: body.install_secret_hash, cliVersion: body.cli_version })
    const mode = this.registerQueue.shift() ?? { kind: "ok" as const }
    if (mode.kind === "network") throw new Error("connection reset")
    if (mode.kind === "http") return new Response("", { status: mode.status, headers: mode.headers })
    if (mode.kind === "malformed-json") return new Response("{not json", { status: 200 })
    return json({
      api_key: mode.apiKey ?? "sk-altimate-base-fake",
      base_url: mode.baseUrl ?? GATEWAY_URL,
      model: mode.model ?? MODEL_ID,
      ...(mode.expiresAt === null ? {} : { expires_at: mode.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString() }),
    })
  }

  private async handleChat(url: string, init?: RequestInit): Promise<Response> {
    const authorization = new Headers(init?.headers).get("Authorization")
    this.chatCalls.push({ url, authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const mode = this.chatQueue.shift() ?? { kind: "ok" as const }
    switch (mode.kind) {
      case "ok":
        return json({ choices: [{ message: { content: mode.content ?? "hello from altimate-base" } }] }, mode.status ?? 200)
      case "throttle-tokens":
        return throttleError("Limit type: tokens. Key=sk-fake. Current: 300000, Limit: 262144")
      case "throttle-burst":
        return throttleError("burst limit exceeded", mode.retryAfterSeconds)
      case "budget-wallet":
        return budgetError("ExceededBudget: User=principal-fake over budget. Spend=0.26, Budget=0.25")
      case "budget-global":
        return budgetError("Budget has been exceeded! Current cost: 50.01, Max budget: 50")
      case "budget-unknown":
        return budgetError("spend limit reached")
      case "too-large": {
        const size = mode.requestBytes ?? 179_608
        const limit = mode.limitBytes ?? 128_000
        const message = `Request is ${size} bytes; the free tier limit is ${limit} bytes.`
        return json(
          {
            error: {
              message,
              code: "413",
              provider_specific_fields: { error: { code: "request_too_large", message } },
            },
          },
          413,
        )
      }
      case "unauthorized":
        return new Response("", { status: 401 })
      case "server-error":
        return new Response("upstream error", { status: mode.status ?? 500 })
      case "timeout":
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      case "malformed-json":
        return new Response("{not json", { status: 200 })
    }
  }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function throttleError(message: string, retryAfterSeconds?: number): Response {
  return new Response(JSON.stringify({ error: { type: "throttling_error", message } }), {
    status: 429,
    headers: retryAfterSeconds !== undefined ? { "retry-after": String(retryAfterSeconds) } : {},
  })
}

function budgetError(message: string): Response {
  return new Response(JSON.stringify({ error: { type: "budget_exceeded", message } }), { status: 429 })
}
```

### Example test using both fixtures (goes in Suite E — see Deliverable 3)

```ts
// test/altimate/rate-limit-messages.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { isolateAltimateBaseHome, resetGatewayEnv } from "./_fixtures/altimate-base-harness"
import { FakeGateway, GATEWAY_URL } from "./_fixtures/fake-gateway"

isolateAltimateBaseHome("altimate-base-ratelimit")
const { FreeTier } = await import("../../src/altimate/free/client")
const { FreeTierStore } = await import("../../src/altimate/free/store")
const { FreeTierCapability } = await import("../../src/altimate/free/capability")

const armProductionConsent = FreeTierCapability.issueArmer()
function consented(): string {
  const token = randomBytes(32).toString("hex")
  armProductionConsent(token)
  return token
}

const gateway = new FakeGateway()

beforeEach(async () => {
  gateway.install()
  await FreeTier.logout()
  await FreeTierStore.remove()
  resetGatewayEnv(GATEWAY_URL)
  gateway.registerNext({ kind: "ok" })
  await FreeTier.registerAfterConsent(consented())
})

afterEach(() => gateway.restore())

describe("describeRateLimit", () => {
  test("budget_exceeded wallet exhaustion maps to the per-user message", async () => {
    gateway.chatNext({ kind: "budget-wallet" })
    const response = await FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    const described = FreeTier.describeRateLimit({ body: await response.text() })
    expect(described).toEqual({
      message: "You've used today's free Altimate Base allowance. It resets tomorrow—switch models to keep going.",
      retryable: false,
    })
  })

  test("budget_exceeded global ceiling maps to the shared-limit message", async () => {
    gateway.chatNext({ kind: "budget-global" })
    const response = await FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    const described = FreeTier.describeRateLimit({ body: await response.text() })
    expect(described?.message).toContain("shared daily limit")
    expect(described?.retryable).toBe(false)
  })

  test("per-minute token limit is non-retryable", async () => {
    gateway.chatNext({ kind: "throttle-tokens" })
    const response = await FreeTier.authorizedFetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    const described = FreeTier.describeRateLimit({ body: await response.text() })
    expect(described?.retryable).toBe(false)
    expect(described?.message).toContain("per-minute token limit")
  })
})
```

This is intentionally a **skeleton**, not the finished suite — implementers fill in the rest of
each table row from Deliverable 1 following this exact shape (arrange via `FakeGateway`, act via
`FreeTier`/`Provider`, assert against the table's traced expected behavior).

---

## Deliverable 3 — Parallel Partition

Six suite files, one shared fixture pair (harness + fake gateway, built by whichever implementer
picks up Suite E first — it's the natural owner since it needs the richest fake-gateway surface;
everyone else imports the finished fixture). All files live under
`packages/opencode/test/altimate/`.

| # | File | Owns (from Deliverable 1) | Depends on |
|---|---|---|---|
| **A** | `altimate-base-registration-gaps.test.ts` | Registration table gaps only: `describeRegistrationFailure` for 429/503/other via the consent gate's `RegistrationResult.result` discriminant (not yet asserted anywhere); malformed JSON register body. Does **not** re-test anything `altimate-base.test.ts` already covers. | fixture only |
| **B** | `altimate-base-catalog.test.ts` | Deliverable 1 Suite C in full: catalog presence/absence, `limit`/`capabilities` shape, `Provider.defaultModel()`'s Altimate Base branch (registered-and-unregistered, with/without a provider allowlist, with/without a `recent` entry), `Provider.sort()` priority. | fixture only — this one leans on `Instance.restore`/`tmpdir` patterns from `test/provider/provider.test.ts`, not the fake gateway's chat route |
| **C** | `altimate-base-inference-e2e.test.ts` | Deliverable 1 Suite D: full register→provider-list→`authorizedFetch` round trip returning real completion content; managed-key-placeholder-never-serialized check via a live provider instance (not just a mocked `credentialsForLoad`, which is what `error.test.ts` already does — this suite goes one level deeper, through `authorizedFetch` itself). | fixture + fake gateway `chat` route, `ok` mode |
| **D** | `altimate-base-rate-limit-messages.test.ts` | Deliverable 1 Suite E in full: every `describeRateLimit`/`describeRequestTooLarge` branch, including the three `budget_exceeded` variants and the `Limit type: tokens` per-minute case — the confirmed gap. Owns the example test above; extend it to cover every row in Suite E's table. | fixture + fake gateway `chat` route, all throttle/budget/too-large modes — **this suite's implementer builds `fake-gateway.ts` and the harness fixture**, since it needs the fullest surface |
| **E** | `altimate-base-context-clamp.test.ts` | Deliverable 1 Suite F: fake-gateway-side simulation of the dynamic `SERVED_CONTEXT_TOKENS` clamp (silent output clamping, floor-triggered pass-through), plus a documented note resolving or escalating the flagged ambiguity about client-side vs. gateway-side enforcement. **Do not start this suite until the ambiguity in Suite F is resolved** — either the product owner confirms "gateway enforces, client just surfaces" (this plan's assumption) or specifies real client-side pre-flight behavior to test instead. | fixture + fake gateway `chat` route (extend `ChatMode` with a `context-clamp` variant that computes the clamp server-side using the same constants as `custom_callbacks.py`, so this suite is pinned to the real formula, not a guess) |
| **F** | `altimate-base-error-surfacing.test.ts` | Deliverable 1 Suite H gaps: 5xx pass-through during inference (no crash, response returned as-is), connection failure/timeout during inference (throws, doesn't hang, doesn't corrupt credential state), the `timeout` `ChatMode`. | fixture + fake gateway `chat` route, `server-error`/`timeout`/`network` modes |

**Ownership rule to avoid collisions:** Suite D's implementer builds `_fixtures/fake-gateway.ts`
and `_fixtures/altimate-base-harness.ts` **first**, commits them alone in the first commit of their
branch, and the other five suites branch from (or cherry-pick) that commit before writing their own
tests. This is the one sequencing dependency in an otherwise fully parallel partition — call it out
explicitly when kicking off the swarm so Suite D starts a few minutes ahead of the rest, or have
whichever implementer is fastest stub the fixture files first and let everyone else start against
the stub signature (the interface above is stable enough to code against immediately; only the
`ChatMode`/`RegisterMode` variant list might grow).

Each suite file is independent at the `bun test` level (no shared mutable state beyond the
process-global consent singletons, which — per the "Cross-file consent isolation" note — are safe
because each file is its own worker process). Suite E is explicitly blocked on a product decision
and should be sequenced last, or built in parallel with a `test.skip` on the ambiguous assertions
until resolved.

---

## Deliverable 4 — CI Integration Plan

### Where it runs

No CI configuration changes needed. `packages/opencode/**` is already in the `typescript` path
filter (`.github/workflows/ci.yml:43`) that gates the `TypeScript` job, and that job's "Run tests"
step (`ci.yml:209`) runs `bun test --timeout 90000` with no path restriction — every
`test/altimate/*.test.ts` file this plan adds is picked up automatically in the **MAIN pass**
(the one that runs with `OPENCODE_SKIP_SUBPROCESS=1`, default concurrency). None of these six
suites spawn a real CLI subprocess or bind a port, so none belong in the bounded
`SUBPROCESS_PATHS` pass (`ci.yml:207`) — confirm this stays true; if any suite needs
`Instance.restore`/`tmpdir` filesystem fixtures like Suite B does, that's still in-process and
still belongs in the main pass (that's exactly what `test/provider/provider.test.ts` already does
in the same pass today).

Runtime budget: six suites of the size sketched here (a few dozen assertions each) add well under
a minute to the main pass at default concurrency — negligible next to the existing "9500+ tests
across 379 files" the job's own comment describes. No dedicated job justified.

Hermetic guarantee: every suite installs `FakeGateway` via `spyOn(globalThis, "fetch")` before any
`FreeTier` call and isolates `XDG_*`/`OPENCODE_TEST_HOME`, so nothing reaches a real network host or
a real user config directory — matching the existing suite's proven pattern exactly.

### Live-prod smoke — kept separate, non-blocking

A live smoke test against the real staging/prod gateway (internal staging hostname, see
`docs/USING-ALTIMATE-BASE.md`, or whatever prod URL PR #1199 ships) is explicitly **not** part
of the hermetic suite above and must not be added to the blocking `TypeScript` CI job. Reasons,
traced from what's already in this codebase for exactly this situation: the Driver E2E job's
comment (`ci.yml:244-246`) states cloud tests requiring real credentials "are NOT run here... run
locally only," and the cloud driver E2E test files (`drivers-snowflake-e2e.test.ts` etc.) use
`skipIf`-based auto-skip when connection env vars are absent rather than failing CI. Follow the same
shape:

- New file `test/altimate/altimate-base-live-smoke.test.ts`, gated by e.g.
  `ALTIMATE_BASE_LIVE_SMOKE_URL`/`ALTIMATE_BASE_LIVE_SMOKE_KEY` (or just reuse
  `ALTIMATE_BASE_GATEWAY_URL` if unset → skip) — auto-skips when unset, exactly like the driver E2E
  pattern, so it's safe to leave in the repo without ever running in the default CI job.
  Alternative name to keep it out of `test/altimate/` glob-scans some tooling may run: place under
  `test/altimate/live/` — either is fine, follow whichever convention the driver E2E tests use for
  their skip-by-default cloud files.
  - Actually verify the exact `skipIf` gating pattern in `drivers-snowflake-e2e.test.ts` (not read
    in this pass) before implementing — the citation above about "cloud tests auto-skip" is
    confirmed via the `ci.yml` comment, but the precise skip mechanism should be copied, not
    reinvented.
- Do not wire it into the `typescript` path filter or the main `bun test` invocation's include list.
  It should only run when explicitly invoked locally (`bun test test/altimate/altimate-base-live-smoke.test.ts`
  with the real env vars set) or from a separate, manually-triggered or scheduled workflow
  (`workflow_dispatch` / `schedule`) that is **not** a required status check on `#1199` or any
  follow-up PR.
- Rationale beyond "matches existing convention": live-prod calls against a rate-limited,
  budget-capped free-tier gateway are non-deterministic by construction (this plan's own Deliverable
  1 findings — per-minute token limits, a one-time $0.25 wallet grant, a shared $50/day ceiling) and
  registering a real key in CI would itself consume budget and could trip the registration-velocity
  gate (`issuer/main.py:151`) for every other real user on the same runner IP range. A blocking live
  test would therefore be actively hostile to the free tier it's supposed to be testing.

### Where the suite lands: #1199 vs. a stacked follow-up PR

**Recommend a stacked follow-up PR**, not adding this suite directly to #1199. Reasoning, checked
directly against #1199's live state (`gh pr view 1199`, checked during this pass):

- #1199 is already large (five source files + a 706-line existing test file) and its `TypeScript`
  CI check is currently **FAILING** (confirmed: `conclusion: "FAILURE"` on the `TypeScript` check,
  started 18:15Z, completed 18:28Z on 2026-09-04) — consistent with the "blocked on broken-main"
  context this task was given. Landing six more test files on top of a red, already-large PR adds
  review surface without unblocking anything; it should merge once, cleanly, after #1199 is green.
- **Branch-coordination risk, flagged explicitly:** another agent is reportedly doing a live-prod
  check against this same branch (`codex/altimate-base-release-final`) concurrently with this
  research pass. This plan deliberately did not modify anything on that branch's worktree
  (`.claude/worktrees/agent-a322d28e57f3ba696`) to avoid colliding with that in-flight work — all
  code in this document is written to be copied onto a **fresh branch cut from #1199's tip** by
  whichever implementer starts first, not committed in place. Before the implementer swarm starts,
  re-pull that branch's tip (it may have moved since this pass read it at commit `c3165628ee`) and
  re-verify none of the client.ts/error.ts line numbers cited above have shifted.
- Once #1199 merges, cut `test/altimate-base-e2e-suite` (or similar) from `main`, land the six
  files there, and open it as its own PR referencing #1199. This also means the hermetic suite gets
  its own clean CI signal instead of being entangled with #1199's existing (and currently failing)
  checks, and a reviewer can evaluate "is the test suite good" independently of "is the feature
  code good."

### Gateway-contract version risk (separate from branch coordination, worth its own flag)

This plan's Deliverable 1 "F" table and the gateway contract reference table are both built against
gateway branch `chore/litellm-1.99.0`, which is **unmerged** to gateway `main` (74 commits ahead,
confirmed via `git log --oneline main..chore/litellm-1.99.0`). If that branch's 131072/65536 +
`SERVED_CONTEXT_TOKENS` clamp work does not land before the fake gateway ships, Suite E
(`altimate-base-context-clamp.test.ts`) would be testing a contract the real gateway doesn't yet
serve — the fake gateway would still be internally consistent and useful for regression protection
once the real gateway catches up, but until then it's validating an aspirational contract, not the
live one. Not a blocker for building the hermetic suite (hermetic tests are allowed to encode the
target contract ahead of the server catching up), but flag it to whoever owns the gateway repo so
the two branches land in the right order, or at minimum so nobody is surprised when a live-prod
smoke test (once one exists) disagrees with what the hermetic suite asserts.

---

## Summary of flagged ambiguities (product decisions needed, not guessed)

1. **Suite F / client-side context enforcement**: does the TS client need to pre-flight-reject
   requests over 131072 tokens, or is "gateway enforces, client surfaces whatever error comes back"
   the whole contract? This plan assumes the latter. Blocks Suite E until confirmed.
2. **Wallet-exhaustion message accuracy**: `client.ts:514` says "It resets tomorrow" for the
   per-principal wallet-exhausted case, but the wallet (`GRANT_NEW_PRINCIPAL_USD`) has no
   `budget_duration` — only the global $50/day ceiling actually resets daily. Confirm whether this
   message is intentionally reassuring-but-imprecise (a UX call) or should be corrected once a test
   pins the current (possibly wrong) behavior. Not a blocker for testing — Suite D should test the
   message **as written today** and flag the discrepancy in its own comment, not silently fix it.
3. **Embedded-default gateway URL fallback** (`client.ts:64-69`, release-build-only): effectively
   untestable from `bun test` as currently structured (it's a build-time constant substitution).
   Confirm whether this needs a build-injection test double, or is accepted as covered only by the
   release build/smoke process.
