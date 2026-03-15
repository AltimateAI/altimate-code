# Open-Source Monetization Strategies for Developer/Data Tools
## Research Date: 2026-03-09

---

## 1. Harness.io

**What they do:** Unified AI software delivery platform (CI/CD, security testing, infrastructure-as-code management, cost optimization). Started as CD-only, acquired Drone.io in 2020 for CI capabilities. In 2025, merged with Traceable (observability).

**Revenue:**
- ~$156M revenue in 2024 ([Latka](https://getlatka.com/companies/harness))
- Exceeded $250M ARR in 2025 ([ARR Club](https://www.arr.club/signal/harness-io-surpassed-100m-arr))
- $5.5B valuation (Dec 2025 Series E, $240M raise) ([TechCrunch](https://techcrunch.com/2025/12/11/harness-hits-5-5b-valuation-with-240m-to-automate-ais-after-code-gap/))

**Free vs Paid:**
- Open-source: Drone CI, LitmusChaos (chaos engineering), Harness CD Community Edition
- Paid: Harness DevOps Essentials (unified platform). Pricing not publicly broken down per-seat.

**Monetization model:** Open-source community editions drive awareness; commercial platform sells as all-in-one DevOps suite to enterprises.

**Would "harness" in a data tool name cause confusion?** YES. Harness is a well-known brand in DevOps ($5.5B valuation, 1,600 employees). Using "harness" in a data tool name would likely cause search confusion and brand association issues, even if the domain is different. They own harness.io and the "Harness" trademark in software.

---

## 2. dbt Labs

**Timeline:**
- dbt Core: Open-source CLI, always free (Apache 2.0)
- dbt Cloud launched: **January 2020** (first paid product)
- Initially: Seat-based pricing only ($100/user/month)
- **August 2023**: Shifted to consumption-based pricing (per successful model materialization at $0.01/model)
- Legacy customers (pre-Aug 2023) stayed on unlimited-models seat-based plans

**Revenue:**
- $2M ARR → $100M ARR in ~4 years
- Passed $100M ARR in **February 2025** ([dbt Labs Press](https://www.getdbt.com/blog/dbt-labs-100m-arr-milestone))
- $73.1M revenue in 2023 ([Latka](https://getlatka.com/companies/getdbt.com))
- 5,000+ dbt Cloud customers
- 90% YoY growth in $100K+ ARR customers
- 85% YoY growth in Fortune 500 adoption

**Free vs Paid:**
- **Free (OSS):** dbt Core CLI - full transformation framework, all adapters, Jinja templating, testing, docs generation
- **Free (Cloud):** Developer plan - 1 seat, 3,000 models/month, browser IDE
- **Paid (Cloud):** Starter ($100/seat/month + $0.01/model), Team, Enterprise
- 14-day free trial of Starter for new accounts

**Conversion trigger:** Teams that outgrow CLI need: job scheduling, CI/CD integration, environment management, RBAC, audit logging, IDE in browser. The jump from "individual contributor running dbt locally" to "team of 5+ needing orchestration" is the conversion moment.

**Conversion rate:** Not publicly disclosed. With 5,000 Cloud customers vs. hundreds of thousands of Core users, rough estimate is **1-3% conversion**.

**Telemetry:** Uses Snowplow for anonymous event tracking. Collects: OS, Python version, invocation success/failure, duration, anonymized model hash, node count. Opt-out via `DO_NOT_TRACK=1` env var or `dbt_project.yml` config. Does NOT track credentials, model contents, or model names.

**Sign-up requirement:** dbt Core has no sign-up. dbt Cloud requires account creation (email).

---

## 3. Grafana Labs

**Revenue:**
- Surpassed **$400M ARR** in September 2025 ([Grafana Press](https://grafana.com/press/2025/09/30/grafana-labs-surpasses-400m-arr-and-7000-customers-gains-new-investors-to-accelerate-global-expansion/))
- $250M ARR as of August 2024 → $400M+ by Sep 2025 = **60% growth in ~13 months**
- 7,000+ customers including 70% of Fortune 50
- Valued at ~$9B (in talks as of early 2026) ([The Information](https://www.theinformation.com/articles/grafana-labs-talk-raise-9-billion-valuation))
- Cash flow break-even

**Free vs Paid:**
- **Free (OSS):** Grafana, Loki, Tempo, Mimir, k6 - all self-hosted, fully functional
- **Free (Cloud):** 10K metrics series, 50GB logs, 50GB traces, 50GB profiles, 50K frontend sessions, 500 VUh k6 testing, 2-week retention, 3 users, access to ALL Enterprise plugins
- **Paid (Cloud Pro):** Usage-based: $8-16/1K metric series, $0.40/GB logs, $0.50/GB traces, $15-55/user/month
- **Paid (Enterprise):** $25K/year minimum commit. RBAC, data source permissions, reporting, custom branding, auditing

**Key conversion trigger:** Scale. Free tier is generous enough for small teams/experiments. When you have 100K+ metrics or need >2-week retention, you pay.

**Conversion rate:** ~1% of 20M total users are paying customers ([Sacra](https://sacra.com/c/grafana-labs/))

**Strategy:** "Big tent" - support 100+ data sources, make the pie as large as possible, monetize a tiny fraction. "Open and composable" = everything is open-source, paid = managed service + enterprise features + support.

**Sign-up requirement:** OSS has no sign-up. Cloud requires account (GitHub/Google/email).

---

## 4. HashiCorp (pre-IBM acquisition)

**Revenue:**
- FY2023: **$583M revenue** (with $274M loss) ([MergerSight](https://www.mergersight.com/post/ibm-s-6-4bn-acquisition-of-hashicorp))
- FY2025 projected: ~$646M
- Acquired by IBM for **$6.4B** ($35/share), completed February 2025

**Monetization path:**
- Open-source Terraform, Vault, Consul, Nomad, Packer, Vagrant
- Commercial: HCP (HashiCorp Cloud Platform) - managed SaaS versions
- Enterprise: Self-hosted with governance, audit, SSO, Sentinel policy engine
- Support subscriptions
- Revenue split: ~$165M from support/license, ~$36M from professional services, rest from cloud

**The BSL license change (August 2023):**
- Switched ALL products from MPL 2.0 to Business Source License (BSL 1.1)
- Why: "Giving away too much for free" after missing financial targets
- Effect: Competitors can't offer hosted Terraform/Vault services
- Result: OpenTofu fork created by Linux Foundation
- Only ~20% of Forbes Global 2000 were customers; only 25% of customers exceeded $100K ARR

**Sign-up requirement:** Terraform CLI has no sign-up. HCP Terraform requires account.

---

## 5. Astronomer (Airflow)

**Revenue:**
- **$39.5M revenue** in 2025 (up from $24.5M in 2024) ([Latka](https://getlatka.com/companies/astronomer))
- 150% YoY growth in Astro (managed SaaS) ARR
- 130% net revenue retention
- $775M valuation (Series D, May 2025, $93M raise) ([Astronomer Press](https://www.astronomer.io/press-releases/astronomer-secures-93-million-series-d-funding/))

**How they monetize an Apache project they don't own:**
- **Managed service model**: Astronomer runs/manages Airflow infrastructure so users don't have to
- Astro pricing: Fixed hourly per deployment starting at **$0.35/hr** on Developer plan
- Workers scale to zero when idle (only pay for active tasks)
- Enterprise: Custom pricing with SLAs, dedicated support
- Available on AWS/Azure/GCP marketplaces
- They contribute heavily to upstream Apache Airflow, maintaining compatibility

**Free vs Paid:**
- **Free:** Apache Airflow (open-source, self-host yourself)
- **Paid:** Astro platform (managed Airflow with observability, alerting, environment management)
- Free trial to get started

**Key conversion trigger:** Managing Airflow infrastructure yourself is painful at scale (upgrades, scaling workers, monitoring). That pain drives conversion to managed Astro.

---

## 6. Elementary Data

**Funding:** $500K (Y Combinator, Cowboy Ventures, TLV Partners) ([Crunchbase](https://www.crunchbase.com/organization/elementary-data))

**Revenue:** Not publicly disclosed. Small team (~12 employees in Tel Aviv).

**Free vs Paid:**
- **Free (OSS):** Elementary dbt package - data quality tests, basic observability report, Slack/Teams alerts
- **Paid (Cloud):** Elementary Cloud - automated ML monitoring, column-level lineage (source to BI), built-in catalog, AI agents for reliability workflows, anomaly detection

**Monetization model:** Classic open-core. OSS package gets you hooked (trusted by 5,000+ engineers), Cloud adds ML-based anomaly detection and collaboration features.

**Sign-up requirement:** OSS package has no sign-up. Cloud requires account.

---

## 7. Great Expectations

**Revenue:** **$5.9M** in 2025 ([Latka](https://getlatka.com/companies/greatexpectations.io))

**Funding:** $65M total raised (Tiger Global, ClearBridge, others)

**Free vs Paid:**
- **Free (OSS):** GX Core - Expectation-based data validation framework, all built-in expectations, profiling, docs
- **Paid:** GX Cloud - hosted platform with governance, collaborative workflows, policy management, unlimited expectations and rows
- Free developer tier on GX Cloud during public preview

**Monetization model:** Open-core. OSS framework is widely adopted; Cloud adds team collaboration, governance, and managed infrastructure.

**Sign-up requirement:** GX Core has no sign-up. GX Cloud requires account.

---

## 8. Soda.io

**Revenue:** Estimated **$10-25M** range ([LeadIQ](https://leadiq.com/c/soda/5e1cf76e62be9f43ca78bb1f))

**Funding:** $28.4M total (Series B: $14M in July 2024). Achieved **financial self-sufficiency**. ([TechTarget](https://www.techtarget.com/searchdatamanagement/news/366593432/Data-quality-specialist-Soda-secures-14M-to-fuel-expansion))

**Free vs Paid:**
- **Free (OSS):** Soda Core (Python library + CLI, basic data quality checks, SodaCL language)
- **Paid:** Soda Cloud - anomaly detection, dashboards, alerting, data contracts, incident management
- **Premium:** Soda AI - natural language → data quality checks
- 45-day free trial

**Pricing model:** Subscription-based with tiers. Dataset-based pricing. ~125 employees across 5 continents.

**Key conversion trigger:** Dashboards, alerting, anomaly detection, and data contracts all require Soda Cloud.

---

## 9. Airbyte

**Revenue:**
- $20M revenue in 2024, up 25% in Q1 2025 ([Latka](https://getlatka.com/companies/airbyte.com))
- Estimated ARR exceeding $120M (conflicting sources - this may be inflated)
- $1.5B valuation (Series B, Dec 2021)
- $181M total funding

**Free vs Paid:**
- **Free (OSS):** Airbyte Core - self-hosted, MIT license (connectors) + ELv2 (platform). No feature gates, no usage limits, no time restrictions, NO sign-up required.
- **Paid (Cloud):** Usage-based credits. API sources: $15/M rows, DB sources: $10/GB. Free tier: $10/month includes 4 credits.
- **Paid (Enterprise):** Self-hosted with enterprise features (SSO, RBAC, etc.)

**Key conversion trigger:** Self-hosting Airbyte is operationally complex (Kubernetes, monitoring, upgrades). Cloud removes that burden. Credit-based model scales with data volume.

**Sign-up requirement:** OSS has NO sign-up. Cloud requires account + credit card for paid tier.

---

## 10. PostHog

**Revenue:**
- "Multiple $10s of millions" ARR (Q4 2025) ([PostHog Handbook](https://posthog.com/handbook/future))
- ~$9.5M ARR as of March 2024, growing 138% YoY ([Sacra](https://sacra.com/c/posthog/))
- Target: **$100M ARR by end of 2026**, eyeing IPO ([PostHog Handbook](https://posthog.com/handbook/future))
- 15.7% MoM growth for 12 months
- 5-day CAC payback period
- $1.4B valuation (Series E, Oct 2025, $75M)

**Free vs Paid:**
- **Free tier (generous):**
  - 1M product analytics events/month
  - 5,000 session recordings/month
  - 1M feature flag requests/month
  - 100K logged errors/month
  - 1,500 survey responses/month
  - Unlimited team members, no user tracking limits, API access
  - **No credit card required**

- **Paid:** Usage-based, starts at:
  - $0.00005/event (~$50/1M events after free tier)
  - $0.005/recording
  - Tiered step-down pricing (cheaper at higher volumes)
  - Hard spending caps available

**Conversion rate:** **98% of customers use PostHog for free.** ([PostHog Handbook](https://posthog.com/handbook/how-we-make-money)) Only ~2% pay.

**KEY monetization principles (from their public handbook):**
1. Hobbyists and pre-PMF startups use it free = word-of-mouth growth
2. Be more generous than competitors (larger free tier)
3. Features that demonstrate value → available on free plan with limits
4. Features that grow word-of-mouth (e.g., extra team members) → always free
5. Be cheapest at scale so it's a "no-brainer"
6. In May 2021, increased free event tier 100x → core pricing strategy since

**Sign-up requirement:** Account required (email/GitHub), but no credit card.

---

## 11. Supabase

**Revenue:**
- **$70M ARR** as of August 2025, growing 250% YoY ([Sacra](https://sacra.com/research/supabase-at-70m-arr-growing-250-yoy/))
- $30M ARR at end of 2024 → $70M by Aug 2025
- $2B valuation (March 2025, $100M+ raise led by Accel)

**Free vs Paid:**
- **Free (no credit card, no expiration):**
  - 50K MAUs, 500MB database, 1GB file storage, 2GB bandwidth
  - Unlimited API requests
  - One production MVP ran 4 months with 8,000 users without hitting limits
- **Pro ($25/month):** 100K MAUs, 8GB database, 100GB file storage, 250GB bandwidth
- **Team ($599/month):** SOC2 compliance, daily backups (14-day retention), priority support, SSO
- **Enterprise:** Custom pricing, dedicated support, custom SLAs, on-premise options

**Key conversion trigger:** Database size + MAU limits. Once your app grows past hobby stage, you need more storage and higher MAU cap.

**Sign-up requirement:** Account required (GitHub/email). No credit card for free tier.

---

## Cross-Cutting Analysis

### Usage-Based Pricing: Who Does It Well?

| Company | Pricing Unit | Works Well Because |
|---------|-------------|-------------------|
| PostHog | Events, recordings, requests | Generous free tier + hard spending caps = zero risk to try |
| Grafana | Metrics series, GB ingested | Scales linearly with infra complexity |
| dbt Labs | Model materializations | Directly tied to value (more models = more transforms = more value) |
| Airbyte | Rows synced / GB transferred | Tied to data volume = directly proportional to value |
| Supabase | MAUs, storage, bandwidth | Predictable (not per-operation) |
| Astronomer | Compute hours | Scale-to-zero means you don't pay for idle |

**Best practice:** Tie pricing to a metric the customer understands and that correlates with value received. PostHog and Supabase do this exceptionally well.

---

### Open Core vs. Open Source + Cloud vs. Source Available

| Model | Example | Revenue | Verdict |
|-------|---------|---------|---------|
| **Open Core** | GitLab, dbt Labs, Elementary | dbt: $100M ARR | Most proven for dev tools. Clear free/paid boundary. |
| **Open Source + Cloud** | Grafana, PostHog, Supabase | Grafana: $400M ARR, Supabase: $70M ARR | Fastest growing. Entire product is OSS; you pay for managed hosting. |
| **Source Available (BSL)** | HashiCorp, Elastic, MongoDB | HashiCorp: $583M → IBM $6.4B acquisition | Revenue ceiling higher but community backlash risk (OpenTofu fork). |

**Hybrid approaches (combining models) saw 27% higher revenue growth** than pure single-model approaches.

**Winner:** No single winner. But "Open Source + Cloud" is the current momentum leader. Companies keeping everything open-source and monetizing managed services are growing fastest (Grafana 60% YoY, Supabase 250% YoY, PostHog 138% YoY).

---

### Telemetry/Analytics in OSS Tools

| Tool | What's Collected | Opt-Out? | How |
|------|-----------------|----------|-----|
| **dbt Core** | OS, Python version, invocation success/failure, duration, anonymized model hash, node count | Yes | `DO_NOT_TRACK=1` env var or `dbt_project.yml` |
| **Terraform** | Uses OpenTelemetry protocol for agent telemetry | Varies | Config-dependent |
| **PostHog** | Dogfoods own product for tracking | N/A (SaaS) | N/A |

**Best practices:**
- Always opt-out available
- Never collect credentials, PII, or raw content
- Collect anonymized hashes, not actual values
- Transparent documentation of what's collected
- Use `DO_NOT_TRACK` environment variable (emerging standard)

---

### Developer Tool Marketplaces

| Marketplace | Scale | Revenue Impact |
|-------------|-------|---------------|
| **VS Code Extensions** | Marketplace expanding ~41% annually | Primary discovery channel for dev tools. No direct revenue (free extensions) but massive adoption driver. |
| **GitHub Actions** | 5M+ workflows/day, up 40% YoY | $35M in marketplace transactions. Strong for CI/CD tools. |
| **dbt Packages** | hub.getdbt.com | No revenue (all free). Key for community adoption. |
| **Airflow Providers** | PyPI distribution | No direct revenue. Ecosystem stickiness. |

**Verdict:** Marketplaces drive **adoption, not revenue**. They're top-of-funnel. The money comes when marketplace users hit scale limits and need the managed/enterprise offering.

---

## Summary: Revenue Scoreboard

| Company | ARR/Revenue | Valuation | Model | Conversion % |
|---------|-------------|-----------|-------|-------------|
| Grafana Labs | $400M+ ARR | ~$9B | OSS + Cloud | ~1% of 20M users |
| HashiCorp | $583M rev (FY23) | $6.4B (IBM) | Source Available | ~20% of F2000 |
| Harness.io | $250M+ ARR | $5.5B | Open Core | N/A |
| dbt Labs | $100M+ ARR | N/A (private) | Open Core | ~1-3% est. |
| Supabase | $70M ARR | $2B | OSS + Cloud | N/A |
| Astronomer | $39.5M rev | $775M | OSS + Cloud | N/A |
| PostHog | ~$40M+ ARR | $1.4B | OSS + Cloud | **2%** (98% free) |
| Airbyte | $20M+ rev | $1.5B | Open Core | N/A |
| Soda.io | $10-25M est. | N/A | Open Core | N/A |
| Great Expectations | $5.9M | N/A | Open Core | N/A |
| Elementary | <$5M est. | N/A | Open Core | N/A |

---

## Key Takeaways for Altimate Code

1. **1-3% conversion is the norm.** Plan for 97-99% of users being free. The 1-3% who pay must pay enough to build a business.

2. **Generous free tiers win.** PostHog, Grafana, and Supabase all offer genuinely useful free tiers with no credit card. This drives word-of-mouth.

3. **The managed service is the product.** Self-hosting is the moat against competitors; the cloud service is the revenue. Every successful company on this list makes most of their money from "we run it for you."

4. **Usage-based > seat-based.** dbt Labs literally switched from seat-based to consumption-based. Tie pricing to value delivered.

5. **Telemetry done right is accepted.** Anonymous, opt-out-able, well-documented telemetry is standard practice. `DO_NOT_TRACK=1` is the de facto standard.

6. **No sign-up for OSS, sign-up for cloud.** Every company follows this pattern. The OSS tool has zero friction. The cloud tool requires an account.

7. **BSL/source-available is a revenue play with community risk.** HashiCorp did it and got acquired for $6.4B, but also spawned OpenTofu. It works for revenue but damages community trust.

8. **Marketplaces are adoption funnels, not revenue channels.** VS Code extensions and GitHub Actions drive discovery. Revenue comes from the cloud offering.

---

Sources:
- [Harness $5.5B valuation - TechCrunch](https://techcrunch.com/2025/12/11/harness-hits-5-5b-valuation-with-240m-to-automate-ais-after-code-gap/)
- [Harness Revenue - Latka](https://getlatka.com/companies/harness)
- [dbt Labs $100M ARR](https://www.getdbt.com/blog/dbt-labs-100m-arr-milestone)
- [dbt Labs Revenue - Latka](https://getlatka.com/companies/getdbt.com)
- [dbt Consumption Pricing](https://www.getdbt.com/blog/consumption-based-pricing-and-the-future-of-dbt-cloud)
- [dbt Pricing](https://www.getdbt.com/pricing)
- [dbt Anonymous Usage Stats](https://docs.getdbt.com/reference/global-configs/usage-stats)
- [Grafana Labs $400M ARR](https://grafana.com/press/2025/09/30/grafana-labs-surpasses-400m-arr-and-7000-customers-gains-new-investors-to-accelerate-global-expansion/)
- [Grafana Labs Revenue - Sacra](https://sacra.com/c/grafana-labs/)
- [Grafana Pricing](https://grafana.com/pricing/)
- [Grafana Labs 2026 Recap](https://grafana.com/about/press/2026/02/03/grafana-labs-caps-a-breakout-year-of-growth-and-product-innovation/)
- [Grafana $9B Valuation Talks - The Information](https://www.theinformation.com/articles/grafana-labs-talk-raise-9-billion-valuation)
- [HashiCorp IBM Acquisition - MergerSight](https://www.mergersight.com/post/ibm-s-6-4bn-acquisition-of-hashicorp)
- [HashiCorp IBM Completion - IBM Newsroom](https://newsroom.ibm.com/2025-02-27-ibm-completes-acquisition-of-hashicorp,-creates-comprehensive,-end-to-end-hybrid-cloud-platform)
- [Astronomer Revenue - Latka](https://getlatka.com/companies/astronomer)
- [Astronomer Series D](https://www.astronomer.io/press-releases/astronomer-secures-93-million-series-d-funding/)
- [Astronomer Pricing](https://www.astronomer.io/pricing/)
- [Elementary Data - Crunchbase](https://www.crunchbase.com/organization/elementary-data)
- [Elementary Data - GitHub](https://github.com/elementary-data/elementary)
- [Great Expectations Revenue - Latka](https://getlatka.com/companies/greatexpectations.io)
- [GX Cloud Pricing](https://greatexpectations.io/pricing/)
- [Soda Funding - TechTarget](https://www.techtarget.com/searchdatamanagement/news/366593432/Data-quality-specialist-Soda-secures-14M-to-fuel-expansion)
- [Soda Pricing](https://soda.io/pricing)
- [Airbyte Revenue - Latka](https://getlatka.com/companies/airbyte.com)
- [Airbyte Pricing](https://airbyte.com/pricing)
- [Airbyte Q1 2025 Growth](https://www.businesswire.com/news/home/20250515802894/en/Airbyte-Announces-First-Quarter-Growth-New-Product-Features-Industry-Recognition)
- [PostHog How We Make Money](https://posthog.com/handbook/how-we-make-money)
- [PostHog Pricing Principles](https://posthog.com/handbook/engineering/feature-pricing)
- [PostHog Future/IPO Plans](https://posthog.com/handbook/future)
- [PostHog Pricing](https://posthog.com/pricing)
- [PostHog Revenue - Sacra](https://sacra.com/c/posthog/)
- [PostHog $1.4B Series E - Contrary Research](https://research.contrary.com/company/posthog)
- [Supabase $70M ARR - Sacra](https://sacra.com/research/supabase-at-70m-arr-growing-250-yoy/)
- [Supabase Pricing](https://supabase.com/pricing)
- [Supabase Billing Docs](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Open Core vs Open Source - Palark](https://blog.palark.com/open-source-business-models/)
- [Usage-Based Pricing Examples - Orb](https://www.withorb.com/blog/usage-based-pricing-examples)
- [Harness Pricing](https://www.harness.io/pricing)
