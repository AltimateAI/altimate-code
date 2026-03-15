# Position Paper: Monetizing Agent-Consumed Features

**Author:** AI Agent Product Designer
**Date:** 2026-03-07
**Status:** Position paper for lineage gate debate

---

## Thesis

Every monetization strategy proposed so far treats lineage as a feature that humans use. It is not. Lineage is a feature that an AI agent uses, and the human benefits indirectly through better agent output. This distinction is not a nuance --- it is the entire problem. Traditional freemium gating was designed for a world where a human clicks a button, sees a result, and decides whether to pay. In an agent-native tool, the agent decides what to call, when, and how often. The human never "clicks" lineage. The human says "fix my dbt model" and the agent silently calls lineage 47 times in the background. This paper argues that agent-consumed features require a fundamentally different gating model, and proposes one.

---

## 1. The Fundamental Shift: From Feature Access to Capability Budget

### The old model

In traditional SaaS, monetization works like this:

1. Human discovers a feature (button, menu item, marketing page)
2. Human tries to use it
3. Gate appears ("Upgrade to Pro to access this feature")
4. Human evaluates whether the feature is worth paying for
5. Human pays or leaves

This model depends on three things being true: the human knows the feature exists, the human directly invokes the feature, and the human can evaluate the result. All three assumptions break down when AI agents are the consumer.

### The new model

In agent-native tools, the flow is:

1. Human asks the agent to do something ("write a dbt model for customer revenue")
2. Agent autonomously determines its strategy (which tools to call, in what order)
3. Agent calls lineage zero, one, or fifty times --- the human does not control this
4. Agent produces output
5. Human evaluates the output quality, but has no visibility into which tools made it good

The agent is the decision-maker about feature consumption. The human is the evaluator of output quality. These are different roles, and gating must account for both.

### What this means for monetization

You cannot gate at the feature-invocation level ("you clicked the lineage button, pay up") because there is no button. You cannot gate at the feature-awareness level ("look at this lineage visualization") because the agent consumes lineage as structured data, not as a visual artifact for humans.

You must gate at the capability level: the agent's overall ability to produce high-quality output, which is a function of the tools and depth of information available to it.

---

## 2. The Parallelization Problem: Why Feature-Level Gating is Dead

### The reconstruction attack

The context document correctly identifies that feature-level gating (single-model lineage free, full-project lineage paid) is meaningless because an agent can call single-model lineage on every model and reconstruct the full graph.

This is worse than the document suggests. It is not just that the agent *can* do this --- it is that the agent *will* do this as a natural part of its workflow. The agent does not think "I should call full-project lineage." The agent thinks "I need to understand the data flow for `stg_customers`, then `int_customer_orders`, then `fct_revenue`..." and calls single-model lineage on each one. The full graph emerges as a side effect of doing work.

This means:

- **Single vs. full project gating** is unenforceable. Not just bypassable --- literally meaningless as a distinction in agent workflows.
- **Per-model rate limiting** would cripple legitimate agent behavior. An agent working on a 50-model dbt project needs lineage on 50 models. That is not abuse, that is normal operation.
- **Per-session limits** are fragile against session-reset attacks, but more importantly, they create an adversarial relationship between the tool and its own agent. The agent is trying to do its best work; the tool is trying to stop it from using the capabilities that make it effective.

### What works instead

The unit of gating cannot be "number of lineage calls" or "single model vs. full project." The unit must be something that:

1. Correlates with the value the user is getting (not the mechanical actions the agent takes)
2. Cannot be reconstructed from smaller free units
3. Does not degrade the agent's ability to do basic work

This points toward **output quality differentiation** rather than access restriction. I develop this in Section 4.

---

## 3. The Attribution Problem: Making Invisible Value Visible

### The core difficulty

When the agent calls lineage silently, the human sees better SQL output. But the human does not know *why* the output is better. If you asked them "would you pay $29/month for column-level lineage?", they would say "what is column-level lineage?" But if you asked "would you pay $29/month for your agent to write correct SQL that handles all edge cases on the first try?", the answer would be very different.

The attribution problem is that the human cannot connect "my agent writes good SQL" to "because it uses column-level lineage." Without this connection, there is no conversion trigger.

### How to solve attribution

The agent must explicitly narrate its use of premium capabilities. This is not a feature gate --- it is a product design requirement for monetization. When the agent uses lineage in its workflow, it should surface this to the human in its response:

**Example 1 --- Free tier, lineage available but limited:**
```
I analyzed the column lineage for `stg_customers` and found that `customer_id`
flows through 3 downstream models. With full lineage analysis (available in Pro),
I could trace the complete impact across all 12 models in your project.

Based on what I can see, here's the model I built: ...
```

**Example 2 --- Paid tier, full lineage available:**
```
I traced full column lineage across your project: `customer_id` flows from
`raw_customers` through `stg_customers` -> `int_customer_orders` -> `fct_revenue`
-> `rpt_customer_ltv`. All downstream references are correctly joined.

Here's the model I built: ...
```

**Example 3 --- Free tier, lineage exhausted:**
```
I wrote this model based on the schema information available. Note: column-level
lineage analysis would help me verify that the joins are correct and no upstream
columns are missed, but this requires Pro. I recommend reviewing the join conditions
manually.

Here's the model I built: ...
```

The key insight: the agent is the narrator. The agent tells the human "I used lineage and here's what it found" or "I couldn't use lineage and here's what you're missing." This creates the attribution that freemium gates traditionally create through UI paywalls.

This approach works because:
- The human sees the value in context ("lineage caught a missing join")
- The upgrade prompt is natural, not interruptive
- The agent itself is the conversion engine

### The "before and after" moment

The most powerful conversion trigger is showing the human what they get WITH lineage vs. WITHOUT it. The agent can do this naturally:

```
I found 2 potential issues with this model. With lineage analysis, I identified
that `order_date` in `fct_orders` is derived from `created_at` in `raw_orders`
via a timezone conversion in `stg_orders`. Without this context, I would have
joined on `order_date` directly, which would produce incorrect results for
non-UTC timezones.
```

This is the "wow moment" that makes the human understand why lineage matters. It cannot happen behind a hard paywall (the human never experiences it) and it cannot happen with unlimited free access (there is no reason to pay).

---

## 4. Agent-Native Gating Patterns

I evaluate four potential gating mechanisms specifically designed for agent-consumed features.

### Pattern A: Token/Credit Budget for Agent Tool Calls

**Mechanism:** Each session or time period gets N "analysis credits." Lineage calls consume credits. When credits run out, lineage is unavailable until reset or upgrade.

**Evaluation:**
- Pro: Simple to understand. Maps to usage.
- Con: The agent does not know how to budget. It cannot plan "I should save 5 credits for the last model." Credit budgets create unpredictable degradation --- the agent might exhaust credits on early, less important models and have nothing left for the critical one.
- Con: Per-session credits are locally stored and bypassable.
- Con: Creates perverse incentives. The agent should call lineage when it helps. Credits make the agent (or its orchestrator) ration a capability based on price, not value.

**Verdict:** Poor fit for agent-consumed features. Credit budgets work for human-paced interactions (API calls, Cursor "fast" requests) but not for agent-internal tool invocations where the agent cannot meaningfully budget.

### Pattern B: Quality Tiers (Free: Basic, Paid: Deep)

**Mechanism:** The Rust binary always responds to lineage requests, but the depth of the response varies by tier.

- **Free tier:** Returns column-level lineage edges only (source_column -> target_column). No transform descriptions, no confidence annotations, no cross-CTE tracing, no transitive closure.
- **Pro tier:** Returns full lineage with transforms, confidence scores, CTE-internal tracing, transitive closure across multi-hop paths, semantic annotations (PII flow, aggregation detection).

**Evaluation:**
- Pro: The agent always gets *something*. No hard failure, no degraded workflow.
- Pro: Enforceable inside the compiled binary. The Rust binary decides what to return based on a license token. No local state to delete.
- Pro: The "quality gap" between free and paid is real and meaningful. Basic lineage tells you "column A feeds column B." Deep lineage tells you "column A feeds column B through a COALESCE with a NULL default after a LEFT JOIN, and this path also feeds columns C and D in two other models."
- Pro: The agent naturally surfaces the difference. It can say "I found the basic column mapping, but deep lineage analysis would reveal the transformation chain."
- Con: Requires designing two distinct output formats in altimate-core.
- Con: The free tier must be good enough that the agent produces useful output, but limited enough that the paid tier is clearly better.

**Verdict:** Strong fit. This is the primary mechanism I recommend. Detailed in Section 7.

### Pattern C: Agent Capability Levels (Fewer Tools Free, All Tools Paid)

**Mechanism:** The free agent has lineage tools but not the most powerful ones. For example, `lineage_check` (single-query lineage) is free, `dbt_lineage` (manifest-aware cross-model lineage) is paid, `altimate_core_track_lineage` (multi-query graph construction) is paid.

**Evaluation:**
- Pro: Clean separation. Some tools free, some paid.
- Con: As established, the agent can reconstruct cross-model lineage from single-query calls. Tool-level gating does not prevent this.
- Con: Removing tools from the agent makes the product worse for everyone, including potential paying customers who are still evaluating.
- Con: Creates a confusing tool surface where some lineage tools work and others do not.

**Verdict:** Weak. The parallelization problem defeats tool-level gating. Also, hiding tools from the agent during evaluation is counter-productive --- you want the agent to demonstrate its full capability so the human sees the value.

### Pattern D: Output Quality Differentiation (Same Tools, Different Depth)

**Mechanism:** All lineage tools are available at all tiers. But the depth and richness of the response varies. This is Pattern B applied uniformly across all lineage-related tools.

- **Free:** All tools return results, but with reduced detail. Column mappings without transforms. No confidence annotations. No PII flow detection. No semantic layer integration.
- **Pro:** Full depth. Transform chains, confidence scores, PII tracking, semantic annotations, lineage confidence factors, schema-aware disambiguation.

**Evaluation:** This is Pattern B generalized. Same pros and cons, but applied consistently. The advantage of doing this at the output level rather than the tool level is that the agent's workflow is never interrupted --- it always gets a response. The response is just less rich on the free tier.

**Verdict:** This is the right abstraction. All tools work. All tools return results. The depth of the result is the gate.

---

## 5. What Cursor and Copilot Actually Do

### Cursor's model

Cursor gates AI features through **request limits**, not feature access. Free users get a limited number of "fast" (Claude/GPT-4) requests per month and unlimited "slow" requests. The enforcement is entirely server-side --- Cursor's AI features route through their backend, which meters usage per account.

Key characteristics:
- **Server-side enforcement:** The user's IDE sends requests to Cursor's API. The API checks the user's plan and either fulfills the request with the fast model or queues it for the slow model.
- **Account-based:** Tied to a Cursor account, not local state. Cannot be bypassed by deleting files.
- **Model-based differentiation:** The "gate" is which AI model serves the request. Free users get the same features, just with a less capable model after exhausting fast requests.
- **Transparent to the user:** Users see "X fast requests remaining" in the IDE.

### Copilot's model

GitHub Copilot gates through **monthly completions and chat messages**. Free tier: 2,000 code completions + 50 chat messages per month. Pro tier: unlimited. Enforcement is server-side (all completions go through GitHub's API).

### Applicability to altimate-code

These models **do not directly apply** because altimate-code's core value proposition is BYOK (bring your own key) and local-first. There is no Altimate backend routing LLM requests. The LLM calls go directly from the user's machine to their API provider.

However, the principle generalizes: **the gate should be on something that Altimate controls, not something the user controls.** Cursor controls the AI model routing. Copilot controls the API access. Altimate controls the compiled Rust binary.

This is the key insight: altimate-core is the equivalent of Cursor's backend. It is a closed-source component that Altimate controls, that processes requests and returns results. The gating mechanism should live inside altimate-core.

### What we can borrow

From Cursor:
- The concept of "same feature, different quality" (fast vs. slow model) maps directly to "same lineage tool, different output depth."
- The concept of making the limit visible ("X fast requests remaining") maps to the agent narrating its lineage capabilities.

From Copilot:
- The concept of monthly budgets (2K completions) does not apply well because the agent, not the human, decides how many lineage calls to make. A monthly budget for lineage calls would be consumed unpredictably.

---

## 6. The Compiled Binary Advantage

altimate-core is a compiled Rust binary. This is the single most important architectural fact for monetization. Unlike local config files, SQLite databases, or dotfiles, a compiled binary is a black box that the user cannot trivially modify. This opens up gating mechanisms that are robust against local bypass.

### Mechanism 1: Cryptographic Feature Unlocking

**How it works:**
1. altimate-core is compiled with two code paths for lineage: basic and deep.
2. On first run without a license, the binary uses the basic code path.
3. When a user purchases Pro, they receive a signed license key (JWT or similar) from Altimate's licensing server.
4. The binary validates the license key using an embedded public key. If valid, it unlocks the deep code path.
5. The license key contains: user ID, tier, expiration date, a cryptographic signature.
6. The binary checks the signature against the embedded public key. No network call needed after initial license retrieval.

**What an attacker would need to do to bypass:**
- Reverse-engineer the Rust binary to find the public key and the code path branch
- Patch the binary to skip the signature check or replace the public key
- This is possible but requires significant reverse-engineering skill, and Rust binaries are harder to reverse than Python or JavaScript

**Strength:** High. Not unbreakable, but raises the bar dramatically compared to deleting a config file.

### Mechanism 2: Binary-Level Feature Flags

**How it works:**
- The binary has features compiled in but gated behind runtime checks.
- Feature flag state is stored in a signed, encrypted configuration blob that the binary writes to disk.
- The blob contains a monotonic counter (to prevent rollback) and is encrypted with a key derived from the license key.
- Without the correct license key, the blob cannot be decrypted, and the binary defaults to basic mode.

**Strength:** Medium-high. The blob is opaque and encrypted, but an attacker could potentially intercept the binary's own decryption routine.

### Mechanism 3: Output Truncation/Degradation

**How it works:**
- The binary always computes full lineage internally (same code path).
- Before returning the result, it checks the license tier.
- For free tier: it strips transform descriptions, removes confidence annotations, truncates transitive paths to depth-1 (direct parents only), and omits PII flow markers.
- For paid tier: it returns the full result.

**Why this is particularly powerful:**
- There is no "locked feature" to reverse-engineer. The binary runs the same analysis.
- The output filtering is a small piece of logic that can be obfuscated within the binary.
- The free-tier output is still correct and useful --- it just lacks depth.
- An attacker would need to find the output-filtering logic and patch it out, which requires understanding the data structures flowing through the binary.

**Strength:** High, and it produces the best user experience because the free tier still works.

### Mechanism 4: Signed Response Validation

**How it works:**
- The binary signs its output with a key derived from the license.
- The TypeScript layer verifies the signature.
- If the response is unsigned or improperly signed, the TypeScript layer knows the binary has been tampered with.

**Why this is weaker than it sounds:**
- The TypeScript layer is open source. An attacker can remove the signature check.
- This only works if the TypeScript layer also enforces the gate, which it cannot do robustly (it is open source).

**Strength:** Low as a standalone mechanism. Useful as a defense-in-depth layer but not as the primary gate.

### Recommended approach

Combine Mechanisms 1 and 3: **Cryptographic license validation controlling output depth.** The binary validates the license, and based on the tier, returns either basic or deep lineage results. This is enforceable, robust, and produces a good user experience at both tiers.

---

## 7. Specific Recommendation: The "Depth Gate"

### The mechanism

I propose a single mechanism I call the **Depth Gate**. It combines output quality differentiation (Pattern D from Section 4) with cryptographic enforcement inside the compiled binary (Mechanisms 1+3 from Section 6) and agent-driven attribution (Section 3).

### How it works

**Step 1: Binary-Level Output Tiering**

altimate-core always accepts lineage requests and always returns a result. The depth of the result depends on the license tier embedded in a cryptographically signed license token.

| Aspect | Free (no license) | Pro (valid license) |
|--------|-------------------|---------------------|
| Column-to-column edges | Yes | Yes |
| Transform descriptions (COALESCE, CASE, etc.) | No | Yes |
| Confidence scores per edge | No | Yes |
| Transitive lineage (multi-hop) | Depth-1 only (direct parent) | Full transitive closure |
| CTE-internal column flow | No (CTE treated as opaque) | Yes |
| PII flow annotations | No | Yes |
| Cross-model lineage via manifest | Single model only | Full project graph |
| Semantic annotations | No | Yes |

**Step 2: License Token Mechanics**

- On first install, altimate-core runs in free mode. No signup required. Lineage works immediately.
- The user experiences lineage (basic depth) from the first session.
- When the user purchases Pro, they receive a license token from `license.altimate.ai`.
- The token is a signed JWT: `{ user_id, org_id, tier: "pro", issued_at, expires_at, machine_fingerprint }`.
- The binary validates the token against an embedded public key. No ongoing network dependency.
- The `machine_fingerprint` is a hash of hardware identifiers (CPU ID, MAC address, hostname) that the binary computes at runtime. This prevents sharing a single license across machines.
- Token has a 30-day validity. After 30 days, the binary falls back to free mode and prompts for renewal. Renewal requires a single network call to `license.altimate.ai` to get a fresh token (if the subscription is active).

**Step 3: Agent-Driven Attribution**

The binary's response includes a `tier` field and, for free-tier responses, a `depth_limited` field listing what additional information would be available at Pro tier.

The TypeScript tool layer reads these fields and instructs the agent to narrate the limitation:

```typescript
// In the lineage tool result formatting
if (result.tier === "free" && result.depth_limited) {
  output += `\n\n[Pro insight available: ${result.depth_limited.join(", ")}]`
}
```

The agent's system prompt includes instructions to surface these annotations naturally:

```
When lineage results include depth limitations, mention what additional
analysis would be available with Pro. Frame it as "I found X. With deeper
analysis, I could also determine Y." Do not block the workflow --- continue
with the information available.
```

**Step 4: The Conversion Trigger**

The conversion trigger is organic and recurring. Every time the agent uses lineage and encounters a depth limitation, it tells the human. This happens naturally during the agent's work:

- "I traced `customer_id` to `stg_customers` (direct parent). With Pro lineage, I could trace the full chain through all 8 downstream models to verify no references are broken."
- "I found the column mapping for this model. Pro lineage would also show that `email` is a PII column flowing from `raw_users` through this transformation, which may require masking."
- "I wrote this JOIN based on the column names. Pro lineage would verify the transformation logic --- `stg_orders.order_date` appears to come from a timezone conversion that I cannot trace at the current analysis depth."

The human does not need to know what "column-level lineage" is. They see: "my agent could be smarter about data flow, joins, and PII if I upgrade."

**Step 5: Session Counting Without Deletable State**

The license token includes a `first_seen` timestamp set by the binary on first execution. This timestamp is embedded in a signed, encrypted blob stored on disk (using a key derived from the machine fingerprint). Even if the blob file is deleted, the binary recreates it --- but the `first_seen` timestamp is also recorded server-side during an optional telemetry ping on first run.

For the first 5 sessions (or 7 days, whichever comes first), the binary operates in "evaluation mode" where it returns **full-depth lineage** (Pro-level output) without a license. This is the trial period. After evaluation mode expires:

- Without a license: falls back to free-tier depth
- With a license: continues at Pro depth

The evaluation mode creates the "wow moment" --- the user experiences full lineage from day one. When it expires and the agent starts saying "I could trace the full chain with Pro lineage...", the user has already seen what they are missing.

**Why deleting local state does not help:**

1. The signed blob uses a monotonic counter. If it is deleted, the binary detects the anomaly (counter resets to 0 when it should be higher) and starts in free mode, not evaluation mode.
2. The machine fingerprint is computed from hardware, not stored in a file.
3. Even if the user defeats both protections, the friction of repeatedly deleting files and dealing with fallback behavior exceeds the $29/month cost for most professional users.

The goal is not to make bypass impossible. The goal is to make bypass annoying enough that paying is the path of least resistance for anyone who gets real value from the tool.

### Why this mechanism works for agents specifically

1. **No workflow interruption.** The agent always gets a lineage response. It never hits a wall. It never needs to tell the human "lineage is unavailable." It says "I got basic lineage" or "I got deep lineage." The agent's workflow is continuous.

2. **The agent is the salesperson.** The agent naturally communicates the value gap because it is built into its workflow. When the agent says "I could verify the full transformation chain with Pro," that is more persuasive than any marketing page because it is contextual and specific to the user's actual work.

3. **No parallelization attack.** There is no "premium endpoint" to reconstruct from "free endpoints." Every endpoint returns results. The results are just less rich. The agent cannot reconstruct transform descriptions, confidence scores, or PII annotations from basic column edges --- that information simply is not in the free response.

4. **Enforced in the binary.** The gate lives in compiled Rust code. The TypeScript layer passes through whatever the binary returns. Even if the user modifies the TypeScript to remove upgrade prompts, the binary still returns basic-depth results without a valid license.

5. **Works for the first session.** No signup required. The binary runs in evaluation mode. The agent uses full lineage. The human sees the best possible output. This is the hook.

### Implementation priority

1. **Phase 1 (Week 1-2):** Implement output tiering in altimate-core. Two code paths in the lineage response formatter: basic and deep. Gate on a simple boolean flag initially (hardcoded, for testing).
2. **Phase 2 (Week 3-4):** Implement license token validation. JWT verification with embedded public key. License generation endpoint at `license.altimate.ai`.
3. **Phase 3 (Week 5-6):** Implement evaluation mode with signed local state. Machine fingerprinting. Monotonic counter.
4. **Phase 4 (Week 7-8):** Implement agent attribution. Add `tier` and `depth_limited` fields to binary output. Update TypeScript tool formatters. Update agent system prompts.

### Cost structure

- **License server:** Minimal. Stateless JWT issuance. Could run on a single Cloudflare Worker.
- **Binary changes:** Medium. Requires modifying altimate-core's lineage output path. The core analysis logic does not change --- only the response formatting.
- **TypeScript changes:** Small. Reading two new fields from the binary response and appending a line to the tool output.
- **Agent prompt changes:** Small. A few sentences in the system prompt about how to narrate depth limitations.

### Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Users are annoyed by "upgrade to Pro" messages | Medium | Messages are contextual and helpful, not interruptive. The agent frames them as "here's what else I could tell you," not "pay to continue." Test copy carefully. |
| Free tier is too good and nobody upgrades | Low | The quality gap between depth-1 edges and full transitive lineage with transforms is large enough that professional users will notice. |
| Free tier is too bad and nobody adopts | Low | Basic column edges are genuinely useful. The agent can write correct SQL with just source-to-target mappings. The gap is in verification and impact analysis. |
| Binary reverse-engineering | Low | Rust binaries are hard to reverse. The economic value of bypassing a $29/month tool does not justify the engineering effort for most users. Enterprise customers (who would pay $100+/seat) have compliance requirements that prevent using tampered binaries. |
| Evaluation mode gaming (VM snapshots, etc.) | Very low | Professional data engineers working on real projects do not snapshot VMs to avoid $29/month. The friction is not worth it. |

---

## Summary

The agent-consumed feature monetization problem requires abandoning three assumptions from traditional SaaS:

1. ~~The human invokes the feature~~ --- the agent invokes it
2. ~~The human sees the feature's output~~ --- the agent sees it and uses it internally
3. ~~The gate blocks access~~ --- the gate modulates depth

The Depth Gate mechanism addresses all three by:
- Letting the agent always access lineage (no workflow interruption)
- Varying the richness of the response based on license tier (depth, not access)
- Having the agent narrate the value gap to the human (attribution)
- Enforcing the gate inside the compiled Rust binary (robustness)
- Providing a full-depth evaluation period (first use experience)

The unit of monetization is not "access to lineage." It is "depth of understanding about your data." That framing works for agents, works for humans, and works for the business.
