# Governance, Privacy, and Right-to-Erasure

Data Vault 2.0's insert-only design is fantastic for auditability and
terrible for GDPR/CCPA/HIPAA "right to be forgotten" (RTBF) requests
if you didn't plan for it. This reference covers the concrete patterns
that make a raw-vault-based warehouse actually compliant, plus PII
placement inside the modeling decisions and data-classification
propagation from source through to the mart.

**This reference is enterprise-scoped.** For a solo/small-domain
vault with no regulated data, most of it is over-engineering. Load it
only when the user has confirmed one or more of: PII in scope,
regulated industry (health, finance, government), SaaS-B2B customer
data, EU/California/UK data subjects, or a stated compliance regime.

---

## Ask the User First — Before Writing Any Compliance Code

Before applying any of the patterns below, get explicit answers to:

1. **Which regimes apply?** GDPR / CCPA / HIPAA / SOX / PCI-DSS /
   FERPA / state-specific (Colorado, Virginia, etc.) / sectoral
   (finance FINRA, health HIPAA)? Each has different retention,
   subject-rights, and audit requirements.
2. **What's the retention obligation vs. right?** GDPR gives a
   subject the *right* to erasure; SOX *requires* 7-year retention of
   financial records. These conflict — the resolution is usually
   "erase PII but retain de-identified financial audit trail." You
   must know which side of that line each column falls on.
3. **What's the deletion SLA?** GDPR is 30 days from verified
   request. CCPA is 45 days. HIPAA doesn't have RTBF but has an
   accounting-of-disclosures duty. Pick the tightest SLA your
   business faces.
4. **Is there a legal-hold override?** Any active litigation freezes
   deletion. You need a way to flag holds *without* violating
   insert-only.
5. **Who is the data subject?** The customer (natural person)? An
   employee? A B2B contact who happens to be an EU citizen? Each
   maps to different hub identities.
6. **Which storage tier holds the vault?** Some strategies (physical
   deletion) are fine on Snowflake with Time Travel disabled; the
   same strategy on Databricks Delta with a 30-day retention needs
   `VACUUM RETAIN 0 HOURS` (dangerous) or a different pattern.
7. **What's the current classification taxonomy?** PII / PHI /
   confidential / public? If none exists, propose one now — the
   satellite-design decisions in this reference all depend on it.

**Do not proceed to code without these answers.** Assuming any one
of them is what produces a "compliant on paper, uncompliant in
production" vault.

---

## The Three Erasure Patterns

The raw vault's insert-only rule cannot coexist with row-level
deletion. You get to pick one of three patterns instead. Every
production DV shop uses one; picking the wrong one for your
constraints is an expensive mistake.

### Pattern A — Crypto-Shredding (preferred for GDPR/CCPA)

**How it works:** encrypt every PII column at load with a
per-subject key. When a subject requests erasure, delete the key.
The ciphertext remains in the satellite (audit intact); it is
mathematically irrecoverable.

**Key management:**
- Per-subject key held in a KMS (AWS KMS, GCP KMS, Azure Key Vault,
  HashiCorp Vault). Snowflake / Databricks / BigQuery integrate
  natively.
- Key ID = hash of the customer business key (deterministic; every
  loader produces the same key ID for the same subject).
- Key deletion is the erasure event. Log the deletion in a
  compliance audit table (see below).

**Vault-side code:**

```sql
-- Encrypt at satellite load
SELECT
    {{ dv_hash_bk(['customer_id']) }} AS customer_hk,
    {{ dv_hashdiff(['email_ciphertext', 'first_name_ciphertext', ...]) }} AS hashdiff,
    ENCRYPT(email, get_subject_key(customer_id))       AS email_ciphertext,
    ENCRYPT(first_name, get_subject_key(customer_id))  AS first_name_ciphertext,
    ...
FROM staging
```

**Erasure operation (compliance macro, not a vault load):**

```sql
{% macro erase_subject(customer_id) %}
    -- 1. Delete the key from KMS (irrecoverable).
    {{ kms_delete_key('customer:' ~ customer_id) }}

    -- 2. Log the deletion in the compliance audit trail (append-only).
    INSERT INTO compliance_audit.erasure_events
        (event_id, subject_business_key, requested_at, completed_at,
         regime, request_ticket_id, operator)
    VALUES (
        UUID_STRING(),
        {{ dv_hash_bk([customer_id]) }},
        CURRENT_TIMESTAMP(),
        CURRENT_TIMESTAMP(),
        'GDPR',
        '{{ ticket_id }}',
        CURRENT_USER()
    );

    -- 3. Vault untouched. Ciphertext remains but is unreadable.
{% endmacro %}
```

**Advantages:**
- Vault stays insert-only, byte-for-byte re-buildable.
- Audit trail intact — you can *prove* the deletion happened.
- Reversible until the key is actually deleted (bugs recoverable).
- Works across every warehouse.

**Disadvantages:**
- Every PII column needs decrypt at read time in the mart. Cost.
- Key rotation is a nontrivial project.
- Doesn't remove the fact that "some data existed for this subject";
  it removes the data itself. Some regulators consider the ciphertext
  presence a residual liability — get legal sign-off.

### Pattern B — Tokenization

**How it works:** at load, replace PII values with reversible tokens
via a tokenization vault (separate from the DV vault). The vault
stores tokens; the tokenization vault holds the token→plaintext map.
Erasure = delete the mapping row.

**Same insert-only vault code; the difference is where sensitivity
lives.** Marts detokenize on read.

**When to prefer over crypto-shredding:**
- Regulator specifically wants "the data itself" (not encrypted
  data) removed.
- You need PII to be *searchable* (email lookup, phone match) —
  tokens preserve format; a format-preserving tokenizer keeps
  `+1-555-0123` as a valid-shape token.
- Third-party tokenization vendor already exists in the org
  (VGS, Skyflow, TokenEx, etc.).

**Vendor lock-in is real.** The tokenization vault becomes a
critical dependency; plan for provider migration.

### Pattern C — Explicit Purge Exception (least preferred, sometimes required)

**How it works:** define a documented, audited exception to
insert-only that physically deletes PII from named satellite
columns. Every purge event is logged in a compliance audit table.

**When you're forced to use it:**
- Regulator has explicitly rejected patterns A and B (rare, but
  happens in strict interpretations of GDPR "erasure").
- Storage cost of retained ciphertext is prohibitive at your scale.
- Legacy warehouse without KMS integration.

**Template:**

```sql
{% macro purge_subject_pii(customer_id) %}
    -- This is an EXPLICIT EXCEPTION to insert-only.
    -- Every call must be audited.

    -- 1. Log intent BEFORE deletion.
    INSERT INTO compliance_audit.purge_events (event_id, customer_hk,
        purge_started_at, request_ticket_id, columns_purged, operator)
    VALUES (UUID_STRING(),
            {{ dv_hash_bk([customer_id]) }},
            CURRENT_TIMESTAMP(),
            '{{ ticket_id }}',
            'first_name,last_name,email,phone,address_*',
            CURRENT_USER());

    -- 2. UPDATE (yes, UPDATE) the PII columns to sentinel values.
    --    Preserve hash keys and load metadata so referential integrity
    --    holds and the audit trail can still reconstruct WHEN the row
    --    existed (just not the PII value).
    UPDATE raw_vault.sat_customer_pii
    SET first_name = '<PURGED>',
        last_name  = '<PURGED>',
        email      = '<PURGED>',
        phone      = '<PURGED>',
        hashdiff   = 'PURGED-' || {{ dv_hash_bk([customer_id]) }}
    WHERE customer_hk = {{ dv_hash_bk([customer_id]) }};

    -- 3. Log completion.
    UPDATE compliance_audit.purge_events
    SET purge_completed_at = CURRENT_TIMESTAMP()
    WHERE customer_hk = {{ dv_hash_bk([customer_id]) }}
      AND purge_completed_at IS NULL;
{% endmacro %}
```

**Critical guardrails when using pattern C:**
- **PII-only satellites** (see below) — purge affects one narrowly-scoped
  table, not everything.
- Never purge hash keys, load metadata, or non-PII columns.
- After a purge, downstream PIT/mart rebuilds must handle the
  `<PURGED>` sentinel gracefully.
- The purge macro is the ONLY allowed writer to any UPDATE statement
  in the raw vault. Enforce via schema permissions.
- CI test that verifies the purge macro is idempotent and preserves
  hash keys.

**Do not use pattern C by default.** Reserve it for the specific
regulator/scale combinations that force it.

---

## PII Placement — Split Satellites by Classification, Not Just Cadence

The default satellite guidance (see [satellite-patterns.md](satellite-patterns.md))
says "split by change cadence." For enterprise use, **classification
level dominates cadence** as the split criterion. A single mixed
satellite makes erasure and RLS grants impossibly broad.

### The Classification-First Split

For every hub, ask: **which classification levels of descriptive
data need to hang off it?** Common tiers:

| Tier | Examples | Access pattern |
|------|----------|----------------|
| **Public** | product name, category | anyone with mart access |
| **Internal** | order status, quantity, currency | employees + partners |
| **Confidential** | pricing tier, contract terms | finance + sales only |
| **PII** | name, email, phone, address | GDPR-scoped roles + auditor |
| **PHI** | diagnosis, medication (health) | HIPAA-scoped roles only |
| **Regulated financial** | SSN, bank account, card | PCI-DSS-scoped roles |

**One satellite per tier per hub.** Not one satellite per column,
not one satellite per hub. The tier is what determines:
- Row-level security policy attached.
- Column-masking policy attached.
- Erasure procedure that applies.
- Retention duration.
- Access-audit granularity.

### Example — hub_customer with tiered satellites

```
hub_customer
├── sat_customer_pii              ← name, email, phone, address (crypto-shredded)
├── sat_customer_engagement       ← last_login, session_count (internal)
├── sat_customer_financial        ← credit_tier, lifetime_value (confidential)
└── sat_customer_public           ← join_year, tier_display (public)
```

Erasure = crypto-shred the per-subject key that unlocks `sat_customer_pii`.
The other three satellites remain intact — they're not covered by RTBF
(no direct identifiers), and business/audit needs them.

### Within a Tier, Then Split by Cadence

`sat_customer_pii` might still be split into `sat_customer_pii_identity`
(name, DOB — never changes) and `sat_customer_pii_contact` (email,
phone, address — changes occasionally). Classification is the outer
split; cadence is the inner.

**Ask the user first:** *"What's your classification taxonomy? Do
you have one, or should we propose GDPR-standard (Public / Internal /
Confidential / PII / PHI)? For each column in the source, which tier
does it fall in?"* This can't be inferred from column names; the
business/legal owner must confirm.

---

## Data Classification Tag Propagation

Classification tags must survive from source ingestion all the way to
mart consumption. Otherwise, the mart layer re-classifies from scratch
(inconsistent) or worse, treats everything as public.

### Column-Level Metadata

Every satellite column gets a `classification` and (where applicable)
`erasure_strategy` tag in `_models.yml`:

```yaml
models:
  - name: sat_customer_pii
    columns:
      - name: email
        description: Customer email (crypto-shredded per-subject).
        meta:
          classification: pii
          pii_type: email
          erasure_strategy: crypto_shred
          retention_days: null   # persists until erasure request
      - name: first_name
        meta:
          classification: pii
          erasure_strategy: crypto_shred
      - name: hashdiff
        meta:
          classification: internal
```

### Propagation Rules

1. **Staging → satellite:** classification declared once per source
   column; the corresponding satellite column inherits it. Automate
   via a `dbt-classification` check in CI that fails if a satellite
   column has no classification tag.
2. **Satellite → PIT:** PIT columns are pointers, always internal.
3. **Satellite → mart:** every mart column that references a
   satellite column with classification ≥ PII must have a matching
   masking/RLS policy declared. CI test enforces this.
4. **Cross-mart aggregation:** any aggregation over a PII column
   produces a non-PII output *only if* the aggregation is documented
   as k-anonymous (k ≥ 5 typical). Otherwise the aggregation
   inherits the source's classification.

### altimate-code Companion — pii-audit

The `pii-audit` companion skill does the classification analysis.
Invoke it during Discover (see SKILL.md's companion-skills section)
**before** finalizing satellite splits. Feed its classification
output into the tier-based satellite design above. Do not skip this
step and eyeball classifications yourself.

---

## Legal Hold — Freezing Deletion Without Violating Insert-Only

When active litigation, subpoena, or regulatory investigation
freezes a subject's data, the erasure request cannot proceed even if
the subject requests it. You need an override mechanism.

### Pattern — Legal Hold Registry

A separate `compliance.legal_holds` table (append-only, insert-only,
but *not* in the raw vault — it's a compliance artifact):

```sql
CREATE TABLE compliance.legal_holds (
    hold_id            UUID           NOT NULL,
    subject_hk         BINARY(16)     NOT NULL,   -- hub_customer.customer_hk
    hold_started_at    TIMESTAMP      NOT NULL,
    hold_released_at   TIMESTAMP,                 -- NULL = still active
    matter_reference   VARCHAR        NOT NULL,   -- case number
    scope              VARCHAR,                   -- 'full', 'pii-only', etc.
    imposed_by         VARCHAR        NOT NULL,   -- legal team member
    record_source      VARCHAR        NOT NULL DEFAULT 'compliance.legal_holds'
);
```

### Every Erasure Macro Checks the Registry First

```sql
{% macro erase_subject(customer_id) %}
    {% set hold_check %}
        SELECT COUNT(*) FROM compliance.legal_holds
        WHERE subject_hk = {{ dv_hash_bk([customer_id]) }}
          AND hold_released_at IS NULL
    {% endset %}
    {% set hold_count = run_query(hold_check).columns[0][0] %}
    {% if hold_count > 0 %}
        {{ exceptions.raise_compiler_error(
            "Cannot erase " ~ customer_id ~ ": subject is under active legal hold. "
            "Escalate to legal team before proceeding."
        ) }}
    {% endif %}
    -- ... rest of erasure logic
{% endmacro %}
```

**Ask the user first:** *"Do you have an existing legal-hold
registry, or does one need to be built as part of this project? Who
owns it — legal, compliance, or engineering?"*

---

## The Compliance Audit Trail

Every erasure, purge, or legal-hold event goes into an append-only
audit table. This is what you show a regulator during an audit.

```sql
CREATE TABLE compliance_audit.subject_actions (
    event_id           UUID           NOT NULL PRIMARY KEY,
    subject_hk         BINARY(16)     NOT NULL,
    action             VARCHAR        NOT NULL,   -- 'erasure', 'purge', 'hold', 'release'
    action_at          TIMESTAMP      NOT NULL,
    regime             VARCHAR,                   -- 'GDPR', 'CCPA', 'HIPAA', etc.
    ticket_id          VARCHAR        NOT NULL,
    operator           VARCHAR        NOT NULL,
    scope_description  VARCHAR,                   -- which columns/tables affected
    strategy           VARCHAR,                   -- 'crypto_shred', 'tokenize', 'purge'
    verification_hash  VARCHAR,                   -- hash of pre-erasure state for audit
    record_source      VARCHAR        NOT NULL DEFAULT 'compliance.audit'
);
```

Rules:
- **Insert-only** (like the vault) — audit rows are never modified.
- **Separate from the raw vault** — different schema, different
  access permissions. Vault engineers should not have write access.
- **Retention independent of business retention** — audit rows
  typically retained 10+ years per regulation, even if the
  underlying business data was retained 7 or purged sooner.

---

## Common Governance / Compliance Mistakes

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Mixed-classification satellite | RLS grants are all-or-nothing; erasure hits non-PII data | Split by classification tier first, cadence second |
| Erasing PII by literal DELETE without audit trail | Cannot prove compliance; regulator gap | Crypto-shred or explicit purge macro that logs to audit table |
| Purge macro accessible to any engineer | Uncontrolled destruction | Grant purge role separately; require ticket_id on every call |
| Retention rule embedded in vault SQL | Legal changes retention → vault must be rebuilt | Retention lives in metadata + purge scheduler, not in models |
| Legal hold enforced by "please don't touch" | Someone will touch it under pressure | Enforce in code — every erasure macro consults legal_holds registry |
| Same erasure strategy for every regime | GDPR RTBF and HIPAA "amend record" are different obligations | Regime-specific macros with regime-specific audit fields |
| Encrypting inside the satellite hashdiff | Ciphertext varies per key rotation → false-positive changes | Hashdiff over ciphertext is fine; hashdiff must never include the encryption key |
| No classification tag on new satellite columns | Downstream masking silently omits them | CI check that fails if a satellite column has no `classification` meta |
| Assuming Time Travel = compliance disaster recovery | Snowflake Time Travel keeps deleted data recoverable; regulator won't accept | Disable Time Travel on erasure-scoped tables OR erase via crypto-shred (ciphertext in Time Travel is still opaque) |
| Ignoring cross-region replicas | Erasure in primary doesn't propagate; secondary retains PII | Erasure macro replicates to every region OR uses shared-key crypto-shred |
| Purging hash keys along with PII | Referential integrity breaks; audit trail lost | Purge NEVER touches hash keys, load metadata, or hashdiff |
