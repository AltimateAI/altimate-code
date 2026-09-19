# Data Vault 2.0 Methodology and Delivery

Data Vault 2.0 is not just a modeling technique — the book presents
it as a complete methodology for building enterprise data warehouses,
including delivery patterns (agile / Scrum for DW), team structure,
release cadence, and testing discipline.

You don't have to adopt the whole methodology to benefit from the
modeling patterns, but understanding *why* the methodology looks the
way it does helps you avoid the traps that come from mixing DV 2.0
modeling with waterfall delivery.

## The Core Methodology Principles

The book's methodology chapters distill to these principles:

1. **Deliver working vault increments every sprint.** Not "design
   for six months, then load". A hub, a link, and one satellite is a
   complete increment — deploy it, use it, gather feedback.
2. **Raw vault ships ahead of business rules.** Raw vault is fast to
   build (source-shaped, hard rules only). Business vault + marts
   follow as consumers request them.
3. **Model per business concept, not per source.** A hub for
   "customer" ships before you've integrated every customer source.
   Subsequent sources union into the existing hub.
4. **Testability is baked in.** Every hub / link / satellite has a
   standard test suite. Every load has metrics + error handling.
5. **Parallelism > sequencing.** Because hash keys are deterministic,
   loaders can run in parallel. Sprint work parallelizes across
   teams working on different hubs / links.
6. **Automation everywhere.** Templates for hubs, links, satellites.
   Package macros (AutomateDV, datavault4dbt) that encode correctness
   defaults. Generated documentation from models.

## Sprint Structure

The book (following Scrum-for-DW patterns) prescribes short sprints
(typically 2 weeks) with these outcomes:

| Sprint outcome | Example |
|----------------|---------|
| New hub + one satellite from one source | `hub_customer` from CRM |
| Extension: add another source to existing hub | ERP added to `hub_customer` |
| New link + effectivity satellite | `lnk_customer_account` + `eff_customer_account` |
| First mart on top of new vault objects | `dim_customer` view over `hub_customer + sat_*` |
| Business rule promoted from mart to business vault | `bsat_customer_lifetime_metrics` |
| Metrics vault instrumentation for new feed | Metrics vault entries for CRM feed |

**Anti-pattern:** "Sprint 1: model the entire domain. Sprint 2: load
staging. Sprint 3: load hubs. Sprint 4: load links. Sprint 5: load
sats." Nothing ships until sprint 5, feedback comes at sprint 5, and
the model doesn't survive first contact with real users.

## Release Sequence Within a Feature

For a new source system, the book prescribes this order:

1. **Staging** — get the source into staging with hard-rule transforms.
   Ship this alone; users can query staging tables for exploratory work.
2. **Metrics vault + error mart entries for the new feed.** Instrument
   before deep integration.
3. **Hubs** — add the source's business keys to existing hubs (union)
   or create new hubs for new concepts.
4. **Satellites off the hubs** — one per change cadence group.
5. **Links** — the relationships in the source.
6. **Satellites off the links** — payload, effectivity, status.
7. **Reference-table refreshes** — if the source contributes to
   reference data.
8. **Information mart updates** — new columns / marts consuming the
   new vault objects.
9. **Business vault objects** — only when a downstream consumer
   requests derivation that spans sources or requires history.

Each step is a separately-shippable increment. Users get value at
every step; the team gets feedback at every step.

## Team Structure

The book recommends distinct roles, even in small teams:

- **Data engineer** — owns staging, hubs, links, sats. Understands
  hard rules deeply.
- **Business analyst / data steward** — owns business-key
  identification, relationship discovery, driver-key decisions.
- **Business vault developer** — owns computed sats / links, business
  rules. Straddles engineering and business.
- **Mart developer** — owns information marts. Consumer-facing.
- **Ops / SRE** — owns metrics vault, error mart, load orchestration,
  alerting.

Small teams (1–2 people) combine these; large orgs have specialists
per role. What matters is that the **hard rule / soft rule boundary
is respected across roles**. Engineers don't sneak business rules
into the raw vault; analysts don't demand mart-level filters in
staging.

## The "Sprintable" Test for Any Piece of Work

Before committing to a piece of vault work, apply the sprintable
test:

- [ ] Can it be shipped within one 2-week sprint?
- [ ] Is there a downstream consumer waiting for it?
- [ ] Is the raw vault increment independent of business rules?
- [ ] Does it have tests that will run automatically?
- [ ] Does its `record_source` and load metadata match the project
  convention?
- [ ] Is there a rollback plan if it goes wrong?

If any answer is no, either split the work or push it out.

## Testing Discipline

Every vault object ships with tests:

- **Hub:** `unique + not_null` on `_hk` and `_bk`. `not_null` on
  `load_dts`, `record_source`. Ghost row exists.
- **Link:** `unique + not_null` on `_hk`. `relationships` to every
  connected hub. `not_null` on `load_dts`, `record_source`.
- **Satellite:** `unique_combination_of_columns(parent_hk, load_dts)`.
  `not_null` on `hashdiff`, `load_dts`, `record_source`.
  `relationships` to parent hub/link. `assert_no_consecutive_matching_hashdiffs`.
- **PIT / bridge:** row count matches expected snapshot cardinality.
  `not_null` on snapshot_dts.
- **Business vault:** same as raw vault, plus `record_source` starts
  with `business_vault.`.
- **Mart:** consumer-facing tests — row counts against expected
  ranges, referential integrity within mart, `not_null` on user-facing
  columns.

Tests run on every commit (CI) and every deploy. A failing vault
test blocks the deploy.

## Documentation as Code

Every model has:

- **YAML documentation** (`_models.yml`) — description, columns,
  tests, business context.
- **Generated documentation site** (`dbt docs generate + serve`).
- **Data lineage graph** — from `dbt docs` or `altimate-dbt lineage`.

Book emphasizes that documentation must be *co-located* with the
model (same directory, same YAML file). Documentation in a separate
Confluence page rots; documentation in `_models.yml` is validated on
every dbt run.

## Change Management

Data Vault 2.0 is naturally friendly to change:

- **Adding a source to an existing hub** → new `UNION ALL` clause in
  the hub loader. No downstream breakage.
- **Adding a satellite** → new file, new load, no impact on existing
  models.
- **Adding a link** → new file, new load, no impact on existing
  models.
- **Changing a satellite's payload** → hashdiff evolution problem;
  see [hashing-and-keys.md](hashing-and-keys.md).
- **Deprecating a source** → mark rows with `record_source`,
  eventually stop loading; existing rows preserved.
- **Renaming a business key** → same-as link plus a new hub;
  historical hub is preserved.

**None of these change existing vault rows.** Insert-only means
every schema change is additive.

For breaking changes (rare — usually only forced by regulatory
requirements or physical warehouse migration):

1. Build the new structure alongside the old.
2. Backfill / replicate history.
3. Redirect downstream consumers.
4. Retire the old structure.
5. Keep old rows preserved even after retirement (audit).

## Governance and Compliance

Because raw vault is byte-for-byte re-buildable from source, compliance
questions become tractable:

- **GDPR "right to know"** — join across the vault for a specific
  customer_hk to reconstruct their history.
- **SOX audit** — every row has `load_dts`, `record_source`,
  `load_batch_id`; every load has metrics-vault entries.
- **Data lineage** — dbt's built-in DAG, `altimate-dbt column-lineage`,
  and `record_source` propagation give end-to-end lineage.
- **"Right to be forgotten"** — the hard case. The book's guidance:
  raw vault preserves history for as long as legal retention allows;
  deletion after retention expiry is handled by an explicit "purge"
  operation, not the normal insert-only load. Consult regulatory
  guidance for your jurisdiction.

## Estimation and Planning

For estimating vault work:

- **A new hub + first satellite from a single source** — ~3 person-days.
- **Adding a source to an existing hub** — ~1 person-day (mostly
  discovery + testing).
- **A new link + its effectivity satellite** — ~2 person-days.
- **A PIT + bridge for a new mart** — ~3–5 person-days depending on
  scope.
- **A computed business-vault satellite** — depends on rule complexity;
  typically 2–5 person-days.
- **A new mart** — 1 person-day for a virtualized view; 3–5 for a
  materialized dimensional mart.

Estimates assume automation via AutomateDV / datavault4dbt macros; add
50-100% if hand-rolling.

## Common Methodology Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Design the entire vault before loading anything | 6+ months to first value; users can't validate the design | Ship a hub + sat in sprint 1; iterate |
| One team member owns all vault knowledge | Bus factor of 1; changes bottleneck on them | Distinct roles; document conventions in the repo |
| Business rules snuck into raw vault "for speed" | Vault contaminated; audit lost | Enforce hard/soft rule discipline in code review |
| No metrics vault | Silent load failures; no SLA | Instrument every load from day 1 |
| Big-bang release of vault + marts + rules together | Feedback comes at the end; every issue is expensive | Sprint-scoped releases with staged mart ship |
| Doc-later mindset | Docs never happen; new team members ramp slowly | `_models.yml` written alongside every model; CI-checked |
| No naming convention enforcement | `hub_customer` and `HUB_CUSTOMER` coexist; refs break | Enforce via lint (SQLFluff, dbt-labs sqlfmt) in CI |
| Sprints scoped to source-system integrations instead of hubs | Some hubs get 5 sources, others get 0 — coverage skewed by team convenience | Sprint scope = business-concept increments, not per-source |
| Change requests handled by editing existing vault rows | Insert-only violated | Route all changes as new inserts (new load, new satellite version, new link row) |
| Retiring a source by deleting old rows | Audit destroyed | Stop loading; keep old rows; document retirement in `record_source` history |
