# Free Gemini Flash Model for altimate-code ("our Big Pickle")

**Date:** 2026-08-06
**Status:** Research complete — recommended architecture below, not yet built. Codex-reviewed (11 findings incorporated, 3 critical).
**Inputs:** codebase exploration of `altimate-code` (client wiring), `altimate-router`, `altimate-backend` (LiteLLM usage), external deep research (Parallel, run `trun_42322d19c00949b79419889d58d32287`), and a Codex adversarial review of the first draft.

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

## Open questions

1. **Which Flash + which default** — resolve exact GA model ID at Phase 0; flash-lite-default vs. flash-default decided from beta token profiles (see cost section).
2. **Langfuse tier** — confirm whether our deployment is OSS or Enterprise (retention automation); size ClickHouse/S3 for payload sampling.
3. **Edge stack** — Cloud Armor + GCLB vs. Cloudflare in front; whichever the team can operate; requirement is WAF + body-size + connection caps, not a brand.
4. **Grant curve numbers** — initial/day-7/day-30 budget values; pick after a week of internal dogfood traffic through the gateway.
