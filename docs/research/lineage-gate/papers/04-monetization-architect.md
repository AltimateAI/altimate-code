# Position Paper: Cryptographic Entitlement Tokens Embedded in altimate-core

**Author:** DevTools Monetization Architect
**Date:** 2026-03-07
**Position:** Binary-enforced, cryptographically signed entitlement tokens with a generous free allowance baked into the compiled Rust binary itself.

---

## The Mechanism: Signed Entitlement Tokens

I propose **one** mechanism: **Ed25519-signed entitlement tokens validated inside the altimate-core Rust binary**, with a **built-in free allowance of 500 column-lineage calls** that requires zero signup, zero network connectivity, and zero configuration. After 500 calls, the binary returns degraded output (table-level lineage only) until the user activates a license token obtained through a free account signup or paid subscription.

This is not a local rate limit stored in a deletable config file. The counter lives inside the compiled binary's encrypted state, keyed to a machine fingerprint and protected by cryptographic signatures that cannot be forged without Altimate's private key.

---

## How It Works Technically

### The Free Allowance (Calls 1-500)

When altimate-core ships, the Rust binary contains:

1. **Altimate's Ed25519 public key** (hardcoded, ~32 bytes)
2. **A default entitlement token** signed by Altimate's private key, granting 500 column-lineage operations
3. **An encrypted usage ledger** stored at `~/.altimate-code/.state` using AES-256-GCM, keyed to a machine fingerprint derived from: hostname + username + disk serial (or fallback to a random UUID persisted on first run)

On each `column_lineage()` or `track_lineage()` call:

```
1. Binary reads encrypted ledger from ~/.altimate-code/.state
2. Decrypts using machine-derived key
3. Checks: calls_used < entitlement.max_calls (500 for default token)
4. If under limit: execute full column lineage, increment counter, re-encrypt ledger, return results
5. If over limit: return table-level lineage only + upgrade message
```

The critical property: **the binary refuses to execute column lineage without a valid signed entitlement token**. The default 500-call token ships embedded in the binary. You cannot forge a new one because you do not have Altimate's Ed25519 private key. You can delete `~/.altimate-code/.state` -- the binary regenerates it, but with the same machine fingerprint, the calls_used counter is reconstructed from a Merkle hash chain stored alongside the ledger. Deleting the state file resets to zero, but the binary detects the mismatch between the chain tip and the fresh state and enters a "verification required" mode that caps you at 50 more calls before requiring an online activation ping.

### The Activation Step (After 500 Calls or Proactively)

When the user runs `altimate-code activate` or the binary's degraded response tells them to:

1. User creates a free account at `altimate.ai/activate` (email + password, 30 seconds)
2. The server issues a signed entitlement token (Ed25519-signed JSON containing: `{user_id, plan: "free", max_calls: 200/day, features: ["column_lineage"], issued_at, expires_at}`)
3. User pastes the token or the CLI fetches it automatically via OAuth device flow
4. Token is stored at `~/.altimate-code/license.key`
5. altimate-core validates the token's Ed25519 signature against the hardcoded public key
6. If valid: full column lineage enabled with 200 calls/day (free plan) or unlimited (paid plan)

### The Paid Upgrade

Paid tokens simply have `max_calls: null` (unlimited) and `features: ["column_lineage", "track_lineage", "pii_lineage"]`. They are issued by the same server, signed with the same key, and validated the same way. The only difference is the claims payload.

### Token Format

```json
{
  "v": 1,
  "uid": "user_abc123",
  "plan": "pro",
  "max_calls_per_day": null,
  "features": ["column_lineage", "track_lineage", "pii_lineage"],
  "iat": 1741305600,
  "exp": 1772841600,
  "machine": null
}
```

Signature: Ed25519 over the canonical JSON bytes.

Total token size: ~200 bytes + 64-byte signature = ~264 bytes. Fits in a single line of a config file or a QR code.

---

## Addressing the Agent-as-Consumer Problem

The agent is the primary consumer of lineage. Here is why this mechanism works for agents:

**The agent does not know or care about the gate.** It calls `column_lineage()` through the bridge exactly as it does today. The Rust binary handles all entitlement logic internally. The agent receives either:
- Full column-level lineage results (within entitlement)
- Table-level lineage + a machine-readable `"upgrade_required": true` field in the response (over limit)

The agent can read the `upgrade_required` field and surface it to the user: "Column-level lineage is unavailable. Run `altimate-code activate` to continue." This is identical to how Cursor surfaces "You've used all your fast requests" -- the AI agent encounters a limit, tells the user, and the user upgrades.

**The agent cannot bypass the gate** because:
1. The gate is inside the compiled Rust binary, not in TypeScript or Python
2. The binary validates cryptographic signatures -- no valid signature, no column lineage
3. Looping through models individually still consumes calls from the same counter
4. The counter is per-machine, per-entitlement-token, enforced in compiled code

**The agent's high call volume accelerates conversion.** A data engineer working on a dbt project with 50 models might trigger 200+ lineage calls in a single session. The agent's aggressive, parallel lineage consumption means power users hit the 500-call free allowance within 2-3 working sessions -- precisely the users most likely to pay.

---

## Addressing the Local-State-Can-Be-Deleted Problem

This is the hardest constraint. Here is how each deletion scenario is handled:

### Scenario 1: User deletes `~/.altimate-code/.state`

The binary regenerates it on next call. But the Merkle chain tip is gone. The binary enters "verification mode": 50 additional free calls, then hard stop requiring online activation. This is intentionally more restrictive than the initial 500, because you already got your free trial.

### Scenario 2: User deletes `~/.altimate-code/license.key`

The binary falls back to the embedded default 500-call entitlement. But the state file still has the usage counter (if it exists). If both are deleted, see Scenario 1.

### Scenario 3: User reinstalls altimate-code entirely

New binary, new default token, state directory wiped. The user gets another 500 free calls. This is acceptable because:
- Reinstalling a CLI tool to get 500 more free calls is not a viable workflow for daily use
- Each reinstall loses all config, connections, and session history
- The friction of reinstalling a Python+Rust+Node toolchain every few days exceeds the $29/month cost
- This matches how JetBrains, Cursor, and Sublime Text handle reinstall-based trial resets: they accept the leakage because the users who would reinstall repeatedly were never going to pay anyway

### Scenario 4: User reverse-engineers the binary

altimate-core is compiled Rust -- not impossible to reverse-engineer, but the effort required to patch out Ed25519 signature validation in a stripped, optimized Rust binary is orders of magnitude higher than paying $29/month. This is the same security model used by every commercial desktop application: the goal is not to be unbreakable, but to make circumvention harder than payment.

---

## The First 30 Minutes

Here is exactly what a new user experiences:

**Minute 0-2: Install**
```bash
pip install altimate-code
# or
brew install altimate-code
```
No signup. No API key (for lineage -- BYOK for LLMs is separate). The tool starts working immediately.

**Minute 2-5: First Interaction**
User asks the agent to build a dbt model. The agent explores the project, reads existing models, and begins writing SQL.

**Minute 5-8: First Lineage Call (Invisible)**
The agent internally calls `column_lineage()` to understand how `stg_orders.order_id` flows through the pipeline. The Rust binary executes instantly (2ms), returns full column lineage. The agent uses this to write correct SQL joins. The user does not see the lineage call directly -- they see the agent writing better SQL than it would without lineage.

**Minute 8-15: Agent Uses Lineage Repeatedly**
Over the next few minutes, the agent calls lineage 15-30 times as it explores the project, validates column mappings, checks for PII flows, and verifies its output. Each call is 2ms. The user sees "Checking lineage..." flash in the agent's tool call log. The quality of the agent's output is noticeably high.

**Minute 15-25: User Asks a Direct Lineage Question**
"Where does the `customer_email` column end up in my warehouse?" The agent calls `track_lineage()` across all models and returns a complete map. The user's eyes widen. This is the "wow" moment -- the tool just answered in 3 seconds what would have taken 30 minutes of manual SQL tracing.

**Minute 25-30: User Keeps Working**
The agent continues using lineage. By minute 30, the user has consumed roughly 50-80 lineage calls and has no idea there is a limit. Everything just works. They have experienced the full value of the product.

No friction. No signup. No "14 days remaining" banner. Just a tool that works exceptionally well.

---

## What Triggers the Upgrade Moment

The upgrade moment is NOT time-based. It is usage-based. This is critical.

**Trigger: The 501st lineage call returns degraded output.**

The agent calls `column_lineage()` and gets back:
```json
{
  "table_lineage": [{"source": "raw_orders", "target": "stg_orders"}],
  "column_lineage": null,
  "upgrade_required": true,
  "message": "Column-level lineage requires activation. Run: altimate-code activate",
  "calls_used": 500,
  "calls_limit": 500
}
```

The agent surfaces this to the user:

> "I can see that `stg_orders` depends on `raw_orders`, but I can't trace the specific column mappings because column-level lineage requires activation. Run `altimate-code activate` to enable it. This is free for up to 200 calls/day, or unlimited on the Pro plan."

The user now faces a choice:
1. **Free activation** (email signup, 200 calls/day) -- enough for individual use
2. **Pro plan ($29/month)** -- unlimited, plus track_lineage and PII lineage
3. **Continue without** -- the agent still works, just with reduced lineage accuracy

The upgrade moment is powerful because:
- The user has already seen the value -- they are not being asked to trust a marketing page
- The degradation is visible -- the agent's output quality drops noticeably without column lineage
- The path forward is frictionless -- `altimate-code activate` takes 30 seconds
- There is a free tier -- the ask is not "pay me" but "give me your email"

---

## Real Products Using This Mechanism

### 1. Cursor (AI Code Editor)

Cursor uses exactly this pattern: a generous free allowance (2,000 completions + 50 premium requests per month), then degraded service (slow model responses only), then a clear upgrade path ($20/month Pro). The free tier's 50 GPT-4 requests "disappear in 2-3 coding sessions," creating a natural upgrade moment for power users. Cursor reached $100M ARR in under 2 years using this model.

**Parallel to altimate-code:** The AI agent is the consumer of the gated resource (model requests for Cursor, lineage calls for altimate-code). The user experiences the value through the agent's output quality, not by directly interacting with the gated feature. When the limit hits, the agent tells the user.

### 2. Semgrep (Static Analysis)

Semgrep ships a free open-source CLI (Semgrep CE) with single-file analysis. Cross-file taint analysis, cross-function analysis, and advanced rules are gated behind the commercial binary (Semgrep Pro). The commercial engine is a separate binary that validates a signed license. The free CLI gives you the "wow" moment (finding real bugs in your code), but serious security teams need cross-file analysis -- and that requires a license.

**Parallel to altimate-code:** The free tier gives real value (table-level lineage, basic SQL analysis), but the premium capability (column-level lineage, cross-model tracking) is gated inside a compiled binary that validates cryptographic credentials. The division is enforced in compiled code, not in deletable config.

### 3. JetBrains (IDE Suite)

JetBrains offers a 30-day trial with all features enabled. After 30 days, the IDE stops working until you purchase a license. The license is validated offline using a signed license key that the IDE verifies cryptographically. JetBrains' approach of "full features first, gate later" reportedly achieves 22% higher conversion than limited-feature trials. Over 15 million developers use JetBrains IDEs, with the company generating over $500M annually.

**Parallel to altimate-code:** The entitlement token model is identical -- a cryptographically signed payload validated inside a compiled binary. The key difference is that JetBrains uses time-based expiry while I propose usage-based expiry, which is more appropriate for a CLI tool where "30 days" might mean 2 hours of actual use for some developers and 200 hours for others.

---

## Expected Conversion Rate

Based on comparable products:

| Product | Free-to-Paid Conversion | Model |
|---------|------------------------|-------|
| Cursor | ~8-12% (estimated from ARR / user base) | Usage-limited free tier |
| GitHub Copilot | ~8.7% (1.3M paid / 15M total) | Usage-limited free tier |
| Semgrep | ~3-5% (enterprise security) | Feature-gated binary |
| JetBrains | ~10-15% (trial-to-paid) | Time-limited trial |
| PostHog | ~2% (98% use free tier) | Usage-based free tier |
| General SaaS freemium | 2-5% (industry average) | Various |

**My projection for altimate-code: 6-8% conversion from free-to-email-signup, 15-20% conversion from email-signup-to-paid.**

Here is the reasoning:

1. **Free-to-email-signup (6-8%):** The 500-call initial allowance filters to power users. Someone who hits 500 lineage calls is deeply using the tool. Of the total install base, maybe 30-40% will use lineage at all, and of those, ~20% will hit 500 calls. Of those who hit the limit, ~80% will provide an email for 200 free calls/day. This yields roughly 6-8% of total installs converting to email signup.

2. **Email-to-paid (15-20%):** Users who sign up for the free tier and actively use 200 calls/day are power users working on real dbt projects. When they hit the 200/day limit (which happens within 1-2 weeks for active users), or when they need `track_lineage` for cross-model PII tracking, the $29/month is trivially justified against the time saved. This is comparable to Cursor's Pro conversion among active free users.

3. **Composite conversion rate:** 7% * 17.5% = **~1.2% of total installs become paying users.** At $29/month, with 10,000 monthly active installs, this projects to ~120 paying users, or ~$42,000 ARR. At 50,000 MAI (achievable with open-source distribution), this scales to ~$208,000 ARR.

These numbers are conservative. The key lever is that usage-based gating naturally selects for users with the highest willingness to pay.

---

## The Biggest Weakness and Its Mitigation

### Weakness: The 500-call free allowance enables complete evaluation, so some users will "burst evaluate and leave"

A sophisticated user could install altimate-code, run their entire dbt project through lineage in a single session (consuming all 500 calls), extract all the lineage data they need, and never pay. They get the full value once, for free, and leave.

This is the fundamental tension of any free trial: some users extract maximum value during the trial and never convert. For lineage specifically, this is worse than for a SaaS product because lineage data for a given codebase is relatively static -- once you have the lineage map, you do not need to regenerate it constantly.

### Mitigation: Make lineage a continuously consumed resource, not a one-time extraction

Three concrete strategies:

**1. The agent consumes lineage on every interaction, not just the first.**
The agent calls lineage every time it writes or modifies SQL, not just when the user asks "show me lineage." This means the 500 free calls are consumed through normal agent-assisted development, not through a one-time lineage dump. A user who modifies 10 models in a day triggers 50-100 lineage calls from the agent alone. The burst-and-leave user would need to stop using the agent entirely to avoid consuming their allowance.

**2. Track lineage results are ephemeral, not cached.**
The `column_lineage()` function returns results but does not persist them to a file. The agent uses them in context and they disappear with the session. To get lineage data again (for a different question, a different session, or after a code change), the user must call lineage again. This makes lineage a continuous consumption resource, not a one-time extraction.

**3. The 200 free calls/day on the free tier is genuinely generous for individuals.**
The real conversion moment is not "free vs paid" but "individual vs team." An individual data engineer working on a personal project gets 200 calls/day for free forever. The paid tier ($29/month) is for professional use where the engineer is burning through 500+ calls/day across large projects. The burst-and-leave user who extracted value from 500 calls was probably an individual who would not have paid anyway. The professional user who needs lineage daily will convert naturally.

**The weakness is real but bounded.** The users who would exploit the free allowance and leave overlap heavily with the users who would never pay regardless of the gating mechanism. The mechanism's strength is that it maximizes conversion among the users who matter: professional data engineers working on production dbt projects who need lineage continuously.

---

## Implementation Roadmap

### Phase 1: Binary-side (altimate-core, Rust) -- 2-3 weeks

1. Generate Ed25519 keypair, store private key in Altimate's secrets vault
2. Embed public key in altimate-core binary
3. Create default 500-call entitlement token, embed in binary
4. Implement `~/.altimate-code/.state` encrypted ledger (AES-256-GCM)
5. Add machine fingerprint derivation (hostname + username + fallback UUID)
6. Add entitlement check to `column_lineage()` and `track_lineage()` functions
7. Return `upgrade_required: true` in response when over limit
8. Implement external token loading from `~/.altimate-code/license.key`
9. Implement Ed25519 signature validation for external tokens

### Phase 2: Server-side (token issuance) -- 1-2 weeks

1. Build `/api/activate` endpoint (email + password signup)
2. Issue free-tier entitlement tokens (200 calls/day, no expiry)
3. Build `/api/license` endpoint (Stripe checkout for Pro plan)
4. Issue paid-tier entitlement tokens (unlimited, 1-year expiry)
5. Build token refresh flow (tokens auto-renew if subscription active)

### Phase 3: CLI-side (altimate-code, TypeScript) -- 1 week

1. Add `altimate-code activate` command (OAuth device flow or paste-token)
2. Surface `upgrade_required` responses in agent output
3. Add `altimate-code status` to show current entitlement

### Phase 4: Agent-side (prompt updates) -- 2 days

1. Update agent system prompt to handle `upgrade_required` responses gracefully
2. Agent explains what happened and suggests next steps
3. Agent continues working with table-level lineage when column-level is unavailable

---

## Why This Mechanism and Not the Others

| Alternative | Why it loses |
|---|---|
| Feature-gating (single-model free) | Agent loops through models, reconstructing full graph |
| Local rate limiting (N/day in config file) | User deletes config, counter resets, no enforcement |
| Hard paywall | Zero trial, zero conversion, users never experience value |
| Time-limited trial (14 days) | Resets on reinstall, feels hostile, penalizes casual users who only use the tool twice a month |
| Server-side validation on every call | Adds latency to a 2ms operation, requires internet, breaks local-first promise |
| Honor system / telemetry nudge | Developers ignore nudges and disable telemetry |

The entitlement token model is the only mechanism that simultaneously:
- Gives users immediate, full-featured access (no signup for first 500 calls)
- Creates a natural, usage-based upgrade moment (not time-based)
- Enforces the gate inside compiled Rust code (not in deletable local state)
- Works offline (token validation is pure cryptography, no network needed)
- Handles the agent-as-consumer transparently (binary-level enforcement)
- Degrades gracefully (table-level lineage still works, agent still functions)

This is the mechanism. Build it.

---

## References

- [Keygen: Offline Licensing Model](https://keygen.sh/docs/choosing-a-licensing-model/offline-licenses/)
- [Keygen: Ed25519 License Files in Rust](https://github.com/keygen-sh/example-rust-cryptographic-license-files)
- [Cursor AI Pricing](https://cursor.com/pricing)
- [GitHub Copilot Statistics & Adoption Trends](https://www.secondtalent.com/resources/github-copilot-statistics/)
- [GitHub Copilot Plans & Pricing](https://github.com/features/copilot/plans)
- [Semgrep Licensing](https://semgrep.dev/docs/licensing)
- [Semgrep Pro vs OSS](https://semgrep.dev/docs/semgrep-pro-vs-oss)
- [JetBrains Pricing](https://www.jetbrains.com/store/)
- [PostHog Revenue & Valuation (Sacra)](https://sacra.com/c/posthog/)
- [SaaS Freemium Conversion Rates: 2026 Report (First Page Sage)](https://firstpagesage.com/seo-blog/saas-freemium-conversion-rates/)
- [Freemium Conversion Rate Benchmarks (Guru Startups)](https://www.gurustartups.com/reports/freemium-to-paid-conversion-rate-benchmarks)
- [Nx Cloud Pricing](https://nx.dev)
- [Snyk Plans and Pricing](https://snyk.io/plans/)
- [Vercel Pricing](https://vercel.com/pricing)
- [Cryptlex Software Licensing](https://cryptlex.com/)
- [ed25519-dalek Rust crate](https://docs.rs/ed25519-dalek/)
