# Paper 08: The Contrarian

**Position:** Every proposed gating mechanism for column-level lineage is either bypassable, counterproductive, or architecturally incompatible with this product. The premise itself may be wrong.

---

## 1. Challenging the Premise: Lineage Is Not the Product

The entire debate starts from a flawed assumption: that column-level lineage is the thing worth charging for. Let me argue the opposite.

### Lineage is infrastructure, not product

Column-level lineage is a technical primitive. It is to a data engineering agent what syntax highlighting is to a code editor. Users do not wake up thinking "I need column-level lineage today." They wake up thinking "I need to build a dbt model" or "I need to figure out why this dashboard is wrong" or "what happens if I change this column?"

The *answers* to those questions have value. The lineage engine that powers those answers is plumbing.

Gating lineage is like charging for the HTTP client inside your API testing tool. Yes, it is technically the thing doing the work. No, users do not perceive it as the value.

### The 2ms problem

The context document proudly states: "2ms execution time, zero database dependency." This is a selling point for adoption, but it is a monetization liability. Things that are fast and local feel like they should be free. Users have strong intuitions about what should cost money, and those intuitions map roughly to:

- **Should cost money:** Things that use someone else's infrastructure (cloud compute, API calls, managed services)
- **Should be free:** Things that run on my machine using my CPU in 2ms

You are fighting user psychology. Every user who discovers that a 2ms local computation is the thing behind the paywall will feel cheated.

### Where the real money is

If lineage is the hook, what is the catch? Consider what becomes possible *because* lineage exists:

1. **Impact analysis at organization scale** -- "Show me every dashboard, report, and downstream model affected by this column change." This requires not just lineage but a connected graph across the entire organization's dbt project, warehouse metadata, and BI layer. That is a platform feature, not a CLI feature.

2. **Automated migration** -- "Migrate this Snowflake pipeline to BigQuery." Lineage is one input. The actual value is the agent that orchestrates the rewrite, validates the output, and handles edge cases. That is a service, not a binary feature flag.

3. **Continuous governance** -- "Alert me when PII flows into an unprotected table." This requires persistent monitoring, policy definitions, and integration with security tooling. That is an ongoing operational capability, not a one-time lineage call.

4. **Context management at scale** -- Your own `PAID_CONTEXT_FEATURES.md` lists six features gated behind license keys, including lineage-aware context selection, smart context scoring, and schema compression. These are the features that make the *agent better at its job*. The agent's quality ceiling is the real product, not any single analytical primitive.

The pattern from every successful open-source monetization story is the same: give away the engine, charge for the fleet management. Redis is free; Redis Enterprise (clustering, persistence guarantees, multi-tenancy) is paid. PostgreSQL is free; managed Postgres (backups, HA, monitoring) is paid. dbt-core is free; dbt Cloud (orchestration, CI/CD, docs hosting, governance) is $100M+ ARR.

Lineage should be the hook. It should be the thing that makes the free tier so good that teams adopt it, discover they need organizational-scale capabilities, and then pay for the platform.

---

## 2. Every Proposed Gating Mechanism Is Broken

### 2.1 Rate Limiting (Local State)

**The mechanism:** Store a counter locally (SQLite, dotfile, config file). Allow N free lineage calls per day/week. After the limit, degrade or disable.

**Why it fails:**

The context document already acknowledges this: "Users can delete the state file and reset." But the problem is deeper than file deletion.

- **Containers and CI/CD:** Every `docker run` or CI pipeline execution starts with a clean filesystem. The rate limit resets on every run. Your heaviest users -- the ones running lineage in automated pipelines -- will never hit the limit.
- **Multiple installations:** Users can trivially have multiple copies. `pip install altimate-code` in a fresh virtualenv resets everything.
- **Obfuscation arms race:** You could hide the state file, encrypt it, use OS-level keychains. But you are spending engineering cycles on DRM for a developer tool. Every hour spent on anti-circumvention is an hour not spent on product. And developers are precisely the audience most capable of and motivated to defeat DRM.
- **The perception problem:** A data engineer hits a rate limit while debugging a production issue at 2 AM. They do not think "I should upgrade to Pro." They think "this tool is broken" and they switch to sqlglot, which has no limits and is MIT-licensed.

The fundamental issue: **local enforcement is an oxymoron when the user controls the environment.**

### 2.2 Rate Limiting (Cloud/Phone-Home)

**The mechanism:** The Rust binary phones home to an Altimate server for license validation or usage tracking. No valid response = no lineage.

**Why it fails:**

You have just created a contradiction at the core of your product identity.

- **Local-first is a promise.** The context document states: "Local-first: Everything runs on the user's machine." and "BYOK: Users bring their own LLM API keys. No Altimate backend for core features." A phone-home requirement violates both of these promises on the first day of open-sourcing. The Hacker News thread will write itself.
- **Air-gapped enterprises.** Many data engineering teams work in environments with restricted network access -- banks, healthcare, government. A phone-home dependency eliminates these customers entirely. These are also, ironically, the customers most likely to pay enterprise rates.
- **Availability dependency.** Your lineage feature now has the uptime characteristics of your license server, not of the user's local machine. When your server goes down -- and it will -- every user's agent degrades simultaneously. You have turned a local binary into a distributed system with a single point of failure.
- **Latency injection.** Your lineage runs in 2ms. A network round-trip to validate a license takes 50-200ms minimum. You have just made lineage 25-100x slower for the sake of enforcement. Users will notice.
- **The trust deficit.** Developers are sending their SQL to a local tool. Now that local tool is phoning home. Even if you are not transmitting SQL content, the *perception* is that you might be. This is especially toxic in the data engineering community, where the SQL often contains information about proprietary business logic and data architecture.

HashiCorp went through exactly this pain when they moved Terraform from MPL to BSL. Within a month, 33,000+ GitHub stars on the OpenTofu manifesto, 140+ companies pledging support, and a Linux Foundation fork ([The Register, 2023](https://www.theregister.com/2023/08/11/hashicorp_bsl_licence/)). The community response to perceived betrayal of open-source principles is swift and unforgiving.

### 2.3 Free Signup / Account Requirement

**The mechanism:** Users create a free Altimate account. The account unlocks lineage. Conversion happens through in-product prompts and email nurturing.

**Why it fails:**

The context document's Constraint #4 states: "Should not require signup before first use." But let me explain why this constraint exists, not just that it does.

- **The 60-80% drop-off is real.** User onboarding research consistently shows that mandatory signup forms lose 60-80% of potential users ([UserGuiding, 2026](https://userguiding.com/blog/user-onboarding-statistics)). For developer tools specifically, the attrition is even worse -- developers are accustomed to `brew install` or `pip install` and immediate usage. A signup wall after installation feels like adware.
- **The data engineering persona.** Your users are not consumers signing up for a social app. They are data engineers evaluating tools during work hours, often with time pressure. The signup flow competes with `pip install sqlglot` which requires zero authentication and provides column-level lineage (though less sophisticated).
- **Email addresses are lies.** Developers will use disposable emails, work emails they never check, or simply abandon the flow. The "email nurture" funnel requires engagement with emails that developers actively filter out.
- **The agent does not have an account.** This is the deepest problem. Your primary consumer is an AI agent. The agent cannot sign up. The agent cannot enter credentials. The human has to do this, but the human may not be present when the agent needs lineage. Now you have an async coordination problem: the agent is running, it needs lineage, but the human has not set up authentication. The agent fails silently. The human sees bad output and blames the agent, not the missing lineage.

### 2.4 Binary-Level Feature Flags

**The mechanism:** The Rust binary (altimate-core) checks a license key before executing lineage. No valid key = lineage disabled. The binary is compiled, making it hard to patch.

**Why it fails (less than the others, but still):**

- **Binary patching is not as hard as you think.** Compiled Rust is more resistant to decompilation than Python or JavaScript, but it is not impenetrable. Ghidra is free. Frida is free. A motivated developer can NOP out a license check in an afternoon. You are relying on obscurity, not impossibility.
- **But the real problem is the failure mode.** What happens when the license server is unreachable? You have three options, all bad:
  - **Fail closed (no lineage):** Users at air-gapped enterprises cannot use the feature at all. Users on planes cannot use the feature. Users in regions with poor connectivity cannot use the feature.
  - **Fail open (allow lineage):** Now your enforcement is bypassable by blocking network access. Add `127.0.0.1 license.altimate.ai` to `/etc/hosts` and you have free lineage forever.
  - **Cache the license for N days:** This is the "least bad" option but introduces complexity. How long is the cache? What happens when it expires during a critical debugging session? What about clock manipulation?
- **Distribution friction.** Every enterprise security review will flag a binary that phones home to a third-party server. Your procurement process just got 6 months longer. The very customers who would pay $100-150/seat/month are the ones whose security teams will block the phone-home binary.

### 2.5 Time-Limited Trials

**The mechanism:** Lineage works fully for 14 days. After that, it requires a paid license.

**Why it fails:**

- **The WinRAR precedent.** WinRAR's infinite trial has been a running internet joke for two decades. Their model "works" only because enterprise bulk licensing generates $20-40M/year from a tiny fraction of users ([WinRAR Revenue Model](https://breakevenpointcalculator.com/how-does-winrar-make-money-revenue-model-explained/)). The 90%+ of individual users never pay. Is that your business model? If so, stop pretending the trial is a conversion mechanism and just build enterprise sales.
- **Reset is trivial.** Reinstall, new virtualenv, new container, new CI runner. The trial timer stored locally is the same problem as local rate limiting. The trial timer stored remotely is the same problem as phone-home.
- **The urgency mismatch.** A 14-day trial creates urgency when the user is actively evaluating. But data engineering tool adoption is slow. A data engineer might install the tool, try it on one project, forget about it for a month, come back, and discover the trial expired. They never got to the "wow" moment, and now it costs $29/month to try again. They will not pay. They will uninstall.
- **Punishes early adopters.** The users who install first -- your evangelists, your champions -- are the ones whose trials expire first. By the time their organization is ready to evaluate seriously, the champion's trial is gone and they have moved on.

### 2.6 Quality Degradation

**The mechanism:** Free users get partial lineage (no transforms, simplified output). Paid users get the full graph with transformation details.

**Why it fails:**

- **First impressions are permanent.** A user tries lineage, gets a partial result, and concludes "this tool's lineage is mediocre." They do not think "this is a demo; the real thing is better." They think "SQLGlot does this better." You have one chance to demonstrate value. Showing a degraded version is worse than showing nothing, because showing nothing leaves room for imagination. Showing something bad closes the door.
- **The agent amplifies the problem.** The AI agent receives degraded lineage and produces degraded output. The human sees the degraded output. The human does not know that lineage was limited. The human concludes the agent is not very good. The human does not upgrade; the human switches tools. The agent cannot say "hey, I would have done better with paid lineage" because the agent does not have that metacognitive awareness in a natural way.
- **Calibration is impossible.** How much do you degrade? Too little, and free is good enough forever. Too much, and the tool seems broken. There is no middle ground because the "right" amount of degradation depends on the user's specific query and use case. A query that only has 3 lineage edges does not benefit from paid -- so the free tier seems identical. A query with 50 lineage edges produces garbage on free -- so the tool seems broken. You cannot win.

---

## 3. The Inconvenient Truth About Devtools Monetization

### The base rate is brutal

Let me be precise about the numbers that the industry prefers to ignore.

- **Freemium conversion rates for developer tools: 1-3%.** The median is closer to 1%. General SaaS sees 2-5%, but developer-focused products convert at half that rate ([Monetizely, 2026](https://www.getmonetizely.com/articles/whats-the-right-ratio-of-free-to-paid-users-in-developer-saas)). Developers are accustomed to free tools. They have strong opinions about what should cost money. And they have the technical skills to find or build alternatives.
- **Open source SaaS conversion: 0.5-3%.** Even lower than general freemium ([Monetizely, 2026](https://www.getmonetizely.com/articles/whats-the-optimal-conversion-rate-from-free-to-paid-in-open-source-saas)). A typical ratio is 97:3 (free:paid) or 99:1 for developer-focused products.
- **Time to $1M ARR: only ~50% of startups reach it within 10 years** -- if they monetize at all ([ChartMogul, 2025](https://chartmogul.com/reports/saas-growth-the-odds-of-making-it/)). Only 13% reach $10M ARR.

### The graveyard of well-loved devtools

- **Kite** had 500,000 active developers. Could not convert them to paying customers. Shut down. Their post-mortem: "our 500k developers would not pay to use it" ([DevClass, 2022](https://devclass.com/2022/11/21/kite-ai-coding-pulled-down-to-earth-because-our-500k-developers-would-not-pay-to-use-it-now-open-source/)). Kite is the canonical example: massive adoption, zero revenue, death.
- **Docker** (pre-pivot) had 37 billion container image downloads. Revenue was sub-$75M ARR despite $335M in venture funding. They had to lay off 80% of their team before figuring out monetization ([Sacra](https://sacra.com/research/docker-plg-pivot/)). Docker eventually cracked it -- but only by pivoting from open source tooling to commercial desktop licensing, effectively abandoning the open-source-everything approach.
- **Atom** (GitHub's editor) had millions of users. Never monetized. Discontinued.
- **Eclipse** had dominant market share in Java development. The Eclipse Foundation survives on corporate membership dues, not product revenue.

The pattern is clear: **developer adoption does not automatically convert to developer revenue.** Adoption is necessary but nowhere near sufficient. The tools that succeed financially (GitHub, JetBrains, Datadog) succeed because they sell to *organizations*, not individuals.

---

## 4. The Agent Makes Everything Worse

This is the section the debate should spend the most time on, because it is the most novel constraint and the one that invalidates the most conventional wisdom.

### Agents do not see upgrade prompts

Traditional freemium relies on the user experiencing a moment of frustration or desire. "I hit the rate limit. I want more." "I see a 'Pro' badge next to a feature I want." "The free version is good but I want X."

When the AI agent is the primary consumer of lineage, none of these mechanisms work:

- The agent hits a rate limit. It does not feel frustration. It retries, works around it, or silently produces worse output.
- The agent sees an "upgrade to Pro" message in a tool response. It does not relay this to the human. It treats it as noise in the output and continues working.
- The agent receives degraded lineage. It does not know it is degraded. It does not compare against a hypothetical "full" version. It just uses what it has.

### The human sees output, not process

The human does not watch the agent make 47 lineage calls. The human sees the final dbt model. If the model is correct, the human does not think "I should pay for lineage to make it more correct." If the model is incorrect, the human does not think "maybe lineage would fix this." The human just sees a result.

This breaks the entire freemium funnel. The traditional funnel is: use free -> hit limit -> feel pain -> upgrade. When an agent intermediates, the funnel becomes: use free -> agent hits limit silently -> agent produces slightly worse output -> human notices nothing or blames the agent -> no conversion.

### Agents reconstruct what you gate

The context document acknowledges this: "Agent can call lineage on each model individually and reconstruct the full graph programmatically." But the problem is more general than that.

If you gate *any* analytical feature and the agent has access to ungated primitives, the agent will reconstruct the gated feature from the primitives. This is what agents are good at. You give an agent access to `sqlglot.parse()` and `information_schema` queries, and it will build its own column lineage. It will be slower and worse, but it will work, and the user will not pay for the improvement because they do not perceive the quality difference.

### The meta-problem

Feature gating works when the human is the consumer and can perceive the difference between free and paid. When an AI agent intermediates, you lose both:
1. The human cannot perceive the difference (they see output, not tools)
2. The agent cannot be motivated to upgrade (it has no preferences or frustrations)

This is a new problem in software monetization. There is no playbook for it because it has not existed before at scale.

---

## 5. The Cursor Counterargument

Cursor is the most frequently cited devtools success story: $2B+ ARR, $29B valuation, explosive growth ([Sacra](https://sacra.com/c/cursor/)). "Just do what Cursor does" is tempting. Here is why it does not apply.

### Cursor controls the model inference

Cursor's monetization works because they control the most expensive and most valuable resource: LLM inference. When you use Cursor, your code goes through Cursor's servers. Cursor pays OpenAI/Anthropic for the API calls. Cursor charges you more than it pays, and the margin is the business.

This is a classic resource-metered model. It works because:
- The resource is expensive (LLM inference)
- The resource is centralized (Cursor's servers)
- The user cannot bring their own (Cursor manages the model selection, context window, and prompt engineering)
- The quality difference between free and paid is immediately perceptible (fast model vs. slow model, smart model vs. dumb model)

### altimate-code has none of these properties

altimate-code is BYOK. Users bring their own API keys. Altimate does not pay for inference. Altimate does not control the model. Altimate does not mediate the request.

This means:
- **No resource to meter.** The expensive resource (LLM inference) is paid for directly by the user, not by Altimate. You cannot mark up something you do not provide.
- **No quality lever.** Cursor can give free users GPT-3.5 and paid users Claude Opus. Altimate cannot throttle the LLM quality because the user controls the API key and model selection.
- **No server-side enforcement.** Cursor's limits are enforced server-side because inference happens on Cursor's infrastructure. Altimate's lineage runs locally. There is no server to enforce anything.

The only Cursor-comparable mechanism available to Altimate is the Rust binary (altimate-core), which is compiled and closed-source. But a compiled binary is a much weaker enforcement point than a cloud API endpoint. The binary ships to the user's machine. The API endpoint stays on your server.

### The BYOK trap

BYOK is a great user acquisition strategy. It reduces friction and trust barriers. But it is a monetization anti-pattern. By giving users control of the most expensive component (LLM inference), you have removed the most natural monetization mechanism. You are left trying to monetize the cheap components (local computation) while the expensive components (inference) flow through someone else's billing.

This is the opposite of the Cursor model. Cursor makes the expensive thing easy and charges for it. Altimate makes the expensive thing the user's problem and tries to charge for the cheap thing.

---

## 6. The Least Bad Option (If Forced)

Despite everything I have argued above, I acknowledge the business reality: you need revenue, and lineage is your strongest differentiator. If I were forced to choose one gating mechanism, here is what I would pick.

### Recommendation: Offline-First License Key with Generous Free Tier

**The mechanism:**

1. **Lineage works fully and freely for all users, forever, in single-session usage.** No signup. No limits. No degradation. The first experience is perfect.

2. **The gate is on *persistent* lineage features:** saved lineage graphs, cross-session lineage history, project-wide lineage index, lineage-powered refactoring across multiple files, lineage export to external tools. These are features that require state management and are meaningfully more valuable than single-query lineage.

3. **The license key is an offline-capable signed JWT.** The Rust binary validates the signature locally using a baked-in public key. No phone-home required for validation. The JWT contains: user ID, tier, expiry date, feature flags. Renewal requires periodic internet access (quarterly), but day-to-day usage is fully offline.

4. **The free tier is genuinely useful.** Single-query lineage, per-session lineage in the agent, impact analysis for the current file. The agent works well. Users do real work with the free tier.

5. **The paid tier unlocks *organizational* lineage.** Full-project lineage index, cross-model impact analysis, lineage-aware CI (fail the build if a change breaks downstream), lineage export to data catalogs, team-shared lineage snapshots.

**Why this is least bad:**

- No first-use friction (Constraint #1 and #4)
- Offline-capable (air-gapped enterprises work)
- The free/paid boundary is at a natural organizational scaling point, not an artificial limit
- The agent works well on free (single-query lineage is sufficient for most agent tasks)
- The paid features are things organizations actually budget for
- The enforcement is in compiled Rust code, not deletable state files
- The license key cannot be bypassed without binary patching (which is hard, not impossible)

**Why it is still bad:**

- Binary patching remains possible
- The "persistent lineage" distinction is arbitrary and users will feel that way
- Quarterly renewal still requires internet access
- Individual users may never convert because single-query lineage is good enough
- The agent can simulate cross-session lineage by replaying queries

**Honest assessment: this buys you time, not a moat.** The real monetization must come from something else.

---

## 7. The Nuclear Option: Give It All Away

### The argument for free lineage

Give away all lineage features. Every tier. No limits. No degradation. No gates. Here is why.

**Lineage is a wedge, not a product.** The most successful open-source companies figured out that the open-source tool is a distribution channel, not a revenue center.

- **Grafana** gave away the visualization engine. Revenue comes from Grafana Cloud (managed hosting, enterprise features, support). They reached $250M ARR by making the open-source tool so good that organizations adopted it, then paying for the managed version ([Sacra](https://sacra.com/c/grafana-labs/)). Grafana's explicit philosophy: "never put walls around what was already free."
- **dbt Labs** gave away dbt-core. Revenue comes from dbt Cloud ($100M+ ARR) for orchestration, CI/CD, documentation hosting, and governance. Nobody pays for the SQL compilation engine. They pay for the platform around it.
- **PostHog** open-sourced their analytics engine. Revenue comes from PostHog Cloud (managed hosting with scale) ([PostHog Blog](https://posthog.com/blog/open-source-business-models)).

The pattern: **give away the engine, sell the operations layer.** The engine drives adoption. The operations layer drives revenue.

### What Altimate could sell instead

If lineage is free, what is the business?

1. **Altimate Cloud / Platform:** A hosted platform for data teams that provides:
   - Centralized lineage graph across all projects and team members
   - Lineage-powered data catalog (auto-generated, always current)
   - Lineage-aware CI/CD (fail PRs that break downstream models)
   - Cost impact analysis (what does this change cost in warehouse compute?)
   - PII flow monitoring and alerting
   - Team-wide agent session analytics (what is the agent doing across the org?)

2. **Enterprise Support & SLA:** The standard open-source monetization fallback. Not exciting, but real. Red Hat built a $34B company on it.

3. **Managed Agent Infrastructure:** Since users are BYOK, there is an opportunity to offer managed agent orchestration: job scheduling, retries, audit logs, approval workflows, SOC 2 compliance. The agent is free. Managing the agent at organizational scale is paid.

4. **Data Quality as a Service:** Lineage enables data quality checks. Free lineage + free agent + paid data quality monitoring platform. The monitoring requires persistence, historical tracking, and alerting infrastructure -- things that naturally live in the cloud, not locally.

### The argument against free lineage

I would be a poor contrarian if I did not challenge my own nuclear option.

- **You are giving away your only differentiator.** If lineage is free, what stops sqlglot (MIT-licensed, widely adopted) from being "good enough"? Altimate's lineage may be faster and more accurate, but "faster and more accurate" is hard to monetize when "good enough" is free.
- **The platform requires building a platform.** "Just sell the cloud platform" is easy to say and expensive to do. You need infrastructure, a team, SOC 2, SLAs, customer support, a sales team. This is a multi-year, multi-million-dollar investment *before* revenue.
- **You delay monetization indefinitely.** Free lineage accelerates adoption but pushes revenue to an uncertain future. Investors may not have that patience. Your runway matters.
- **The "give away the engine" companies are outliers.** For every Grafana and dbt Labs, there are a hundred open-source companies that gave everything away and got nothing back. Survivorship bias is extreme in this analysis. Docker nearly died before figuring it out. Most do not get a second chance.

### My honest assessment

The nuclear option is the *strategically correct* choice for a well-funded company with 18+ months of runway and the team to build a platform. It is the *strategically suicidal* choice for a bootstrapped company that needs revenue in the next two quarters.

The decision depends on a question this paper cannot answer: **how much runway do you have, and what is your theory of the business?**

If the theory is "we sell a CLI tool to individual data engineers at $29/month," gating lineage matters and you should use the least-bad option from Section 6.

If the theory is "we build the platform that data teams use to operate their data infrastructure," lineage gating is a distraction and you should give it all away to maximize adoption velocity.

Pick the theory. The gating mechanism follows.

---

## Summary of Positions

| Mechanism | Verdict | Core Failure Mode |
|-----------|---------|-------------------|
| Local rate limiting | Broken | Users delete the file |
| Cloud phone-home | Toxic | Violates local-first promise |
| Free signup | Friction | 60-80% user loss, agent cannot authenticate |
| Binary feature flags | Weakest defense | Air-gapped enterprises blocked, binary patchable |
| Time-limited trial | Ineffective | WinRAR syndrome, resets trivially |
| Quality degradation | Counterproductive | Users blame the tool, not the tier |
| **Offline license + org features (least bad)** | **Tolerable** | **Buys time, not a moat** |
| **Give it all away (nuclear)** | **Strategically correct if funded** | **Requires platform investment** |

The uncomfortable conclusion: **there is no good way to gate a local-first, agent-consumed, BYOK developer tool.** The product architecture is fundamentally incompatible with traditional freemium enforcement. Either change the architecture (add server-side components you control) or change the monetization strategy (sell something other than the local tool).

---

## References

- [DevClass - Kite shutdown, 500k developers would not pay](https://devclass.com/2022/11/21/kite-ai-coding-pulled-down-to-earth-because-our-500k-developers-would-not-pay-to-use-it-now-open-source/)
- [Sacra - Docker revenue and PLG pivot](https://sacra.com/research/docker-plg-pivot/)
- [Sacra - Cursor revenue](https://sacra.com/c/cursor/)
- [Sacra - Grafana Labs revenue](https://sacra.com/c/grafana-labs/)
- [The Register - HashiCorp BSL license change](https://www.theregister.com/2023/08/11/hashicorp_bsl_licence/)
- [Monetizely - Developer SaaS free-to-paid ratios](https://www.getmonetizely.com/articles/whats-the-right-ratio-of-free-to-paid-users-in-developer-saas)
- [Monetizely - Open source SaaS conversion rates](https://www.getmonetizely.com/articles/whats-the-optimal-conversion-rate-from-free-to-paid-in-open-source-saas)
- [ChartMogul - SaaS Growth Report, odds of reaching $1M ARR](https://chartmogul.com/reports/saas-growth-the-odds-of-making-it/)
- [UserGuiding - User onboarding statistics](https://userguiding.com/blog/user-onboarding-statistics)
- [WinRAR Revenue Model](https://breakevenpointcalculator.com/how-does-winrar-make-money-revenue-model-explained/)
- [PostHog - Open source business models](https://posthog.com/blog/open-source-business-models)
- [REO.dev - Grafana's wedge strategy to $250M ARR](https://www.reo.dev/blog/the-quiet-wedge-that-took-grafana-to-250m-in-a-crowded-market)
