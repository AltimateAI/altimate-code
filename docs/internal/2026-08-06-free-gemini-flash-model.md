# Free Gemini Flash Model for altimate-code ("our Big Pickle")

**Date:** 2026-08-06
**Status:** **BUILT AND VERIFIED LOCALLY.** Both sides implemented, security-reviewed, and exercised end to end against real Vertex + Langfuse. Not deployed; not shipped to users. See "Implementation status" below.
**Inputs:** codebase exploration of `altimate-code` (client wiring), `altimate-router`, `altimate-backend` (LiteLLM usage), external deep research (Parallel, run `trun_42322d19c00949b79419889d58d32287`), and Codex adversarial reviews of the design and of both implementations.

## Implementation status (2026-08-06)

Two deliverables, both local-only, nothing pushed:

> **Update 2026-08-18.** Both sides went through repeated adversarial review after this section was
> written: **four rounds on the client, three on the gateway, every one returning FIX-FIRST.** Counts
> below are the originals; current state is 46+ client commits and 33+ gateway commits. See
> "What the review rounds actually found" near the end — it is the most useful part of this document.

**`~/codebase/altimate-gateway`** (new repo, `main`, 17 commits) — LiteLLM proxy pinned to
`ghcr.io/berriai/litellm-database:v1.95.0` serving `vertex_ai/gemini-2.5-flash` (project
`altimate-models`, global endpoint), a FastAPI **issuer** holding the master key, Postgres, Redis,
`docker-compose.yml`, policy + redaction hooks, and a runbook README with a *measured* error taxonomy.
189 unit tests + 13 pinned-image integration tests + a 7-check smoke script.

**`altimate-code` branch `feat/free-gemini-flash`** (worktree `altimate-bigpickle`, 19 commits) —
`altimate-free` provider + read-only loader, `FreeTier` client (install secret, consent-gated
registration, silent rotation), TUI slot-4 row + disclosure dialog, telemetry funnel, server route,
docs. Typecheck green, marker check clean, ~32 new tests, plus a 24-assertion E2E harness
(`script/e2e-free-tier.sh`, with `--dry-run` and `FAKE_BREAK=` fault injection).

**Verified against real services** (not mocks): consent → registration → real `gemini-2.5-flash`
completion → trace in `langfuse.onealtimate.com` with server-derived `userId`, per-principal
namespaced session, `tier:free` tags, and a planted AWS key stored as `[REDACTED:aws_access_key]`
with the raw value absent. Zero gateway contact before consent; only `sha256(install_secret)` on the
wire; credential at `0600`. Spend attribution confirmed **by querying Postgres directly**
(`0 → 7.59e-05` on one completion). Rotation leaves exactly one live key per principal. Kill-switch
latch held through a real `docker compose stop redis` (pre-fix it returned to 200 within ~2s).
Redis down → honest `503 dependency_unavailable`. Issuer cannot even resolve Postgres (gaierror) and
holds neither `DATABASE_URL` nor `LANGFUSE_SECRET_KEY`.

**What the build changed about the design.** Codex's review of the gateway returned 17 findings
(FIX-FIRST, blockers 1–10), all now fixed or documented as deploy gates. Three are worth carrying
forward as design lessons:

1. **LiteLLM's `internal_user` role includes `/key/generate`, `/key/delete`, `/key/update`,
   `/key/regenerate`.** A free-tier key could have minted itself unlimited keys through the same port
   it uses for inference, bypassing every budget and velocity control. Fixed by using
   `internal_user_viewer`. Note: key-level `allowed_routes` does **not** help — in `route_checks.py`
   it is only consulted as a later `elif`, so a role branch that already passed never reaches it.
2. **`async_logging_hook` is only called from the success handler.** The failure path applied no
   redaction at all, so any forced failure shipped raw prompts to Langfuse. Fixed with
   `async_log_failure_event` + `async_post_call_failure_hook`.
3. **Key rotation without revocation is key accumulation.** Old keys stayed valid 7 days, so one IP
   could bank ~120 live keys/day and multiply every per-key rpm/tpm/concurrency limit. Rotation now
   revokes predecessors (mint first, then revoke, so the caller never receives a dead key).

Also corrected from the research: the pinned image has **no** `fail_closed_budget_enforcement` key
(the real control is `allow_requests_on_db_unavailable: false`, already the default), and
multi-instance limits use `general_settings.coordination_redis` in v1.95.0, not
`router_settings.redis_host`. And a client-side latent bug surfaced: `Installation.VERSION` can emit
a 53-char CI sanity string or a slash-bearing branch name, both of which the issuer's `cli_version`
grammar rejects — now sanitized client-side (a client that can emit a 53-char version is the defect).

### The cache-prefix finding (biggest result of the build)

Measured against real Vertex, and it is not scoped to the free tier — **it makes every Gemini
request through altimate-code up to 9.6× cheaper, including for users on their own API keys.**

`SystemPrompt.environment()` (`packages/opencode/src/session/system.ts:71-100`) emits
`Working directory`, `Workspace root folder`, `Is directory a git repo`, `Platform`, and
`Today's date`, and `prompt.ts:1181` places it **first** in `input.system` — immediately after the
static provider prompt and ahead of skills, instructions, and the ~99 tool schemas. Vertex does
plain prefix matching and stops at the first differing byte, so:

| Scenario | Cached tokens | $/req | Requests/day at $0.25 |
|---|---:|---:|---:|
| No hit | 0 | $0.03635 | 7.2 |
| Cross-user hit, today's layout | 6,142 of ~121,000 (5.1%) | $0.03470 | 7.5 |
| Full-prefix hit, after moving `<env>` to the tail | 120,804 (99.9%) | $0.00374 | **66.9** |

The 6,142 figure is exactly the static head — proof of the mechanism, not an inference. Cross-user
caching today is worth **4.6%**: noise. Moving three lines is worth the entire 9.6×.

Two corrections this produced. An earlier "32% hit rate" was measured with a byte-identical payload,
which silently modelled one user, one machine, one day — the cross-user number was always the one
that mattered. And LiteLLM bills cached tokens correctly ($0.0038 hit vs $0.0364 miss, reconciling
to Google's published $0.03/1M cached vs $0.30/1M input), so there is no billing bug: we are not
over-debiting users.

**Explicit caching works but is dangerous before the prefix is stable.** A cache_control marker got
121,039 of 121,044 tokens cached, 3/3 requests, guaranteed rather than best-effort. But explicit
cache storage is $1.00/1M tokens/hour — a fixed **$2.91/day per distinct prefix**. With today's
per-user prefixes that is one cache per user: 200 users = **$582/day** to save $0.03 a request,
because the cost scales with users while the saving scales with requests. Sequencing is therefore
locked: stabilize the prefix → then gateway-injected explicit caching (with a hard cap on live
caches, storage metered inside the $50/day ceiling, cache identity derived from a prefix hash so a
release invalidates it automatically, and an alarm on sustained `cached_tokens` drop — a stale cache
does not error, it silently costs 10×) → then set grant/ceiling/tpm against $0.0037/req.

**RESOLVED 2026-08-07 — the ceiling is structural, and the prefix fix is worth ~1.18×, not 9.6×.**
Tool declarations serialize **after** `systemInstruction` on the wire, so a difference *anywhere* in
`systemInstruction` — including its final byte — earns zero credit for the tool block. Measured
interleaved, 8 attempts each at 12s spacing:

| Payload relationship | Cached | Hits |
|---|---:|---:|
| Byte-identical | 122,127 / 122,642 (99.6%) | 7/8 |
| Differs only at the END of `systemInstruction` | 67,848 (55.3%) — exactly the static head, never one token more | 5/8 |

67,848 recurring identically is a real block boundary, not a lucky draw. Two independent lines agree:
the client's own captured payload predicted 5.8% cacheable before the fix, and 5.1% was measured.

On this repo's **real** payload the gain is smaller than a synthetic fixture suggests, because tools
dominate: system prompt 59,163 chars vs tools 182,122 chars, so **~75% of the static payload is
permanently out of reach of any reordering inside `input.system`**. Cacheable span of
`systemInstruction` goes 13,919 → 58,817 chars (4.2× on that block), i.e. 5.8% → ~22% of the full
static payload after the measured 89-94% realization factor — about **$0.01715 → $0.01448/req, a
15.6% saving (1.18×)**, and only in the cases where `systemInstruction` varies at all (different
cwd, a new day, a different project, another user). Within one session it was already byte-stable.

So the reordering is real, free, and non-worsening — but it is not the headline. **The remaining
upside now belongs entirely to explicit caching**, which caches the whole payload including tools
regardless of variance: ~$0.00187/req, ~133 requests/day at a $0.25 grant. That is a much cleaner
decision boundary than we had, and it raises explicit caching's value well above the earlier
break-even estimate.

**A sweep of the stable head found two more prefix-breakers, one fixed and one bigger.** Skills were
sorted with `localeCompare`, whose default follows the runtime's LANG/ICU data — so two machines
emitted the same skills in a different order and shared no prefix at all. It needed fixing in *two*
places (`SystemPrompt.skills()` orders the auto-loaded bodies; `Skill.fmt()` re-sorts independently
and is the one that reaches the prompt), and correcting either alone accomplishes nothing. Fixed to
codepoint order.

The bigger one is **not** fixed: `Skill.fmt()` emits `<location>` as an absolute `file://` URL
carrying the user's home directory and worktree path, first occurring at char **40,850** — *earlier*
than `<env>` at 58,817. So for cross-user sharing the skill paths, not `<env>`, are the first
differing byte. Even a user with zero project skills gets a machine-specific path, because built-ins
resolve to `.../packages/opencode/%3Cbuilt-in%3E` instead of taking the `builtin:` branch that
already exists on that line. Measured against the 241,285-char static payload:

| | Cacheable head | Share |
|---|---:|---:|
| Before the reorder | 13,919 | 5.8% |
| Today (reorder + codepoint sorts) | 40,850 | 16.9% |
| If skill locations were machine-independent | 58,817 | 24.4% |

So the reorder did help cross-user sharing (13,919 → 40,850) and the remaining ~7.5 points is one
fix away — but it is not a pure byte-order change (it alters what the model sees), so it needs the
same behavioural verification the `<env>` move got. The rest of the head is clean: no dates, epochs,
UUIDs, tmp paths, ports, or unordered iteration ahead of `<env>`.

Deferred follow-up, flagged not attempted: getting the tool block into a *shared* prefix requires
`systemInstruction` to be byte-identical across requests, which means moving `<env>`, AGENTS.md and
memory into `contents` — the exact placement that caused the documented date-echo regression. One
nuance for whoever picks it up: that regression came from appending the date to the **trailing** user
message every turn; a synthetic **first** user message is a different placement and may not echo —
but it sits inside the conversation prefix, so it needs its own measurement, not an assumption.

**Not done, and required before any public deploy:** everything in "Legal gate" below (unchanged and
still blocking), plus the deploy gates in the gateway README — TLS ingress with a route allowlist and
a whole-body size cap, >1 worker, Vertex-side quota + GCP Spend Cap Budget as the hard backstop, and
real secret management. Budgets remain **soft/post-spend**: there is no atomic pre-reservation
without forking LiteLLM, so concurrent requests can overshoot a cap. The $50/day global ceiling
bounds the damage; the provider-side quota is what actually stops it.

## Goal

Offer a free hosted Gemini Flash model inside altimate-code, funded by GCP credits, the way
OpenCode offers "Big Pickle" through its Zen gateway. Constraints:

1. Abuse gating in place (we pay for every token).
2. No signup required.
3. Optionally reuse our existing gateway.
4. Collect traces into our Langfuse deployment for later use (evals, product analytics; see legal caveat on training).

## Reality check on our existing assets

Three things we believed going in needed correction:

| Assumption | Reality |
|---|---|
| "We have an altimate-gateway repo" | No repo by that name exists. `altimate-router` is a **local, single-user, Anthropic-only Rust sidecar** (Pingora) with no multi-tenant auth, no rate limiting, no Vertex code, no server deployment story. Not reusable here beyond its SSE-passthrough and redaction patterns. |
| "altimate-backend deploys a LiteLLM gateway" | There is **no standalone LiteLLM proxy deployment**. LiteLLM is used as an **in-process Python SDK** (`litellm.acompletion()`, pinned `1.83.0`) inside altimate-backend behind `POST /agents/v1/chat/completions` — an authenticated, tenant-scoped, OpenAI-compatible route. Models today: Sonnet 4.6 (Anthropic → Bedrock fallback) and GPT-5.5 (Azure). **Zero Vertex/Gemini plumbing exists.** The free tier there (`FREE100`, 10M-token grant) requires email signup; rate limiting is an in-memory per-process token bucket (documented in-code as broken under multi-replica); the security scan in `chat.py` is currently commented out. |
| "Big Pickle is a special system" | It's just a models.dev registry entry (`provider "opencode"`, OpenAI-compatible `https://opencode.ai/zen/v1`) with `cost: 0`, plus one custom loader: no API key found → strip all paid models → autoload with a sentinel `apiKey: "public"`. The endpoint simply doesn't validate keys for $0 models. And per opencode's own docs, Zen access is nominally account-backed (log in, get a key) — the anonymous path works because the server tolerates it for free models. |

What we DO have, and it's a lot:

- **Client-side template is 90% built.** Our fork already ships a custom provider (`altimate-backend` / model `altimate-default`, "Altimate LLM Gateway") with: a static `database[...]` injection block (`packages/opencode/src/provider/provider.ts:1423`), a `CUSTOM_LOADERS` entry resolving baseURL/key/headers (`provider.ts:332`), a TUI provider-priority row (`packages/tui/src/component/dialog-provider.tsx` — slot 4 is literally **reserved for the free interstitial**), and `DialogBigPickleConfirm` (`altimate-onboarding.tsx`) — a ready-made "free but with caveats" confirm dialog to clone. The telemetry enum already tracks `big_pickle` as a distinct provider choice.
- **A pattern for pseudonymous identity** — but not the artifact itself. `~/.altimate/machine-id` exists (crypto-random UUID, persisted), but it is publicly documented as serving *only* aggregate telemetry (`docs/docs/reference/telemetry.md`). Reusing it as a service credential would contradict that statement and link the telemetry and inference datasets. The free tier gets its **own gateway-scoped install secret**, minted the same way, stored via the existing `Auth` store (mode `0600`).
- **Langfuse is live.** altimate-backend uses Langfuse SDK v3 (OTel-based) with `LANGFUSE_HOST` configurable (`app/utils/langfuse_utils.py`); LiteLLM proxy has a native `langfuse` success callback (with caveats — see Traces).
- **An OpenAI-compatible surface + billing template.** `/agents/v1/chat/completions` and `verify_token_allowance`/`bill_tokens` are useful shape references even though free-tier traffic will not run through them.

## External research: what the market does (full report: vault copy "Deep Research — No-Signup Free LLM Endpoint")

- **Nobody ships truly anonymous unauthenticated inference.** OpenCode Zen, Cline, Gemini CLI (60 rpm / 1,000 req/day via Google OAuth), Qwen Code (free OAuth tier cut 1,000→100/day, then scheduled for shutdown — a warning about building on others' promos), OpenRouter `:free` (50 req/day, 1,000/day after a $10 deposit) — all bind free usage to *some* account or key. The viable no-signup pattern is: **silently issue a pseudonymous credential on first run and treat it as an abuse control, not identity.**
- **Two abuse planes.** (1) *Farming*: many installs / copied tokens / container fleets. With no signup and no attestation, farming is **unavoidable** — the design goal is to bound its cost per unit time, not to establish "one human." (2) *Proxy abuse*: normal-looking requests using us as a generic free LLM API. Model pinning limits damage but does not eliminate this — a free Flash chat endpoint is inherently a useful generic API; shape checks and user-agent checks are spoofable. Budget ceilings are the real control.
- **Spend control is layered, and nothing external is synchronous.** GCP's preview **Spend Cap Budget** (supports Vertex AI) pauses new usage after a monthly cost threshold — but it is delayed, lets in-flight requests finish, and can overshoot: a disaster backstop, not enforcement. Gemini pay-as-you-go runs on **Dynamic Shared Quota with no predefined per-project ceiling you can rely on** — there is no "physics-level" quota cap. Synchronous enforcement must live in the gateway: fail-closed budget checks with worst-case cost reserved before dispatch.
- **Pricing (Vertex, per 1M tokens, standard tier, as researched 2026-08):** gemini-2.5-flash $0.30 in / $2.50 out (cached in $0.03); gemini-2.5-flash-lite $0.10 / $0.40; gemini-3-flash-preview $0.50 / $3.00; gemini-3.1-flash-lite $0.25 / $1.50. Implicit context caching discounts cached input 90%, but hit rates depend on stable prefixes and reuse timing — treat as upside, not plan. **Pin an exact GA model ID and price table at deploy time**; budget enforcement that depends on pricing cannot ride a `latest` alias.
- **Vertex data governance is favorable but not absolute:** Google does not use customer data to train its models by default, but may retain prompts for abuse monitoring and uses project-scoped caching. More important — see Legal below — Google's service terms constrain what *we* may do with Gemini **outputs**.
- **Trace collection needs disclosure, not silence.** Big Pickle's own model card says data "may be used to improve the model"; Cline/NVIDIA/LongCat all disclose per-model. Pseudonymous ≠ anonymous under GDPR (install ID + IP is personal data). Disclosure is necessary but not sufficient: full-payload collection needs a real privacy design (purpose, policy version, retention, deletion, access controls).

## Legal gate (moved to the front — was "phase 3", Codex correctly flagged that as too late)

Resolve **in writing, with counsel and the GCP account team, before beta**:

1. **Output-use restriction.** Current GCP service terms restrict using generated output to develop/improve models similar to Google's, and prohibit offering the service in applications likely to be accessed by under-18s. **SFT/preference training on Gemini outputs may be off the table**; evals and product analytics are likely fine. The trace dataset's value proposition must be scoped to what the terms actually permit.
2. **Proxying/resale.** Terms don't explicitly bless fronting Vertex for anonymous third parties. Keep all Google credentials server-side; get the account team's read (often blessed as ecosystem spend, but get it in writing — including that credits may fund it).
3. **Privacy design for payloads.** Disclosure sentence + docs page + retention schedule + deletion path (registration endpoint doubles as the deletion contact channel keyed by install secret) + access-controlled Langfuse project. Note: automated retention on self-hosted Langfuse is an **Enterprise feature** — otherwise traces persist indefinitely; if we're on the OSS tier, retention must be a scheduled job we own.

## Recommended architecture

**Stand up a real LiteLLM proxy as a dedicated free-tier gateway** (finally making "altimate-gateway" true) in an **isolated GCP project that owns everything**: public edge, issuer, LiteLLM, Redis/Postgres, the Vertex service account, and the Spend Cap Budget. altimate-backend and the prod SaaS are **not in the path** — Codex's review convinced us that routing issuance through prod ingress (first draft) would put the LiteLLM admin credential in prod and let anonymous traffic touch prod, defeating the isolation.

```
altimate-code CLI
  │  1. user picks free model → disclosure interstitial → user confirms
  │  2. ONLY THEN: mint gateway-scoped install secret; POST /register
  ▼
Public edge (free-tier GCP project; Cloud Armor/WAF, strict body schema)
  ├── /register ──────────────► issuer (tiny service, same project)
  │        creates/loads a stable LiteLLM budget principal (user) for the
  │        hashed install secret; returns a SHORT-LIVED virtual key
  │        (hourly/daily/monthly budgets live on the principal, not the key)
  └── /v1/chat/completions ───► LiteLLM proxy
           │  deny-by-default request policy (pre-call hook):
           │  exact route + model alias, n=1, input/output caps, no
           │  multimodal/grounding/extensions, strip client `user`/metadata
           ├─ fail_closed_budget_enforcement; worst-case cost reserved pre-dispatch
           ├─ Redis (distributed limits) + Postgres (principals, keys, spend)
           ├─ inline kill switch: config flag rejects ALL free-tier inference
           └─ success hook → Langfuse (trace_user_id = principal,
                namespaced session id, custom pre-export secret masker)
  ▼
Vertex AI (dedicated SA; pinned model ID + price table;
           GCP Spend Cap Budget as delayed disaster backstop)
```

Only the issuer can reach LiteLLM's `/key/generate` (private network/IAM). Every LiteLLM management, UI, passthrough, embeddings, files, batches, audio, and image route is unreachable from the internet — the edge exposes exactly two routes.

Why LiteLLM rather than hand-building: virtual keys, per-principal budgets with reset windows, TPM/RPM/concurrency, Redis-distributed limits, spend ledger, and a Langfuse callback are all native. The honest capability caveats (from review):

| LiteLLM capability | Caveat |
|---|---|
| Budgets with reset | Reset checks run on a cadence (~10 min default) — "daily reset at midnight" is approximate |
| Redis distributed limits | Bounded drift; stale-counter recovery can undercount → use fail-closed mode (authoritative DB validation) |
| Global `max_budget` | Software accounting, not a billing guarantee — pair with Spend Cap Budget |
| "Ignore client model" | Not automatic — key-scoped alias allowlist + pre-call hook rewriting |
| 429s with reset time | Not guaranteed; build a normalized error taxonomy (daily budget vs. rpm/tpm vs. concurrency vs. provider 429 vs. maintenance) and test each |
| Langfuse callback | Doesn't map our `X-Session-Id` header or key metadata to trace user/session by itself — needs a server hook; built-in masking is whole-blob, typed secret redaction is custom code |

### Identity & keys (the Sybil-honest version)

- The install "identity" is a client-generated random secret — it proves nothing. An attacker can mint unlimited ones, so **never treat per-install limits as a global bound**, and never let keys accumulate: first-draft "permanent key, daily reset" would let an attacker stockpile keys slowly under issuance limits and use the whole hoard daily, forever.
- Design: **stable budget principal + short-lived rotating keys.** The principal (keyed by hashed install secret, keyed-rotating-HMAC for any stored IP data) carries hourly/daily/monthly budgets; virtual keys expire in days and are rotated on re-registration *without* resetting the principal's spend. Re-registration never returns an old key (LiteLLM stores only key hashes — it can't, and shouldn't).
- **Progressive grants:** new installs start small (e.g. $0.10–0.25/day) and grow with benign usage age; inactivity expires principals.
- Loose IP/subnet velocity limits apply to **both** registration and inference (IPv6 normalized to /64, trusted-proxy aware) — a signal, not identity.
- Worst-case spend is then bounded per unit time by: (principal budgets × active principals) ∩ global daily wallet ∩ Spend Cap Budget — with the global wallet sized so that even a successful farming run is a bad day, not a bad month. Wallet exhaustion is also a DoS vector against legitimate users; alert early (50%) so tightening beats tripping.

### Abuse controls beyond spend

- **Inline kill switch** — a flag that makes LiteLLM reject all free-tier inference immediately. Stopping issuance alone leaves every outstanding key live for days.
- **Cloud Armor/WAF** in front of the edge: malformed/oversized bodies, connection limits, streaming duration caps, basic bot rules.
- **Gemini safety policy** configured; policy-violation strikes per principal → revocation.
- **Separate cost ceilings for the infra itself** (Langfuse storage, Redis/Postgres, egress) — the LLM bill is not the only bill.
- Deferred until evidence demands: proof-of-work at registration, Turnstile, behavioral scoring. Log enough (principal, IP-HMAC, ASN, velocity, token profiles) to add them fast.

### Cost budgeting (corrected)

A heavy agent user ≈ 5M input + 300k output tokens/day ≈ **$2.25/day** on gemini-2.5-flash uncapped; even a perfect cache hit rate only brings it to ~$0.90/day, and real hit rates are worse — so a $1/day cap **binds** for heavy users on Flash. Options, to be decided from beta token profiles: (a) flash-lite default (~$0.62/day heavy, cap rarely binds) with Flash behind a smaller budget share; (b) Flash default with the cap as the honest limiter, communicated in the interstitial ("generous daily limit"). Either way: progressive grants keep the *average* cost per install far below the cap, and capacity planning uses measured beta numbers plus infra costs — not this napkin.

### Traces

- LiteLLM success hook → our Langfuse: `trace_user_id` = principal id (server-derived, never client-supplied), session = validated + namespaced client session id, tag `policy_version`; strip any client-sent Langfuse/metadata overrides.
- **v1 stores usage + metadata at 100%; full prompt/completion payloads start sampled and gated** on: custom typed secret-redaction masker (API keys, private keys, `.env` patterns, JWTs, DB URLs → typed placeholders) proven on real traffic, retention job in place (OSS Langfuse has no automated retention), deletion path documented. Widen to 100% payloads only after those hold and legal signs off on the use scope.
- **Disclosure** (Big Pickle pattern), in the confirm interstitial and docs: *"Free model — requests and responses are logged and may be used to improve Altimate's products and services. Don't send secrets or confidential code. No signup required."* Wording reviewed by counsel together with the output-use question; do not promise "improve the model" unless training on outputs is cleared.
- Later value, in the order of legal confidence: eval sets from real agent trajectories, failure clustering, routing/product analytics; SFT/preference data **only if** the Gemini output-use restriction is resolved.

### Client-side changes (clone the existing template, ~7 files)

1. `packages/opencode/src/provider/provider.ts` — new `database["altimate-free"]` block ($0-cost model `gemini-flash-free`) + `CUSTOM_LOADERS["altimate-free"]`. **The loader only reads an existing credential** (autoloads if present); it never registers. Registration — minting the install secret and calling `/register` — happens exclusively in the affirmative path of the disclosure dialog, so no identifier leaves the machine before consent and startup gains no network dependency.
2. `packages/tui/src/component/dialog-provider.tsx` — occupy reserved priority slot 4.
3. `packages/tui/src/component/altimate-onboarding.tsx` — clone `DialogBigPickleConfirm` → disclosure interstitial (default No stays); on Yes: register → store key via `Auth` store (0600) → select model.
4. `packages/tui/src/component/dialog-model.tsx` — free row in the picker (needs-setup style until registered).
5. `packages/opencode/src/altimate/telemetry/index.ts` — extend `provider_selected` enum + `classifyProvider()`. Telemetry keeps its own machine-id; the free-tier install secret is separate by design.
6. `packages/opencode/src/altimate/api/` — small client for `/register` + key refresh (silent rotation on 401/expiry).
7. `docs/docs/configure/providers.md` + `docs/docs/reference/telemetry.md` — document the model, the disclosure, and the new identifier (and fix the existing `altimate` vs `altimate-backend` id mismatch while there).

### What we're explicitly NOT doing

- **Not extending `altimate-router`** — wrong shape (local, Anthropic-only, single-tenant).
- **Not routing free traffic or key issuance through altimate-backend / prod** — isolation is the point; prod never holds the LiteLLM admin credential.
- **Not hand-building a proxy** — LiteLLM + a thin issuer + hooks covers it.
- **Not shipping any credential in the open-source binary** — only the gateway URL and the registration protocol are public.
- **Not designing v1 around the paid/BYO-key "graduation path"** — plausible later, but it must not widen the v1 security boundary.

## Phased plan

| Phase | Work | Exit criteria |
|---|---|---|
| **0 — Legal + infra** (~1 wk) | Counsel + GCP account team: output-use, proxying, credits, under-18 clause, disclosure wording. Isolated GCP project; Vertex SA; Spend Cap Budget + alerts; deploy LiteLLM (pinned image digest + model ID + price table) + Postgres + Redis; fail-closed budget mode; Langfuse hook with masking | Written legal read; curl with a hand-minted key streams Gemini; budget enforcement proven under concurrent streaming, cancellation, Redis restart; trace lands in Langfuse with correct principal/session and redaction |
| **1 — Issuer + edge** (~days) | Issuer service beside LiteLLM (principals + short-lived keys + progressive grants); public edge with the two routes, Cloud Armor, deny-by-default request policy; inline kill switch; normalized error taxonomy; spend dashboard | Idempotent principal per install secret; key rotation without budget reset; kill switch kills in-flight tier in <1 min; each limit type returns its distinct, tested error |
| **2 — Client** (~days) | The 7-file client change; consent-gated registration; telemetry funnel events; beta release (`/release-beta`) | Fresh install → pick free model → confirm disclosure → working session, zero config; nothing sent before consent |
| **3 — Soak + launch** | Beta soak; watch farming signals (principals/IP, tokens/principal, ASN spread, stockpiling attempts); tune grants; then promote to `latest` and announce | ≥1 week beta with spend within model; abuse-response runbook exercised (kill switch drill) |

## What the review rounds actually found (2026-08-07 → 08-18)

Seven adversarial review rounds — four on the client, three on the gateway — every one returning
FIX-FIRST. Two patterns dominate, and both are worth carrying into any future security-sensitive
work here.

**1. A vulnerability class reopens through a new entrance each time you fix a field.** The
credential-exfiltration bug was closed four separate times: a project config could redirect
`baseURL`, then `npm` (which `getSDK()` *imports*, handing it the stored key), then
`variants.fast.options.baseURL` through a third consumer that read `config.provider[id]` directly,
and finally a **ModelsDev registry record** named `altimate-free` winning the conditional
registration — not project config at all, but remote data refreshed at runtime. Only the fourth fix
was structural: deny the id where config is *read*, so every consumer inherits it, including ones
that do not exist yet. The lesson is that "fix the field the reviewer named" is not a fix.

**2. Tests that pass against the bug they target.** Seven shipped across the client rounds, plus
several on the gateway, *including tests written specifically to fix earlier false greens*:

- a mode assertion that passed against the very non-atomic writer it targeted (the discriminator is
  the **inode**, since the old writer also ends at `0600` after its `chmod`)
- a fixture that made `metadata["headers"]` and `proxy_server_request["headers"]` the **same dict
  object**, so it could never distinguish the two copies it asserted about
- a migration fake that iterated a dict in insertion order, so it could not exhibit the page
  instability it existed to detect
- a role test covering only fresh creation, while the bug was that *existing* principals were never
  reconciled
- `<= 3` where the buggy single-pass version satisfies it with 1 — upper bounds assert termination,
  exact counts discriminate
- a "different token" built as `token.slice(0,-1) + "0"`, which reconstructs the original ~1 in 16
  times (measured 7.06% over 10,000 tokens against the 6.25% the hex alphabet predicts)

The only thing that reliably caught these was **revert the fix, run the test, watch it go red**. And
a late refinement: two near-misses were invalid *experiments* rather than invalid tests — a revert
that threw a `ReferenceError` aborted before the assertion could discriminate, and a heredoc silently
ate invisible PUA literals so both comparators agreed. When a revert makes a test pass, first prove
the revert actually reached the code.

The strongest form of that rule, earned from three further instances during the final verification
pass: **an experiment must be shown to have run in the same environment as the thing it claims to
characterise, not merely to have executed.** A `cd` inside a compound command made `git show` emit
zero-byte files that formatted cleanly; `bunx` fetched a floating tool version instead of the pinned
one; and baselining by copying files to `/tmp` resolved *no* config at all, which inverted the
conclusion — it made pre-existing formatting violations look self-inflicted. A green result from a
config-less directory, an empty file, or an aborted code path is indistinguishable from a real pass.

## The carrier enumeration (2026-08-18) — and a correction to what "verified" meant

After four review rounds had each found *one more* place a secret travels into the trace, we stopped
patching and enumerated the whole surface from the pinned image's source. That enumeration found
**seven more client-controlled values reaching Langfuse in the clear**, in a trace already hardened
four times. Full 25-row table with source citations lives in the gateway README under
*The secret carriers into Langfuse*; summary:

- **5 already masked** — re-verified by canary this round rather than taken on trust.
- **3 masked by accident** — nothing *we* do covers them; upstream happens to. Langfuse skips one
  header copy *by name*, computes `clean_headers` from another and then discards the result (dead
  code upstream), and pops `secret_fields` before use. A LiteLLM bump can flip any of these with no
  signal, and our masking of the third is currently a no-op that protects nothing.
- **7 not masked** — arbitrary body-metadata keys, a *fourth* header copy, client-minted tags,
  `langfuse_*` values surviving under a copied key, `user` → `user_api_key_end_user_id`, User-Agent
  (twice, including into `trace.tags`), and the session id landing in `trace.id`. All fixed.

**Root cause behind most of them:** at logging time `metadata` is not on `model_call_details` at all
— it lives only under `litellm_params`, which is where Langfuse reads it. Our auth-header masking
read `kwargs["metadata"]` and therefore masked nothing on either path. Reading the source would not
have revealed this; only dumping a live record did.

**A trace-write primitive, exploitable anonymously, now closed.** Body
`metadata: {"existing_trace_id": …}` made Langfuse write our generation into a caller-named trace.
Demonstrated live with an ordinary key from anonymous `/register` over the one public route: it
produced a trace with a caller-chosen name, `userId: null`, `tags: []`. Two consequences, the second
worse — a caller can write into a trace it names, **and** the write escapes `tier:free`, so it is
invisible to the query we use to review free-tier usage. The same channel carried `trace_name`,
`prompt`, `update_trace_keys`, `parent_observation_id`, `debug_langfuse`, and `mask_input/output`;
all dropped, plus a second path via body `litellm_metadata` which the proxy merges *after* the
snapshot.

**The correction that matters most.** Six of the seven were in `observations[0].metadata`. Our
verification — including the first end-to-end check, which was reported upward as confirmation that
redaction worked — searched `input`/`output` of an object from the **list** endpoint, where
`observations` is a list of id *strings* and trace metadata is `{}`. The data was never in the object
being searched, so that assertion was **unfalsifiable for the entire class**, whatever was planted.
The earlier results were correct but narrower than stated: the evidence supported "no secret material
in `input`/`output`", not "no secret material in the trace". Restate them that way rather than
retract them. Checking a trace now means fetching `/api/public/traces/<id>`, which embeds
observations, and searching the whole document.

**A fourth false-green mechanism, and the first that was timing-dependent:** Langfuse ingests trace
and observation separately, so for a few seconds the full document has `observations: []`. A new test
passed against reverted code purely because it looked before the metadata existed. "Looked too early"
is indistinguishable from a real pass.

**Still open, and deliberately out of scope:** the Postgres **spend logs** are unexamined and are
known to hold unmasked `messages` and `response` — `standard_logging_object` is built *before* the
logging hook. Langfuse never reads those fields, so they do not reach the trace, but they are in our
database. That is a separate surface needing its own enumeration.

**Is the set complete? No — larger.** What is defensible: the set of fields Langfuse writes is closed
and read off the pinned image, so a new carrier must arrive through one of them; and the verification
method can now actually fail. What falls short: three carriers rest on upstream accident, the strip
is necessarily subtractive (an allowlist cannot work, since the router legitimately adds metadata keys
after our hook), and only the trace store was enumerated. What would justify "complete": a **negative
test that fails when a *new* carrier appears** — plant a canary in every client-reachable input and
assert the stored document contains none of them, run on every image bump — plus the same treatment
for spend logs.

## Notes for a human reviewer

- **18 of 39 changed `.ts`/`.tsx` files fail `prettier`, and it is pre-existing** — verified by
  baselining in-repo rather than in a temp copy (see the `/tmp` trap above). None of the lines added
  by this work are affected, and no CI workflow or git hook runs `prettier --check` (`.husky` has
  only a pre-push `typecheck`), so it is cosmetic. Called out because a reviewer running prettier
  locally will see a large spurious diff and should know it predates this branch. Deliberately not
  reformatted — out of scope.
- **The `request.ts` reachability guard is a regression test, not a proof.** It hand-rolls a static
  import walk covering `import/export … from`, bare `import "x"`, and `import("literal")` — but not
  `require()`, re-export through a variable, or a computed dynamic specifier. It fails correctly when
  someone adds a normal import (verified), and the dead-code conclusion rests on all three lines of
  evidence together rather than on this test alone. It also asserts `reachable.size > 400` as an
  anti-vacuity floor (today: 594), so a refactor that legitimately shrinks the graph would fail it
  spuriously — a one-line fix if that happens.
- **The ModelsDev collision test injects via `spyOn(ModelsDev, "get")`**, so it does not exercise the
  real `models.json` fetch/parse path. The injection point is documented in the test.

**Findings that mattered most, in rough order:**

| Finding | Why it mattered |
|---|---|
| LiteLLM's `internal_user` role includes `/key/*` | A free-tier key could mint itself unlimited keys through its own inference port. Fixed with `internal_user_viewer`; key-level `allowed_routes` does *not* help, as it is only consulted in a later `elif`. |
| 37 real over-privileged principals | The migration found them on our own stack, 36 predating this work. "Self-healing on re-registration" only repairs a *cooperative* principal; an attacker never comes back. |
| `async_logging_hook` never fires on failures | Any forced error shipped raw prompts to Langfuse with no redaction at all. |
| Secrets in `tools[].function.description` | Reached Langfuse raw, because tools ride in `optional_params`, not `messages` — confirmed by canary before fixing. |
| Migration offset paging over unstable ordering | `/user/list` sorts by nothing unless asked, so rows shift between pages and displaced ones are never seen — then it reports success. The exact silent-partial failure of the snippet it replaced. |
| Atomic write without a shared lock | Made a partial-corruption bug *worse*: the last rename now deletes the other writer's credential outright (reproduced 40/40). |
| `AuthService` narrowed the credential schema | Adding or removing any other provider silently dropped our `install_secret` and `base_url`. Surfaced only when the two `Auth` implementations were put side by side. |

**Two claims corrected by measurement**, both of which I had relayed as fact: a ~60s role-propagation
cache window (measured 0s in our configuration) and a budget-reset postponement (this version uses
calendar-aligned resets — verified across three consecutive registrations).

**Stopped without a clean verdict.** The final gateway review was terminated by a provider-side
content refusal after ~50 minutes, and an earlier attempt was killed mid-run, so one round-3 finding
was never identified. That is an absence of a verdict, not evidence of safety, and it should be read
that way.

## Follow-ups discovered during the build (tracked separately, none blocking)

1. **`run` hangs silently when the first turn errors.** Reproduced on clean `main` with
   google-vertex and no credentials: no output, never exits, no error rendered (exit 124, 96 bytes).
   Pre-existing and provider-agnostic. It matters here because a no-signup free tier makes
   first-turn errors easy to hit (budget exhausted, rate limited, registration failed), so a user's
   first experience of a failure is a hang. Own change, own tests.
2. **Capture the real `budget_exceeded` body.** The 429 work proved the value: live bodies
   contradicted our tests three ways (no `Retry-After` at all, two sub-flavours of
   `throttling_error`, and the gateway naming the key identifier in its own message). We currently
   *guess* LiteLLM's wording for the own-allowance vs tier-ceiling split, and that message is what
   users hit at the end of a good session.
3. **Grant / global ceiling / `tpm_limit` are deliberately unset.** They must move together —
   changing one alone just relocates the binding constraint. Set them after the prefix fix lands,
   against $0.0037/req rather than $0.0363.

## Open questions

1. **Which Flash + which default** — resolve exact GA model ID at Phase 0; flash-lite-default vs. flash-default decided from beta token profiles (see cost section).
2. **Langfuse tier** — confirm whether our deployment is OSS or Enterprise (retention automation); size ClickHouse/S3 for payload sampling.
3. **Edge stack** — Cloud Armor + GCLB vs. Cloudflare in front; whichever the team can operate; requirement is WAF + body-size + connection caps, not a brand.
4. **Grant curve numbers** — initial/day-7/day-30 budget values; pick after a week of internal dogfood traffic through the gateway.
