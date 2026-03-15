# Position Paper: Column-Level Lineage from a Practitioner's Chair

**Author perspective:** Senior Data Engineer, 200-person company, 15-person data team, dbt + Snowflake stack, 6 years in the field.

---

## 1. What I Actually Care About

Let me skip the sales pitch and talk about the three scenarios that make me lose sleep.

### Scenario A: The Rename That Broke Everything

Last quarter I renamed `user_id` to `account_id` in `stg_payments` to align with our new naming convention. Seemed harmless. I ran `dbt build`, everything compiled, tests passed. Merged to main. Monday morning, three Looker dashboards are showing nulls because they were referencing `user_id` through an intermediate model I forgot about. The BI team filed a P1. My manager asked why our tests didn't catch it.

Column-level lineage would have told me in seconds: "Hey, `stg_payments.user_id` feeds into `int_payment_metrics.user_id`, which feeds into `fct_revenue.user_id`, which is exposed to Looker through `metrics_revenue`." I would have updated all four models before merging. Instead I spent my Monday doing damage control.

This is NOT a theoretical problem. This happens to every dbt project above 50 models. We have 400+ models. It happens monthly.

### Scenario B: PII Leakage

Our `stg_users` model has `email`, `full_name`, and `ip_address`. Those columns should never leave the staging layer without being hashed or dropped. But someone wrote a `JOIN` in an intermediate model that pulled in `email` alongside order data, and that intermediate model feeds into a marketing analytics model that's exposed to our Amplitude integration.

We found out during a SOC 2 audit. The auditor asked us to prove PII doesn't flow into third-party tools. We couldn't. We spent two weeks manually tracing every column through every model. Column-level lineage turns that two-week exercise into a 30-second query.

For any company that handles PII (which is everyone), this is not optional. It is a compliance requirement that we currently satisfy with manual labor and prayer.

### Scenario C: "What feeds into this KPI?"

Our CFO asks: "How is `net_revenue` calculated?" I open `fct_revenue`, see it's `gross_revenue - refunds - chargebacks`. Okay, where does `gross_revenue` come from? It's from `int_order_totals`. Where does that come from? `stg_orders.amount * stg_orders.quantity`, but only where `status != 'cancelled'` and `order_date` is in the current fiscal period, which is defined in a macro that references a seed file.

Without column-level lineage, I spend 20 minutes clicking through model files to trace this. With it, I get the full column-to-column path in one call. This matters because the CFO asks this kind of question every week, and the answer needs to be right.

### What I do NOT care about

- Pretty graph visualizations for their own sake. I am not going to stare at a DAG. I need answers.
- "Lineage-powered documentation." My dbt docs already have descriptions. I need impact analysis, not prettier docs.
- Cross-database lineage across Snowflake + Postgres + BigQuery. We use one warehouse. Most companies do.

---

## 2. How I Discover and Adopt Tools

Here is my actual process, in order:

**Step 1: I hear about it.** Usually dbt Slack, a blog post on the dbt Developer Blog, or a coworker mentions it in standup. Occasionally Twitter/X. I do NOT read vendor emails or attend webinars.

**Step 2: I check the GitHub repo.** If it's open source, I look at: stars (social proof), last commit date (is it maintained?), issues (are they responsive?), and the README (does it explain what this does in 30 seconds?). If the README starts with "Enterprise-grade observability platform for the modern data stack," I close the tab.

**Step 3: I try it locally in under 10 minutes.** This is the critical gate. If I can't `pip install` or `brew install` and get a result on my actual project within 10 minutes, I'm done. I will not:
- Fill out a form to "request access"
- Schedule a demo
- Connect my production warehouse to a SaaS platform I just discovered
- Create an account before seeing if it works

I will tolerate: providing my email for a free API key if the tool is clearly good. But only after I've seen it work.

**Step 4: I use it for a week on real work.** Not a demo project. MY project, with MY 400 models and MY weird edge cases. If it handles our `{{ ref() }}` patterns, our custom macros, and our multi-hop models, then it's real. If it chokes on anything beyond `SELECT * FROM {{ ref('stg_orders') }}`, it's a toy.

**Step 5: I tell my team.** If I've been using it for a week and it's genuinely useful, I mention it in our team sync. "Hey, I've been using X for impact analysis, it's pretty good." This is how tools spread in data teams: practitioner-to-practitioner, not top-down.

**Step 6: My manager asks about cost.** If the team likes it, my manager asks "what does it cost?" and "can we expense it?" For $29/month per person, I can usually get this approved without a procurement process. For $49+/month, it goes through our data platform budget and takes 2-3 months. For anything requiring a sales call, add 6 months and a 50% chance it never happens.

**I do NOT need manager approval to install CLI tools.** I have admin on my laptop. If it's open source or free tier, I just use it. This is true for most data engineers at companies our size.

---

## 3. What Would Make Me Pay $29/Month

Let me be precise about the conversion moment. It is NOT a feature gate. Feature gates make me annoyed, not convinced. "You've hit your limit of 5 lineage calls" makes me think "this tool is trying to nickel-and-dime me," not "I should pay."

The moment I would pay is one of these:

**Moment A: It saves me from a production incident.** If the tool tells me "this column rename will break 3 downstream models and 2 exposures" and I verify that's true, and it would have taken me 30 minutes to figure that out manually — that's when I think "this is worth $29/month." One prevented P1 incident pays for a year of the tool.

**Moment B: My manager sees the output.** If I'm doing an impact analysis in a PR review and I paste the lineage output showing exactly what's affected, my manager will say "can we get this for the whole team?" That's a team purchase, not an individual one. And that's where your real revenue is.

**Moment C: Compliance needs it.** If our security team asks "show me everywhere PII flows" and I can generate that report in 60 seconds instead of 2 weeks, that tool just became a line item in our compliance budget. Compliance budgets are larger and less price-sensitive than engineering budgets.

**What would NOT make me pay:**
- A usage cap on a free tier. I'll just work around it.
- "Premium support." I've never contacted support for a CLI tool.
- SSO/SAML. That's my IT department's problem, not mine.
- A dashboard or web UI. I live in the terminal and my IDE.

---

## 4. What Would Make Me STOP Using It

These are hard dealbreakers, in order of severity:

**Dealbreaker 1: It sends my code to a server without telling me.** If I find out the tool is phoning home with my SQL, my schema, my model names — I uninstall immediately and post a warning in dbt Slack. "Local-first" means local-first. I've uninstalled tools for this before. I will do it again.

**Dealbreaker 2: It breaks my existing workflow.** If adopting this tool means I need to change how I run `dbt build`, or it conflicts with my pre-commit hooks, or it adds 30 seconds to my CI pipeline, I'm not going to adjust my workflow to accommodate the tool. The tool needs to fit into MY workflow.

**Dealbreaker 3: Aggressive upsell interruptions.** If every third command shows me a banner saying "Upgrade to Pro for full lineage!" I will find an alternative. One tasteful message on first use is fine. Repeated interruptions in my terminal while I'm trying to work is disrespectful. I'm looking at you, every npm package that prints ASCII art on install.

**Dealbreaker 4: It gets the answer wrong.** If lineage says "column X only flows to model A" and it actually flows to models A, B, and C, that's worse than not having lineage at all. False confidence is more dangerous than no confidence. Accuracy must be near-100% or it's not trustworthy.

**Dealbreaker 5: It stops working and I can't figure out why.** Silent failures are the worst. If the tool just returns empty results because my dbt project structure is slightly non-standard, and there's no error message telling me why, I'll assume it's broken and move on.

**Dealbreaker 6: License bait-and-switch.** If the tool is open source today and the lineage feature gets pulled into a paid-only tier tomorrow, my trust is gone. Be upfront about what's free and what's paid from day one.

**Annoying but tolerable:**
- Requiring an API key for advanced features. Fine, as long as core features work without one.
- Occasional bugs in edge cases, as long as there's an active issue tracker and responsive maintainers.
- Slightly outdated documentation. I can read source code.

---

## 5. The Agent Angle

This is where it gets interesting, and where I think the product team might be overthinking it.

**Do I care that lineage exists if the agent writes correct SQL?** Honestly? Not much. If I tell the agent "rename `user_id` to `account_id` in `stg_payments` and fix all downstream references," and it does that correctly because it used lineage internally, I don't care whether it used lineage, grep, or witchcraft. I care that the output is correct.

**But here's the catch:** I DO care about verifiability. If the agent says "I've updated all downstream references," I want to verify that claim. And the fastest way to verify it is to see the lineage myself — "show me every model that references `stg_payments.user_id`" — and confirm the agent got them all.

So lineage serves two roles:
1. **Agent-internal:** Makes the agent better at its job. I don't directly see this. I just see better output.
2. **Human-verifiable:** Lets me check the agent's work. I directly see this and it's valuable.

**How this changes what I'd pay for:**

If the agent is the primary consumer, then lineage is not a standalone product — it's a quality multiplier for the agent. I'm not paying $29/month for lineage. I'm paying $29/month for an agent that doesn't break my project when I ask it to refactor something. Lineage is an implementation detail.

This means: **don't sell me lineage. Sell me a better agent.** The pricing should be for the agent experience, and lineage should be one of the reasons the paid agent is better than the free agent.

If you gate lineage separately from the agent, you create a weird situation where the free agent is deliberately worse because you're withholding a capability from it. That feels punitive. Instead, make lineage one of several things that make the paid tier's agent demonstrably better. More accurate refactoring. Better impact analysis. PII flow detection. Package those as "Pro agent capabilities" rather than "lineage access."

**The exception:** If you offer lineage as a standalone tool (CLI command, CI check), separate from the agent, then it's a different product with a different value proposition. A `altimate lineage check --pii` command that runs in CI and fails the build if PII flows into an exposure — that's worth paying for independently because it's a compliance tool, not an agent feature.

---

## 6. What I'd Actually Pay For (vs. Enterprise Wishlist)

### What I'd pay for with my own money (or easily expensed):

| Feature | Why | What I'd Pay |
|---------|-----|--------------|
| Impact analysis in CI | "This PR affects these downstream models/dashboards" as a PR comment | $29/mo, no hesitation |
| PII flow detection | "These PII columns flow into these exposed models" as a report | $29/mo, compliance will reimburse me |
| Agent that understands my project's data flow | Refactoring, debugging, writing new models with awareness of what exists | $29/mo, if agent quality is noticeably better |
| Column-level `dbt ls` equivalent | "Show me every model that uses `orders.amount`" from the CLI | Would love this free, would pay $10-15/mo |

### What my manager would pay for:

| Feature | Why | What they'd pay |
|---------|-----|-----------------|
| Team-wide impact analysis dashboard | "Show me the blast radius of this change across all our models" | $49/user/mo for the team |
| Automated PII audit reports | SOC 2 evidence generation | Budget is flexible here |
| CI integration with PR checks | Enforce lineage-aware reviews before merge | $49/user/mo easily justified |

### What I absolutely do NOT care about:

| Feature | Why I don't care |
|---------|-----------------|
| SSO/SAML | IT department's problem, not mine |
| Audit logs of who ran lineage | Nobody will ever read these |
| Role-based access control for lineage | My whole team should see everything |
| "Lineage-powered data catalog" | We already have one (or don't want one) |
| Web UI / dashboard for exploring lineage | Terminal is fine. Maybe VS Code extension. |
| Cross-warehouse lineage | We use Snowflake. Period. |
| Historical lineage / lineage versioning | I care about what's true NOW |
| Slack/Teams notifications | I have enough notifications |

### The honest truth about pricing psychology:

$29/month is below the threshold where I need approval. I can expense it or put it on my corporate card. $49/month is borderline. $100/month requires a budget conversation. $150/month requires vendor evaluation and my manager talking to their manager.

If you want individual adoption that leads to team adoption, price the individual tier at $29/month and make it genuinely useful for a single engineer. Let the team adoption happen organically when other engineers see me using it.

---

## 7. The Competitive Landscape from My Seat

Here's what's already on my machine and what I'm NOT eager to replace:

**dbt Core / dbt Cloud:** My entire project runs on this. It has table-level lineage already. It does NOT have column-level lineage (dbt Cloud has some, but it requires the hosted platform). If altimate-code gives me column-level lineage locally, that's genuinely differentiated from dbt Core.

**Snowflake:** Has ACCESS_HISTORY and column-level lineage in Enterprise Edition. But it only works for queries that have already run, it requires Enterprise pricing, and it doesn't understand dbt model relationships. It traces SQL execution, not dbt project structure. Different thing.

**SQLMesh:** Has built-in column-level lineage. It's good. But adopting SQLMesh means migrating away from dbt, and I'm not doing that. Our team has 2 years invested in dbt. If SQLMesh's lineage is the only reason to switch, it's not enough.

**Datafold:** Cloud-based column-level lineage. Requires sending metadata to their servers. Good product but the security team pushed back on it. Also $$$$ at scale.

**Elementary:** dbt-native observability. Has some lineage features but focused on data quality monitoring, not column-level flow analysis. Complementary, not competitive.

**SDF (Structured Data Framework):** Has column-level lineage with a Rust-based SQL compiler. Very similar positioning to what altimate-code seems to be doing. If I'm evaluating altimate-code, I'm also evaluating SDF. The deciding factor will be: which one works better with my existing dbt project, right now, without changing anything?

**Great Expectations / Soda:** Data quality testing. Not lineage. Different category.

### What would make me add ANOTHER tool:

**Must have:**
- Works with my existing dbt project without modification
- Column-level lineage that's accurate across CTEs, JOINs, window functions, and dbt macros
- CLI-first (I shouldn't need a browser)
- Local execution (nothing leaves my machine without my explicit consent)
- Under 5 minutes to first useful result on my real project
- Active maintenance (commits in the last month, issues being responded to)

**Nice to have:**
- CI integration (GitHub Actions / GitLab CI)
- VS Code extension
- PII tagging / classification integration
- `dbt docs` integration

**Actively do NOT want:**
- Another SaaS platform to log into
- Another dashboard to check
- Another Slack bot sending me messages
- A tool that requires me to model my project differently

### The bottom line on competition:

The tools that will win are the ones that feel like a natural extension of dbt, not a replacement for it and not a separate platform. If I can type `altimate lineage stg_payments.user_id` and instantly see every downstream column affected, and it just works with my project as-is, that's a tool I'll keep. If I need to configure a YAML file, connect to a metadata API, or sign up for an account before I see any output, you've already lost to the next tool that doesn't make me do that.

---

## Summary: What I Want the Product Team to Hear

1. **Sell me a better agent, not lineage.** Lineage is an implementation detail. The value is "your refactors don't break things."

2. **Let me try it without friction.** No signup, no API key, no configuration. `altimate-code` + my dbt project = results in 5 minutes.

3. **The conversion moment is an incident prevented, not a feature gate.** I'll pay when you save me from a P1, not when you block me from a feature.

4. **$29/month for individuals, team expansion is where your revenue comes from.** Don't try to extract maximum individual revenue. Make individuals love it so they bring it to their team.

5. **CI integration is the enterprise wedge.** "This PR will break these downstream columns" as a PR check is something my manager will mandate for the whole team. That's 15 seats at $49/month. Build this first.

6. **Never, ever, send my code to a server without explicit consent.** This is non-negotiable and will sink your product if you get it wrong.

7. **Be honest about what's free and what's paid from day one.** I can handle paying for good tools. I cannot handle bait-and-switch.
