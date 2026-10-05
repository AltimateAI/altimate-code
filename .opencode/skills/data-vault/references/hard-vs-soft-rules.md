# Hard Rules vs. Soft Rules

This is the single most important architectural distinction in Data
Vault 2.0. Every transformation you apply to source data is either
a **hard rule** or a **soft rule**, and where a rule is allowed to
live depends entirely on which category it falls into.

Getting this wrong is what turns a "Data Vault" into a "table
warehouse with hash keys" — the vault stops being re-buildable and
auditability is lost.

## The Definitions (from the book)

### Hard Rule

A transformation that **does not change the meaning or grain of the
data, and does not lose information**. Reversible in principle.

Examples:
- **Type casting** — `CAST(amount AS DECIMAL(18,2))` from a string
  representation.
- **Character-set conversion** — Latin-1 → UTF-8.
- **String trimming for storage** (independent of hashing).
- **Splitting a compound field** by a known delimiter into multiple
  columns, when both sides are preserved.
- **Renaming to source-column standards** (e.g., resolving reserved
  words).
- **Hash key / hashdiff computation** — technical, deterministic,
  reversible from the business key.

Hard rules are **allowed in staging and the raw vault**. They must
not:
- Filter rows out.
- Deduplicate rows the source thinks are distinct.
- Coalesce NULLs to real values (that's interpretive).
- Choose between multiple candidate values.
- Apply any business judgment.

### Soft Rule

A transformation that **encodes a business interpretation, discards
information, or requires a judgment call**. Not reversible in the
general case.

Examples:
- **Filtering out `is_test = TRUE` rows** — the vault loses those
  rows forever.
- **Deduplicating "logically equivalent" customers** across systems.
- **Coalescing** `COALESCE(preferred_email, work_email, personal_email)` —
  business chose which fallback to prefer.
- **Currency conversion** — the rate is chosen from a specific source
  at a specific point in time.
- **Segment / tier / status derivation** — "customers who spent >$1000
  are PLATINUM" is a business rule.
- **Filling missing values** with defaults.
- **Anti-junk filtering** — "if `country_code` isn't in the ISO list,
  set to NULL".
- **Any transformation involving human-defined thresholds**.

Soft rules are **forbidden in staging and the raw vault**. They must
live in the **business vault** or **information mart** only.

## Why This Matters

The raw vault's contract is: **given the source data at any point in
time, we can reconstruct the raw vault byte-for-byte**. This is what
enables:

- **Audit questions.** "Show me every customer, including test
  accounts, who existed on 2024-06-01."
- **Rule replay.** "What would our LTV metric look like if we changed
  the definition?" — replay the soft rule against the raw vault,
  don't reload from source.
- **Regulatory compliance.** GDPR, HIPAA, and SOX all require you to
  answer questions about historical source state, not your
  interpretation of it.
- **Rebuilding after a bug.** The bug was in a soft rule → rebuild
  the mart from vault. The bug was in a hard rule → the vault
  itself is contaminated and you need source re-ingestion. Keep
  hard rules narrow so this rarely happens.

If soft rules leak into the raw vault, you lose all of the above.
Even one filter (`WHERE is_active = TRUE`) is enough to invalidate
the audit contract for the affected key.

## The Test — Is It Hard or Soft?

Ask three questions:

1. **Can it be reversed?** If given the transformed output, can I
   reconstruct the input? If no → soft.
2. **Does a business person need to define it?** If yes → soft.
3. **Does it choose between multiple values or discard any?** If
   yes → soft.

If all three answer "no", it's a hard rule.

**Examples applied:**

| Transformation | Reversible? | Business-defined? | Discards? | Verdict |
|----------------|-------------|-------------------|-----------|---------|
| `TRIM(x)` | Nearly (loses whitespace at edges only) | No | Minimal | **Hard** |
| `UPPER(x)` for hashing | Not fully | No — technical convention | Case | **Hard** — but store original in column, hash the upper |
| `COALESCE(x, 'UNKNOWN')` for display | Info-losing | Yes | Yes | **Soft** |
| `WHERE status = 'ACTIVE'` | No | Yes | Yes | **Soft** |
| `amount / 100.0` (cents → dollars) | Yes | No | No | **Hard** |
| `amount * exchange_rate` (currency conv) | Only with the rate stored | Yes | No | **Soft** |
| `MD5_BINARY(bk)` | Not really (one-way hash) | No | No | **Hard** — technical, deterministic |
| Splitting `full_name` into `first_name`, `last_name` on space | Sometimes | Yes (choice of delimiter, handling middle names) | Yes | **Soft** — surprising, but the rule "always split on first space" is a business call |

The `full_name` example is a common trap. Splitting looks technical
but embeds a business interpretation ("first token is the first
name"). Keep `full_name` as-is in the vault; split in the mart.

## Consequences in Practice

### Where each type of rule lives

```
source
  │
  ▼
staging (Stage 1)              ← hard rules only: type casting
  │                              character conversion
  ▼
staging (Stage 2, hashed)      ← hard rules only: hash computation
  │                              add load metadata
  ▼
raw vault                      ← no rules; just insert
  │
  ▼
business vault                 ← soft rules: computed sats, derived
  │                              entities, cross-source coalesce
  ▼
information mart               ← soft rules: filters, aggregations,
                                 display formatting, business labels
```

### Filtering example — the right way

**Wrong** (soft rule in raw vault):
```sql
-- hub_customer.sql — DON'T DO THIS
SELECT customer_id, ...
FROM {{ ref('stg_crm__customers__hashed') }}
WHERE is_test = FALSE                          -- soft rule leaks into vault
  AND status <> 'DELETED'                      -- another soft rule
```

**Right** (raw vault sees everything, mart filters):
```sql
-- hub_customer.sql — vault loads every customer, no interpretation
SELECT customer_id, ...
FROM {{ ref('stg_crm__customers__hashed') }}
WHERE customer_id IS NOT NULL                  -- hard rule: NULL PK can't hash

-- dim_customer.sql (mart) — the interpretive layer
SELECT ...
FROM {{ ref('hub_customer') }} h
LEFT JOIN {{ ref('sat_customer_details') }} s ...
WHERE s.is_test = FALSE
  AND s.status <> 'DELETED'
```

Both `is_test = TRUE` customers and deleted customers still exist in
the vault. A future audit query can find them. A future mart with
different filtering can be built.

### Coalesce example — the right way

**Wrong** (COALESCE in staging):
```sql
-- Wrong: staging chooses a preferred email — soft rule
COALESCE(work_email, personal_email, backup_email) AS email
```

**Right** (all three preserved in vault; mart coalesces):
```sql
-- Staging / vault: preserve every source column
work_email,
personal_email,
backup_email

-- Mart: apply the business preference
COALESCE(work_email, personal_email, backup_email) AS email
```

Business changes their mind about preference order? Change the mart.
Vault doesn't move.

### Handling NULLs — hard boundary

- **NULL business key** → filter in staging (hard rule: NULL can't be
  hashed).
- **NULL descriptive column** → let it flow. NULL is data. Every
  satellite must handle NULL in its columns (they'll appear in the
  hashdiff sentinel-coalesced, but the original NULL is stored).
- **NULL in a foreign key on a link** → depends on business meaning.
  If NULL means "not applicable", route to ghost row via link
  loader (see [zero-keys-and-ghost.md](zero-keys-and-ghost.md)). If
  NULL is a data quality issue, load the link row anyway and log to
  error mart (see [metrics-and-error-vault.md](metrics-and-error-vault.md)).

## The Two Exceptions

### 1. "Soft rules with a hard-rule test"

Occasionally a rule *feels* soft but has no interpretive component:
splitting an ISO 8601 timestamp string into its date and time parts,
for example. If you can point at a formal spec that eliminates
judgment, it's a hard rule.

Rule of thumb: if you had to write documentation explaining the
choice, it's soft. If the choice is dictated by an external standard
(ISO, RFC, HL7, SWIFT), it's hard.

### 2. "Structural soft rules" in business vault

Some transformations are unambiguously interpretive but so common
they get their own class of business vault object:

- **Same-as links** — "these two customer IDs are the same person"
  is a soft rule, but it lives in `lnk_same_as_customer` (raw or
  business vault) instead of being applied inline.
- **Master-record satellites** — "here's the golden email for this
  customer" is a soft rule, but as a satellite it's re-runnable and
  historized.

The soft rule is still applied in the business vault; the *result*
is stored with the same insert-only + hashdiff discipline as raw
vault, so future consumers can trust it.

## Checklist Before Every Vault Load

Before merging a new hub / link / sat / staging model, walk this list:

- [ ] Does the model apply any `WHERE` clause that removes rows for
      business reasons? → Move that filter to the mart.
- [ ] Does the model apply `COALESCE` / `CASE WHEN` to *choose
      between values* (as opposed to sentinel-coalesce for hashing)?
      → Move to business vault or mart.
- [ ] Does the model rename a column to something more
      business-friendly? → Preserve the source name in staging;
      rename in mart.
- [ ] Does the model join to a lookup table for enrichment? → Move
      to mart, or model the lookup as a reference table + link.
- [ ] Does the model deduplicate for reasons other than "same
      business key appears twice in the same feed"? → Soft rule;
      move to business vault.
- [ ] Are you filtering NULLs? → Only if the NULL is on the
      *business key* itself (can't hash NULL).

If any answer is yes and the model is in staging or raw vault, the
rule is misplaced.

## Common Hard/Soft Mistakes

| Mistake | Category | Consequence | Fix |
|---------|----------|-------------|-----|
| `WHERE is_test = FALSE` in staging | Soft rule in wrong layer | Vault can't audit test data | Filter in mart |
| `COALESCE(email, 'unknown@example.com')` in staging | Soft rule | Real-vs-fake email distinction lost | Preserve NULL; coalesce in mart |
| `TRIM(TRAILING FROM x)` for storage | Hard rule | Fine — reversible | (No fix; it's hard) |
| Splitting `full_name` into first/last in staging | Soft rule masquerading as hard | Wrong split for middle names / suffixes; not re-doable | Preserve `full_name`; split in mart |
| `WHERE created_at > '2020-01-01'` in staging | Soft rule (arbitrary cutoff) | Historical rows lost | Filter in mart |
| Currency conversion in raw-vault satellite | Soft rule | Rate choice frozen; can't replay against new rates | Store native-currency values in vault; convert in mart or business vault |
| Deduplicating "logically equivalent" customer names | Soft rule | Real dupes and near-dupes lost distinction | Same-as link in business vault |
| Category / tier derivation in raw vault | Soft rule | Business changes the tier definition → vault is wrong | Business vault computed satellite |
| Dropping columns you "don't need" in staging | Info loss | Future use case needs them; can't recover | Load every source column; drop in mart if needed |
| Standardizing address format in staging | Soft rule (choice of standard) | Original format lost | Preserve source address; standardize in mart |
