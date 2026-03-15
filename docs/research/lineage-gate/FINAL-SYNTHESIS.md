# Final Synthesis: The Lineage Gate Decision

**Date:** 2026-03-07
**Status:** Definitive recommendation for founder decision

---

## 1. VERDICT

**Gate lineage on depth, not access. Give every user column-level lineage from the first second. Vary the richness of what the binary returns based on a cryptographically signed license token validated inside the compiled Rust binary. Monetize the professional ceiling above free lineage, not lineage itself.**

Here is why.

The debate produced eight papers spanning 40,000+ words. After reading all of them, one fact dominates: **altimate-code is an agent-native, BYOK, local-first tool, and every traditional freemium playbook breaks against at least one of those properties.** The agent silently consumes lineage, so feature-access gates produce invisible degradation the human misattributes to the LLM. The tool is local-first, so server-side enforcement violates the product identity. The tool is BYOK, so there is no inference margin to fund a loss-leader free tier. And the binary ships to the user's machine, so anything stored locally can be deleted.

Given those constraints, the only mechanism that simultaneously (a) delivers the full "wow" moment, (b) creates a visible and recurring conversion trigger, (c) is enforceable inside compiled Rust code, and (d) works when an AI agent is the consumer, is **output depth differentiation** -- the same tools, different richness of response, enforced in the binary, narrated by the agent.

This is not the Monetization Architect's call-count gate, though it borrows the cryptographic token infrastructure. It is not the PLG Expert's "free everything and pray for a ceiling," though it agrees that lineage must be experienced. It is the Agent Product Designer's Depth Gate, hardened with the Monetization Architect's enforcement mechanism, tempered by the Contrarian's objections, and priced according to the Practitioner's willingness-to-pay data.

---

## 2. CONSENSUS MAP

### What the papers agree on

Every paper agrees on five things:

1. **Lineage must be experienced before any gate activates.** Not one paper argues for a hard paywall on first use. The disagreement is about when and how the gate appears, not whether the user should try lineage first.

2. **Local state enforcement alone is insufficient.** All papers acknowledge that config files, SQLite counters, and dotfiles can be deleted. The enforcement must involve something harder to bypass.

3. **The compiled Rust binary is the enforcement point.** All papers that propose a mechanism place the gate inside altimate-core, not in TypeScript or Python. This is the one architectural advantage for monetization.

4. **The agent-as-consumer problem is real and novel.** No paper dismisses it. The agent cannot feel frustration, cannot see upgrade prompts, and cannot be motivated to pay. This breaks traditional freemium.

5. **$29/month is the correct individual price point.** Below manager approval thresholds. Below the psychological $30 boundary. Justified by a single prevented production incident.

### What they disagree on

| Question | Papers For | Papers Against |
|----------|-----------|----------------|
| Should lineage itself be gated? | 04 (Monetization Architect), 06 (Agent Designer) | 05 (PLG Expert), 08 (Contrarian), 07 (Practitioner) |
| Is call-count gating viable? | 04 (500 free calls) | 06 (credit budgets are poor fit for agents), 08 (local counters bypassable) |
| Is depth-based gating viable? | 06 (primary recommendation) | 08 (first impressions are permanent -- degraded output looks broken) |
| Should lineage be fully free? | 05 (monetize what lineage enables), 08 (give it all away) | 04 (free = no revenue ever) |
| Is signup-before-value acceptable? | 04 (after 500 calls) | 05, 07, 08 (60-80% drop-off) |

### Argument strength scores

| Paper | Score (1-10) | Reasoning |
|-------|-------------|-----------|
| 01 - DevTools Monetization Research | 8 | Excellent factual foundation. Every mechanism taxonomized with real revenue data. No opinion offered -- pure research. |
| 02 - AI Tools Monetization Research | 8 | Critical insight: bill per message, not per agent step. Best coverage of how AI tools actually gate. |
| 03 - Local-First Freemium Research | 9 | The strongest research paper. JetBrains, GitLab, and Keygen.sh case studies provide the engineering blueprint. Agent-aware credit metering proposal is the most technically grounded. |
| 04 - Monetization Architect | 7 | Strongest concrete mechanism. Ed25519 tokens + Merkle chain is well-engineered. Weakness: the 500-call counter is still fundamentally a local counter with extra obfuscation, and agents burn through 500 calls in 2-3 sessions, making the "free" experience very short. |
| 05 - PLG Conversion Expert | 8 | Best articulation of the attribution problem and why gating lineage kills the dependency formation cycle. The "monetize the ceiling, not the engine" framing is the single most important strategic insight in the debate. Weakness: the proposed paid features (multi-project lineage, lineage history, export) may not be strong enough to convert at $29/month. |
| 06 - Agent Product Designer | 9 | The most original paper. The Depth Gate is the best mechanism proposed. "Same tools, different richness" solves both the agent problem (no workflow interruption) and the attribution problem (agent narrates the gap). The evaluation mode (full depth for 5 sessions) is the right first-use experience. |
| 07 - Data Engineer Practitioner | 8 | The reality check the debate needed. "Sell me a better agent, not lineage" is the clearest statement of how users actually think. The competitive landscape analysis (SDF, SQLMesh, Datafold) grounds the debate in market reality. CI integration as the enterprise wedge is the most actionable insight. |
| 08 - Contrarian | 7 | Every objection is technically valid. The "2ms problem" (fast local computation feels like it should be free) is a real psychological barrier. The agent-breaks-freemium analysis is the sharpest in the debate. Weakness: the paper's own "least bad option" is not meaningfully different from what Papers 04 and 06 propose, which undercuts the strength of the objections. Also, "give it all away" requires platform investment and runway the founder may not have. |

---

## 3. THE CORE TENSION RESOLVED

Three approaches were proposed. Here is why I pick the middle path and reject the other two.

### Rejected: Gate lineage calls (Paper 04)

The Monetization Architect proposes 500 free calls enforced via an encrypted ledger and Merkle chain inside the binary. This is clever engineering applied to the wrong unit of gating.

The problem: an AI agent working on a 50-model dbt project burns through 200+ lineage calls in a single session. 500 calls means 2-3 sessions before the gate hits. That is not enough time to form the dependency that drives conversion. The user has seen lineage work for two afternoons, then it disappears. They have not yet integrated it into their daily workflow. They have not yet had the "it saved me from a P1" moment. They hit a wall and think "I'll come back to this later" -- and they do not come back.

Call-count gating also creates perverse incentives for the agent. The agent should call lineage whenever it helps. A call budget makes the agent (or its orchestrator) ration a capability based on price, not value. This degrades the product for everyone.

Finally, the Contrarian is right that 500 calls is still fundamentally a local counter. The Merkle chain and encrypted ledger are obfuscation, not enforcement. A determined user reinstalls and gets 500 more. The friction of reinstalling is real but not $29/month worth of friction for many users.

### Rejected: Don't gate lineage at all (Papers 05, 08)

The PLG Expert and Contrarian argue that lineage should be completely free and monetization should come from what lineage enables at professional scale: multi-project analysis, lineage history, CI integration, compliance reports, exportable artifacts.

This is strategically correct for a well-funded company with 18+ months of runway and the team to build a platform. It is strategically dangerous for a company that needs to demonstrate a path to revenue. The proposed paid features (multi-project lineage, lineage diff, export) are real but not yet built. Giving away the one thing that is built and differentiating, and hoping that future features will monetize, is a bet on execution speed.

The Contrarian's own analysis is honest about this: "The nuclear option is the strategically correct choice for a well-funded company... and the strategically suicidal choice for a bootstrapped company that needs revenue in the next two quarters."

More importantly, the "give it all away" approach has a specific vulnerability the PLG Expert does not address: if full lineage is free forever, the user never experiences a quality gap, and the conversion trigger depends entirely on hitting a "professional ceiling" that may be months away. The median developer tool converts 5% of users. Without any mechanism to surface the gap between free and paid, the conversion rate will be at or below that median.

### Selected: Gate lineage depth (Paper 06, modified)

The Agent Product Designer's Depth Gate is the right mechanism because it solves the three problems simultaneously:

1. **It preserves the "wow" moment.** The agent always gets lineage. It always produces better SQL because of lineage. The user always sees the quality difference compared to tools without lineage. There is no workflow interruption, no "lineage unavailable" error, no degraded agent.

2. **It creates a visible, recurring conversion trigger.** When the agent uses basic lineage and encounters a depth limitation, it tells the human: "I found the column mapping. With deeper analysis, I could also trace the transformation chain and verify no PII flows through this path." This happens organically during real work. The agent is the salesperson.

3. **It is enforceable in the binary.** The Rust binary runs the same analysis code. The output filtering -- stripping transform descriptions, truncating transitive paths, omitting PII annotations -- is a small piece of logic inside compiled code. There is no "premium endpoint" to reconstruct from free endpoints. The information simply is not in the free response.

**Critical modification from Paper 06:** I reject the "evaluation mode" (5 sessions of full-depth lineage, then fallback to basic). The Contrarian is right that first impressions are permanent. If the user experiences full-depth lineage and then loses it, they feel punished. Instead, the free tier should always return the same level of depth -- basic column-level lineage -- from day one. The quality is consistent. The agent narrates what additional depth is available. There is no bait-and-switch.

This means the free tier must be good enough that the agent produces genuinely useful output. Basic column-to-column edges without transform descriptions are sufficient for the agent to write correct JOINs, trace column dependencies, and perform basic impact analysis. The paid tier adds transform chains, confidence scores, CTE-internal tracing, transitive closure, and PII flow annotations -- capabilities that matter for professional-grade work but are not necessary for the initial experience.

---

## 4. THE SPECIFIC MECHANISM

### What is free forever (no limits, no signup)

- Column-level lineage: source_column to target_column edges for any SQL/dbt model
- Direct parent/child relationships (depth-1 lineage)
- Basic impact analysis ("this column feeds these direct downstream columns")
- All agent tools that consume lineage (the tools work, the depth varies)
- Unlimited calls, no counter, no rate limit
- All non-lineage features: SQL analysis, validation, schema introspection, dbt integration
- Full BYOK agent capabilities

This is not a crippled free tier. This is a genuine product. A user who never pays still gets column-level lineage that is better than anything available in dbt-core, and an agent that writes better SQL because of it.

### What requires a free account (email signup)

Nothing. There is no free-account gate. The first upgrade step is payment.

This is a deliberate decision. The PLG Expert's data shows 60-80% drop-off at signup forms. The Practitioner explicitly states: "I will not create an account before seeing if it works." The Contrarian notes: "The agent cannot sign up." Every paper that mentions signup friction argues against it.

The free tier requires zero signup, zero configuration, zero network connectivity for lineage. Install and use.

### What requires payment ($29/month Pro)

- **Deep lineage:** Transform descriptions (COALESCE, CASE, etc.), confidence scores per edge, CTE-internal column flow tracing
- **Transitive lineage:** Full transitive closure across multi-hop paths (depth-N, not depth-1)
- **PII flow annotations:** Automatic detection and annotation of sensitive column flows
- **Cross-model manifest lineage:** Full-project lineage graph via dbt manifest (not just single-model)
- **Semantic annotations:** Aggregation detection, type coercion tracking, filter propagation
- **CI integration:** `altimate lineage check` command for PR reviews (column-level impact as PR comment)
- **Lineage export:** JSON, SVG, markdown export of lineage graphs for documentation and compliance

### How is it enforced technically

**Mechanism: Ed25519-signed license token controlling output depth inside the compiled Rust binary.**

1. **Binary ships with Altimate's Ed25519 public key** hardcoded (~32 bytes).

2. **Without a license token:** The binary runs in free mode. All lineage functions execute and return results. The output is filtered to depth-1 edges, no transform descriptions, no PII annotations, no transitive closure. The response includes a `tier: "free"` field and a `depth_limited` array listing what additional information would be available at Pro tier.

3. **With a valid license token:** The user purchases Pro at `altimate.ai/pro`. They receive a signed license token (Ed25519-signed JSON):

```json
{
  "v": 1,
  "uid": "user_abc123",
  "tier": "pro",
  "features": ["deep_lineage", "pii_flow", "transitive", "ci_check", "export"],
  "iat": 1741305600,
  "exp": 1772841600
}
```

4. **Token stored at `~/.altimate-code/license.key`.** The binary validates the signature against the embedded public key on each lineage call. No network required for validation.

5. **Token expires after 12 months.** Renewal requires one network call to `license.altimate.ai`. The binary does not phone home for daily validation. It checks the local token's expiry date against the system clock. Clock tampering is accepted as a minor leakage (matches JetBrains' tolerance).

6. **No machine fingerprint.** Machine fingerprinting adds friction (fails on cloud instances, VMs, new laptops) and annoys legitimate users more than it deters pirates. The token is portable. If a user shares their token, that is license violation, not a technical problem. Enterprise customers comply for legal reasons. Individual pirates were never going to pay.

7. **No usage counter.** No Merkle chain, no encrypted ledger, no state file. The gate is output depth, not call count. There is nothing to delete, nothing to reset, nothing to bypass by reinstalling. The binary either has a valid token (full depth) or it does not (basic depth).

This is the simplest possible enforcement: a signed token checked against a public key, controlling which fields are included in the output. No server dependency for validation. No local state to manage. No anti-tampering arms race.

### What does the first hour feel like for a new user

**Minute 0-2:** Install via `pip install altimate-code` or `brew install altimate-code`. No signup. No configuration for lineage (BYOK for LLM is separate).

**Minute 2-10:** User asks the agent to work on their dbt project. The agent explores the project, reads models, writes SQL. Internally, the agent calls `column_lineage()` repeatedly. The Rust binary returns basic lineage (depth-1 edges). The agent uses these edges to write correct JOINs and trace column dependencies. The user sees the agent produce SQL that is noticeably better than without lineage context.

**Minute 10-20:** The agent's output includes a reasoning trail:

```
Used: column_lineage (traced 8 columns from stg_orders)
[Pro insight available: transformation chain, PII flow detection, full transitive graph]
```

The user sees this footnote but does not need to act on it. The agent is working well.

**Minute 20-40:** User asks "what happens if I rename `user_id` to `account_id` in `stg_payments`?" The agent calls lineage and traces the direct downstream columns:

```
I traced user_id from stg_payments to 3 direct downstream columns:
- int_payment_metrics.user_id
- fct_revenue.user_id
- fct_payment_summary.user_id

With deeper lineage analysis, I could also trace the full transitive impact
(columns that reference these through additional transformations) and verify
no PII columns are affected. Run altimate-code upgrade for full analysis.
```

The user gets a useful answer (3 direct downstream references). They also see exactly what they are missing (transitive impact, PII check). This is the first conversion trigger.

**Minute 40-60:** The user continues working. Every few interactions, the agent mentions depth limitations in context. "I found the basic column mapping, but the transformation logic through the COALESCE expression is only traceable with Pro lineage." These mentions are specific to the user's actual code, not generic upsell messages.

The user has now worked for an hour with a tool that is genuinely useful at the free tier. They have seen multiple specific, contextualized examples of what deeper analysis would provide. They have not been interrupted, blocked, or asked to sign up.

### What triggers the upgrade moment

The upgrade moment is not a wall. It is an accumulation. After 5-10 sessions where the agent mentions depth limitations in context, the user has seen enough specific examples to know what they are missing. The trigger is one of:

1. **Incident prevention:** "I can see direct downstream dependencies but not transitive ones. With Pro lineage, I could verify that this rename does not break models three hops downstream." The user remembers the last time a transitive dependency broke production.

2. **PII compliance:** "I detected that `email` flows from `stg_users` to `int_user_orders`. Pro lineage would trace all PII flows across the entire project for compliance reporting." The user has a SOC 2 audit coming up.

3. **Team adoption:** The user shows the lineage output to a colleague. The colleague says "can it trace the full transformation chain?" The user says "that requires Pro." The colleague's manager buys team licenses.

4. **CI integration:** The user wants `altimate lineage check` in their CI pipeline. This is a Pro feature because it uses full-project manifest lineage. The CI use case naturally requires organizational-scale analysis.

### How does it work when the AI agent is the consumer

The agent does not know or care about the gate. It calls `column_lineage()` through the bridge. The Rust binary returns a response with a `tier` field and optional `depth_limited` metadata.

The TypeScript tool layer reads these fields and appends attribution to the tool result:

```typescript
if (result.tier === "free" && result.depth_limited?.length > 0) {
  toolOutput += `\n[Pro insight available: ${result.depth_limited.join(", ")}]`;
}
```

The agent's system prompt includes instructions:

```
When lineage results include depth limitations, naturally mention what
additional analysis would be available with Pro. Frame it as additional
insight you could provide, not as a missing feature. Continue working
with the information available. Never block the workflow.
```

The agent never stops working. It never says "lineage is unavailable." It says "I found X, and with deeper analysis I could also determine Y." The human sees this as the agent being transparent about its analytical depth, not as a sales pitch.

---

## 5. THE AGENT ATTRIBUTION PROBLEM

When the agent uses lineage silently, the human does not know lineage is the reason the output is good. This is the hardest problem in the debate, and the Depth Gate solves it structurally.

### Why the Depth Gate inherently solves attribution

In a call-count model, the agent either has lineage (full output) or does not (no lineage). When it has lineage, the human sees good output and does not know why. When it loses lineage, the human sees bad output and does not know why. There is no moment of attribution.

In the Depth Gate model, the agent always has lineage, but the response includes explicit metadata about what deeper analysis would reveal. The agent narrates this naturally:

```
I traced customer_id from stg_customers to fct_revenue (direct dependency).
With full transitive lineage, I could verify the complete path through
int_customer_orders and confirm no transformation alters the join key.
```

This is attribution built into the product flow. The human learns three things simultaneously:
1. Lineage exists and the agent is using it
2. Lineage has depth levels
3. The current depth is limited, and more is available

### Three supporting attribution mechanisms

**1. Reasoning trail (lightweight, always present):**
Every agent response that used lineage includes a one-line footer:
```
Used: column_lineage (traced 8 columns, depth-1) | sql_validate | schema_check
```
This is not an upsell. It is transparency. It teaches the user that lineage is a tool the agent uses, and "depth-1" plants the seed that deeper depths exist.

**2. Impact statement (event-driven, when lineage prevents a mistake):**
When the agent uses lineage to avoid a problem, it says so:
```
I noticed that changing user_id in stg_orders affects 3 downstream models.
I've updated all three. (Detected via column-level lineage.)
```
This is the highest-value attribution moment. The human just watched the agent save them from a production incident because of lineage.

**3. Weekly summary (periodic, optional):**
For users who have been active for 7+ days:
```
This week, column lineage helped your agent:
- Trace 1,247 column dependencies
- Identify 4 cross-model references during refactoring
- Basic depth: direct parent/child only

Pro lineage would add: transformation chain tracing, PII flow detection,
full transitive impact analysis.
```

This is a digest, not a popup. It appears once per week in the CLI output after the first command of the day. It can be disabled with a config flag.

---

## 6. PRICING AND PACKAGING

### Tier 1: Free (forever, no signup)

| What's included | Limits |
|----------------|--------|
| Column-level lineage (depth-1: direct parent/child edges) | Unlimited calls |
| Basic impact analysis (direct downstream columns) | Unlimited |
| All agent tools (SQL analysis, validation, schema introspection) | Unlimited |
| dbt integration (model exploration, project understanding) | Unlimited |
| BYOK LLM agent | Unlimited |
| Lineage reasoning trails in agent output | Always on |

**Target user:** Individual data engineer evaluating the tool, hobbyist, open-source contributor.

**Conversion mechanism:** Agent narrates depth limitations in context. No blocking, no interruption.

### Tier 2: Pro ($29/user/month, annual billing $24/user/month)

| What's added over Free | Details |
|------------------------|---------|
| Deep lineage (transform descriptions, confidence scores) | Full transformation chain visibility |
| Transitive lineage (full multi-hop closure) | Trace columns across N models, not just direct parents |
| CTE-internal column flow | Trace data flow inside CTEs, not just CTE inputs/outputs |
| PII flow detection and annotation | Automatic sensitive column tracking |
| Cross-model manifest lineage | Full-project dependency graph via dbt manifest |
| Semantic annotations | Aggregation detection, type coercion, filter propagation |
| CI check command | `altimate lineage check` for PR reviews |
| Lineage export | JSON, SVG, markdown for documentation/compliance |

**Target user:** Professional data engineer on a real dbt project. Data team of 1-5 trying the tool before team-wide adoption.

**License:** Self-serve purchase at `altimate.ai/pro`. Offline Ed25519-signed token. No phone-home for daily use. Annual renewal requires one network call.

**Conversion from Free:** Expected 4-7% of active free users, based on:
- DevTools median is 5% (Growth Unhinged 2026)
- Depth Gate provides continuous, contextual conversion triggers (above median)
- No signup friction in the free tier (removes one conversion barrier)
- $29/month is below approval threshold (removes another barrier)
- But BYOK + local-first tools convert at the lower end of the range

### Tier 3: Team ($49/user/month, minimum 5 seats, annual billing $39/user/month)

| What's added over Pro | Details |
|----------------------|---------|
| Team license management | Central admin, seat management |
| Shared lineage configuration | Team-wide settings, shared exclusion lists |
| CI/CD integration with PR comments | Automated lineage impact as GitHub/GitLab PR comment |
| PII flow compliance reports | Exportable audit reports for SOC 2 / GDPR |
| Priority support | Response within 1 business day |

**Target user:** Data team of 5-50 at a mid-sized company. The "manager purchase" triggered by individual adoption.

**Conversion from Pro:** Expected 15-25% of Pro users who are on teams. The CI integration is the wedge -- once one engineer uses lineage in CI, the manager mandates it for the team. This is the Practitioner's prediction: "That's 15 seats at $49/month."

### Tier 4: Enterprise ($100-150/seat/month, custom)

| What's added over Team | Details |
|-----------------------|---------|
| SSO/SAML | Enterprise identity management |
| Audit logging | Who ran what lineage analysis, when |
| Custom data classification policies | Organization-specific PII rules |
| Air-gapped deployment support | Offline license renewal, no network dependency |
| Dedicated support + SLA | Named support engineer, 4-hour response |
| Volume discounts | Tiered pricing for 50+ seats |

**Target user:** Enterprise data team at a Fortune 500. Typically enters through team adoption, then procurement formalization.

**Note:** The Practitioner warns that most of these features (SSO, audit logs, RBAC) are not things individual data engineers care about. They are things procurement departments require. Price them accordingly and do not waste engineering effort on them until there is demand from actual enterprise prospects.

---

## 7. WHAT THE CONTRARIAN GOT RIGHT

The Contrarian raised seven major objections. Here is my assessment of each.

### Fatal objections (must be addressed in the recommendation)

**1. "First impressions are permanent. Showing degraded output looks broken."**

This is the strongest objection and it forced a critical modification. The original Depth Gate proposal (Paper 06) included an "evaluation mode" -- 5 sessions of full-depth lineage, then fallback to basic. The Contrarian is right: this is a bait-and-switch. The user experiences full depth, loses it, and feels punished.

**Resolution:** No evaluation mode. The free tier is consistent from day one. Basic depth always. The user never experiences a downgrade. The conversion trigger is the agent narrating what additional depth is available, not the removal of something the user previously had.

**2. "The 2ms problem -- fast local computation feels like it should be free."**

Users have strong intuitions about what should cost money. Cloud compute and API calls feel paid. A 2ms local computation feels free. Charging for the computation itself creates resentment.

**Resolution:** This is why the Depth Gate works better than a call-count gate. The user is not paying for "lineage calls." The user is paying for "deeper analysis, PII detection, transitive impact, and CI integration." The framing is capability, not computation. The 2ms computation is free. The analytical depth is paid.

**3. "Agents reconstruct what you gate."**

If you gate full-project lineage and provide single-model lineage for free, the agent calls single-model lineage on every model and reconstructs the full graph.

**Resolution:** The Depth Gate is resistant to this attack because the gated information (transform descriptions, confidence scores, PII annotations, CTE-internal flow) cannot be reconstructed from basic column edges. The information simply is not in the free response. The agent cannot reconstruct "this column passes through a COALESCE with a NULL default" from a basic edge that says "column A feeds column B."

### Manageable objections (real but bounded)

**4. "Binary patching is not as hard as you think."**

The Contrarian correctly notes that Ghidra and Frida exist. A motivated developer could patch out the license check.

**Assessment:** True but irrelevant for revenue. The users who would reverse-engineer a Rust binary to avoid $29/month are not the users who generate revenue. Enterprise customers (80%+ of devtools revenue) will not use patched binaries -- compliance departments prohibit it. The Monetization Architect's analysis is correct: "the goal is not to be unbreakable, but to make circumvention harder than payment."

**5. "The agent does not see upgrade prompts."**

In a traditional freemium model, the agent does not relay "upgrade to Pro" messages to the human.

**Assessment:** This is why the Depth Gate includes agent-driven attribution as a structural component, not an afterthought. The agent does not relay a generic "upgrade" message. The agent says "I found X, and with deeper analysis I could also determine Y." This is natural language narration, not a paywall prompt. The agent is designed to surface this because the depth limitation is part of the analytical result, not a marketing overlay.

**6. "Phone-home violates local-first."**

Any license validation that requires network connectivity violates the product's identity.

**Assessment:** This is why the recommendation uses offline Ed25519 token validation with annual renewal, not daily phone-home. The token ships as a file. The binary validates the signature locally. Network is required once per year for renewal. Air-gapped deployments are supported on the Enterprise tier with extended offline validity (3 years). This is the same model JetBrains uses for offline activation.

### Objections that are valid but do not change the recommendation

**7. "Give it all away and build a platform."**

The Contrarian argues (and the PLG Expert agrees) that lineage should be fully free and monetization should come from an organizational platform.

**Assessment:** This is the right long-term strategy. It is the wrong near-term strategy. Building a platform requires 12-18 months of engineering, infrastructure, SOC 2 certification, and sales capacity. The Depth Gate generates revenue in 4-6 weeks (Phase 1-3 of implementation) while the platform is built. The Depth Gate is not permanent -- it is a bridge. When the platform exists, lineage depth can be made free for everyone, and the paid tiers shift to platform capabilities. But shipping a bridge is better than shipping nothing while the bridge is being built.

---

## 8. IMPLEMENTATION PRIORITY

### Phase 1: Output tiering in altimate-core (Week 1-2)

**Engineering effort:** Medium. Modify the lineage response path in the Rust binary.

- Define two output formats: `basic` and `deep`.
- `basic`: column-to-column edges, depth-1 only, no transform descriptions, no confidence scores, no PII annotations.
- `deep`: full response (current output).
- Add a `tier` field and `depth_limited` array to every lineage response.
- Gate on a boolean flag initially (hardcoded to `basic` for testing).
- Test that the agent produces useful output with `basic` depth.

This is the highest-risk phase. If basic depth is not useful enough for the agent to produce good SQL, the entire strategy fails. Validate this with real dbt projects before proceeding.

### Phase 2: License token validation (Week 3-4)

**Engineering effort:** Medium. Ed25519 signature validation in Rust + token generation server.

- Generate Ed25519 keypair. Store private key in secrets vault.
- Embed public key in altimate-core binary.
- Implement token loading from `~/.altimate-code/license.key`.
- Validate token signature, expiry, and tier on each lineage call.
- If valid Pro token: return `deep` output. Otherwise: return `basic` output.
- Build a minimal token issuance endpoint at `license.altimate.ai` (Cloudflare Worker, stateless JWT signing).
- Stripe Checkout integration for $29/month Pro plan.

### Phase 3: Agent attribution (Week 5-6)

**Engineering effort:** Small. TypeScript tool formatters + agent prompt updates.

- Read `tier` and `depth_limited` from binary response.
- Append attribution line to tool output when depth is limited.
- Update agent system prompt with instructions for narrating depth limitations.
- Add reasoning trail footer to all agent responses that used lineage.
- Test that attribution messages are natural and non-intrusive.

### Phase 4: CI integration (Week 7-10)

**Engineering effort:** Medium-large. New CLI command + GitHub/GitLab integration.

- Implement `altimate lineage check` CLI command.
- Compare lineage before and after a code change.
- Output affected downstream columns as structured report.
- GitHub Actions integration: post lineage impact as PR comment.
- This is a Pro feature -- requires valid license token.

CI integration is the enterprise wedge. The Practitioner says: "This PR affects these downstream models/dashboards as a PR comment -- $29/month, no hesitation." The Team tier ($49/user/month) naturally follows when managers mandate CI checks for the whole team.

### Phase 5: Team and Enterprise tiers (Week 11-16)

**Engineering effort:** Medium. Team license management, compliance reports.

- Team license tokens (multiple seats under one organization).
- PII flow compliance report export.
- Team configuration sharing.
- Basic admin dashboard.

### What can wait

- SSO/SAML (build only when an enterprise customer requests it)
- Audit logging (build only when an enterprise customer requests it)
- Web UI / dashboard (the Practitioner explicitly says they do not want this)
- Historical lineage / lineage versioning (the Practitioner explicitly says they do not care)
- Cross-warehouse lineage (most users have one warehouse)
- Weekly summary emails (nice-to-have, not a conversion driver)

---

## 9. BLIND SPOTS

The debate missed or underexplored several important questions.

### 1. What if basic lineage is too good?

The entire strategy depends on a quality gap between basic and deep lineage that is large enough to justify $29/month. If basic column-to-column edges give the agent 90% of the information it needs, the conversion rate will be near zero. No paper rigorously analyzed what percentage of agent lineage use cases require depth beyond basic edges.

**Action required:** Before building the Depth Gate, instrument the current agent to measure how often it uses transform descriptions, transitive closure, PII annotations, and CTE-internal flow. If it rarely uses these features, the quality gap is too small and the strategy needs revision.

### 2. What if basic lineage is too bad?

Conversely, if depth-1 edges without transform descriptions produce an agent that writes incorrect SQL (wrong JOINs, missed coercions), the free tier looks broken. The Contrarian warns: "Showing something bad closes the door."

**Action required:** Test the agent with basic-depth lineage on real dbt projects. If the agent produces incorrect output, the basic tier must include more information (e.g., transform descriptions but not transitive closure). The line between basic and deep must be drawn based on empirical testing, not theory.

### 3. The SQLMesh/SDF competitive response

The Practitioner identifies SDF and SQLMesh as direct competitors with built-in column-level lineage. Both are free. If altimate-code gates any aspect of lineage, users can switch to these tools for the lineage component. No paper analyzes the competitive dynamics deeply enough.

**Action required:** The free tier must be competitive with SDF and SQLMesh on basic lineage. The paid tier must be differentiated on features they do not offer (PII flow tracking, CI integration, agent-native depth analysis). If SDF ships PII flow tracking for free, the paid tier's value proposition weakens.

### 4. The "agent as bypass" problem is underexplored

Paper 08 notes that "if you gate any analytical feature and the agent has access to ungated primitives, the agent will reconstruct the gated feature from the primitives." The Depth Gate is resistant to this because transform descriptions cannot be reconstructed from edges. But what about transitive closure? The agent could call depth-1 lineage on each model and reconstruct the full transitive graph. This does not recover transform descriptions or PII annotations, but it does recover the graph structure.

**Assessment:** This is acceptable leakage. The agent can reconstruct the graph structure but not the metadata (transforms, confidence, PII). The metadata is the primary value of deep lineage. The graph structure alone is useful but not sufficient for professional-grade impact analysis.

### 5. No paper addresses the migration path

If the Depth Gate works and generates revenue, what happens in 18 months when the platform is built? Do you make deep lineage free and shift monetization to the platform? How do you communicate this to existing paying customers without the Contrarian's "bait-and-switch" complaint?

**Action required:** Plan the migration path now. When the platform launches, existing Pro subscribers should automatically get deep lineage free and be offered a platform trial. The messaging is: "We made lineage free for everyone. Your Pro subscription now includes platform features." This is an upgrade, not a downgrade.

### 6. No paper addresses pricing experimentation

$29/month is cited by every paper but none validates it empirically. The Practitioner's willingness-to-pay data is self-reported, not transactional. The actual price elasticity is unknown.

**Action required:** Launch at $29/month. Track conversion rates for the first 90 days. If conversion is below 3%, test $19/month. If conversion is above 8%, consider that the price is too low. Pricing is a hypothesis, not a decision.

### 7. No paper addresses the open-source community reaction

altimate-code is being open-sourced. The community will scrutinize the free vs. paid boundary. If the boundary is perceived as holding back features that "should" be free (the Contrarian's concern), the Hacker News reaction will be hostile.

**Action required:** Frame the boundary as "basic lineage is free forever, advanced analysis requires Pro" from day one. Never describe the free tier as "limited" or "trial." Describe it as "column-level lineage" and the paid tier as "deep lineage analysis." The terminology shapes perception.

---

## Closing

This recommendation is not a hedge. The mechanism is specific: Ed25519-signed license tokens controlling output depth inside the compiled Rust binary, with agent-driven attribution of depth limitations. The free tier is a real product. The paid tier is a real upgrade. The enforcement is in compiled code. The conversion trigger is organic and recurring.

Build Phase 1 first. Test basic-depth lineage with real agents on real dbt projects. If the agent produces good output at basic depth, the strategy works. If it does not, adjust the boundary between basic and deep until it does.

Then ship it.
