# S2 — Altimate gateway providers

Date: 2026-10-15. Target: unmodified OpenCode v2.0.29, Bun 1.4.2.

Classification: **P\*** for the offline gateway adapter. Provider/model discovery,
key connection, and tenant routing use public plugin APIs. Live completion remains
**unverified**: the opt-in test is deliberately not run. No upstream patch is
required by the exercised path; browser sign-in and the complete managed Base
registration lifecycle are not claimed complete.

## What is implemented

`src/gateway.ts`, called by the ordinary `src/server.ts` setup, contributes:

- `altimate-backend/altimate-default` (Altimate LLM Gateway), using
  `aisdk:@ai-sdk/openai-compatible`, context 200,000 / output 128,000.
- `altimate-free/altimate-base` (Altimate Base), same SDK package, context 131,072 /
  output 65,536. It is available only with an eligible existing managed record.
- A key method on the tenant integration. The public client call is
  `opencode.integration.connect.key({ integrationID: "altimate-backend", key,
  location: { directory } })`. Core persists the key; connection presence makes
  the provider available (`packages/core/src/integration.ts:742`,
  `packages/core/src/provider.ts:416`).
- Provider-filtered `session.hook("model.request")` callbacks read the credential
  at request time, supply the endpoint and bearer header, and add `x-tenant` for
  the tenant gateway. There is no separate `x-instance` inference header in v1;
  the instance name is the value of `x-tenant`.

Provider metadata contains a placeholder API key, never the real credential.
Core applies request headers at
`packages/core/src/session/model-request.ts:304` through `:319`. Hooks are scoped
with `{ providerID }`; primary and auxiliary requests share this routing hook.
For the AI SDK bridge, the apparent base URL override is ineffective: its route
uses a dummy endpoint (`packages/core/src/aisdk.ts:381`) and `with: () => route`
(`:408`). The OpenAI-compatible SDK has already captured its base URL. This was
caught by transport review after the scripted tests passed.

The adapter therefore also registers provider-scoped `http.request` hooks and
rewrites the actual OpenAI-compatible chat endpoint to the credential's API root,
preserving method/body and updating the same credential's headers. This covers a
key connected after setup and later credential changes. **P\*** workaround;
implementing endpoint changes in the AI SDK route is a concrete **U** upstream
candidate. No upstream code was edited.

## Credential and configuration inputs

| Input | Support and precedence |
| --- | --- |
| `~/.altimate/altimate.json` | First choice, matching v1. Fields `altimateUrl`, `altimateInstanceName`, `altimateApiKey`; unknown extra fields such as `mcpServerUrl` do not affect inference. Trailing URL slashes are removed. |
| `${env:NAME}` in the three file fields | Expanded from the supplied environment; an unset variable fails instead of sending the placeholder. |
| v2 stored key | Fallback after file/direct environment inputs. Accepts `instance::api-key` (default API root `https://api.myaltimate.com`) or `api-url::instance::api-key`. Extra `::` segments are retained in the key, matching the v1 parser. The instance is validated with v1's tenant-name regex. |
| `ALTIMATE_GATEWAY_URL`, `ALTIMATE_API_KEY`, `ALTIMATE_INSTANCE` | Explicit spike/live convenience inputs; these three direct inference environment variables are additions, not a claim that v1 directly read them. URL is an API root; `/agents/v1` is appended. `ALTIMATE_API_URL` is also accepted as the root fallback. |
| `OPENCODE_TEST_HOME` | Same test-home override used by v1's credential path; otherwise the OS home. |
| `${XDG_DATA_HOME:-$HOME/.local/share}/altimate-code/altimate-base.json` | Reads v1's existing managed Base record (`version:1`, `installSecret`, optional `apiKey`, `baseURL`, `expiresAt`, `rejected`). Does not rewrite it or mint a registration. |
| `ALTIMATE_BASE_GATEWAY_URL`, fallback `ALTIMATE_FREE_GATEWAY_URL` | Must match the stored Base URL after HTTPS URL normalization. Expired/rejected records are excluded. `/v1` is appended. No tenant header is added. |
| `ALTIMATE_BASE_HEADER_TIMEOUT_MS` | v1's minimum 1,000 ms, floored valid value; default/fallback 300,000 ms. |
| Factory options | `gateway({credentialsPath, baseCredentialsPath, env})` allows isolated hosts/tests without changing process-wide inputs. |

V1 references: `packages/opencode/src/altimate/api/client.ts:79` (credential path),
`:88` (substitution), `:125` (compound key); `provider/provider.ts:384` and `:427`
(loaders), `:1518` and `:1563` (catalog); `altimate/free/client.ts:90` (URL aliases),
`:151` (eligible managed records). These paths refer to the read-only v1 fork.

Legacy v1 `auth.json` is not imported wholesale; users can paste the same compound
key through the v2 connection API. Configured v2 provider/model settings still
use core's normal configuration overlays, while credential-owned routing is
applied by the hook.

## Browser login and Base lifecycle limitations

V1 browser login is not standard OAuth token exchange. It opens
`ALTIMATE_WEB_URL` (default `https://app.myaltimate.com`) `/register`, binds a
loopback callback on 7317–7325, validates state and the callback API origin,
receives a short-lived `token` plus `instance`/`url`, then POSTs
`/auth/social/exchange` with `x-tenant`. It stores the returned `auth_token` and
instance/API root. Timeout, callback-server cleanup, and the CLI-context privacy
rules are part of that flow (`altimate/plugin/altimate.ts:132`, `:242`, `:372`,
`:420`, `:489` in v1).

V2 supports auto/code OAuth callbacks, but the result is specifically
`Credential.OAuth`, not a key (`packages/plugin/src/promise/integration.ts:49`–`:68`).
That schema requires `refresh`, `access`, and `expires`, with optional metadata
(`packages/schema/src/credential.ts:32`). A plugin could retain API root/tenant in
metadata and adapt the non-refreshing gateway token, or use an external method
plus its own credential store. A direct key-valued browser callback is absent.
**P\*** adaptation is feasible; this round leaves the browser flow unimplemented
because it cannot validate the callback/exchange against the blocked network.
A generic callback returning `Credential.Value` would be a useful **U** API
improvement only if direct key-valued callback parity is required.

Base auto-registration, install-identity locking, logout/rejection bookkeeping,
one retry after another process rotates a key, the complete same-origin/redirect policy
from v1's `authorizedFetch`, and the disclosure UI are not ported here. Those are
plugin-owned follow-up work (**P\***), not evidence of an upstream limitation.
The source build's embedded `ALTIMATE_BASE_DEFAULT_GATEWAY_URL` is not reproduced;
this package requires an explicit URL. V1's current consent module explicitly
says registration no longer requires accepting a consent token; the disclosure
still needs presentation. No registration or consent bypass is claimed.

## Verification

The scripted offline suite captures the public `model.request` event and runs the
actual session loop using the existing scripted AI SDK factory. That suite proves
hook routing and headers at the plugin contract, not an HTTP wire capture. A scripted language
model does not issue HTTP, so `http.request` cannot fire. Core's real HTTP seam is
`packages/core/src/session/model-request.ts:337`; factory initialization precedes
the language replacement (`packages/core/src/aisdk.ts:344`–`:354`,
`packages/core/src/plugin/provider/sdk-factory.ts:5`).

The actual-transport tests in `test/s2-transport.test.ts` use the installed
OpenAI-compatible SDK and real `http.request` hooks. A final test hook captures
the assembled request URL, headers, and JSON body, then redirects it to an inline
`data:text/event-stream` fixture. This exercises real serialization and core's
HTTP middleware without a listener, external network, or global fetch replacement.
They prove both a custom endpoint connected after setup and a changed endpoint,
tenant, and key on the next request of the same cached SDK session.

Non-vacuity for the transport workaround: kept `model.request` but temporarily
removed the tenant `http.request` rewrite. `S2.http.1` failed with actual
`https://api.myaltimate.com/agents/v1/chat/completions` instead of the connected
custom URL. Restored the source and both tests passed. See
[evidence/s2-transport-mutation.txt](evidence/s2-transport-mutation.txt) and
[evidence/s2-transport-tests.txt](evidence/s2-transport-tests.txt).

The separate `test/s2-live.test.ts` skips unless `ALTIMATE_LIVE=1`. It requires
`ALTIMATE_GATEWAY_URL` (API root), `ALTIMATE_API_KEY`, and `ALTIMATE_INSTANCE`, uses
the installed OpenAI-compatible provider, and asserts streamed text from a real
completion. It is **not run** in this round; missing credentials are not faked.

Scripted focused run: **8 pass / 0 fail / 27 assertions**, including default server
wiring and SDK model discovery, no key leakage in provider JSON, file substitution
and precedence, persisted key connection, direct environment inputs, the existing
Base record, and three exclusions (expired, rejected, different gateway). Package
typecheck passed. A further malformed-credential regression verifies that invalid tenant JSON and
an invalid Base record disable those providers without failing plugin setup or
unrelated scripted sessions, matching v1's isolated loader failures. The combined
S2 run is **11 pass / 0 fail / 40 assertions** in
[evidence/s2-tests-final.txt](evidence/s2-tests-final.txt). This includes two actual
transport checks. The key test also proves the model is absent before connecting
and present afterward.

Non-vacuity: temporarily removed only `await Gateway.setup(ctx)` from `server.ts`;
`S2.1` failed because the Altimate integration was absent (exit 1). Restored the
line in `finally`, then reran all five S2 tests successfully. See
[evidence/s2-wiring-mutation.txt](evidence/s2-wiring-mutation.txt) and
[evidence/s2-tests.txt](evidence/s2-tests.txt).

The key method stores the submitted string before this adapter parses it. V2's
key-method registration has no verifier callback
(`packages/plugin/src/promise/integration.ts:24`, `:75`); malformed compound keys
are rejected on credential resolution. Remote credential validation is not
claimed by the offline spike.

A cold-client activation race was observed: connecting the key immediately after
creating a session returned `IntegrationNotFoundError`. The public
`integration.list` call explicitly waits for plugin activation
(`packages/server/src/handlers/integration.ts:32`–`:35`), whereas `integration.get`
and `integration.connect.key` do not (`:41`, `:69`). `provider.list` also reads
immediately (`packages/server/src/handlers/provider.ts:14`). Tests warm registration
with `integration.list` before discovery/connect. This is **P\*** with a public
client workaround; adding the same activation wait to those handlers is a small
**U** candidate if all cold API entrypoints must be ready independently.

No upstream files were changed. No files were staged. The explicit package-only
write boundary takes precedence over the default Obsidian-copy instruction.


## Final round-3 verification

After formatting and all fixes, with the requested Bun 1.4.2 PATH prefix:

- `cd packages/altimate && ALTIMATE_LIVE=0 bun test`: **42 pass, 1 skip, 0 fail,
  190 assertions**, 43 tests across 9 files. The live test was explicitly kept
  disabled. [Full per-test output](evidence/round3-tests.txt).
- `cd packages/altimate && bun run typecheck`: **exit 0**.
  [Package typecheck](evidence/round3-typecheck.txt).
- Repository-root `bun run check`: **exit 0**, 1,353 existing lint warnings,
  zero errors; **37/37 package typechecks successful**.
  [Canonical check output](evidence/round3-root-check.txt).
- `git diff --check`: clean. Git index empty; every changed/new source, test,
  report, and receipt is under `packages/altimate/**`. No upstream edits,
  dependency installs, generated-client edits, or commits.

New slice totals: **S2 11 passing tests**, **S3 4 passing tests**, **S4 2 passing
tests**. All **25 pre-existing tests** also pass. Each slice has a restored,
expected-failing negative-control receipt. Work completed within the 40-minute
round budget (approximately 22 minutes).
