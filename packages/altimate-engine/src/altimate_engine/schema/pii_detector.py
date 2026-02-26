"""PII detection — identify columns likely to contain personally identifiable information."""

from __future__ import annotations

import re
from altimate_engine.schema.cache import SchemaCache

# PII patterns: (regex for column name, PII category, base confidence)
_PII_PATTERNS = [
    # Direct identifiers
    (r"\b(ssn|social_security|sin_number)\b", "SSN", "high"),
    (r"\b(passport|passport_number|passport_no)\b", "PASSPORT", "high"),
    (r"\b(drivers?_?license|dl_number)\b", "DRIVERS_LICENSE", "high"),
    (r"\b(national_id|national_identification)\b", "NATIONAL_ID", "high"),
    (r"\b(tax_id|tin|tax_identification)\b", "TAX_ID", "high"),

    # Contact info
    (r"\b(email|email_address|e_mail)\b", "EMAIL", "high"),
    (r"\b(phone|phone_number|mobile|cell|telephone|fax)\b", "PHONE", "high"),
    (r"\b(address|street|street_address|mailing_address|home_address)\b", "ADDRESS", "high"),
    (r"\b(zip|zip_code|postal|postal_code)\b", "POSTAL_CODE", "medium"),
    (r"\b(city|town)\b", "LOCATION", "low"),
    (r"\b(state|province|region)\b", "LOCATION", "low"),
    (r"\b(country)\b", "LOCATION", "low"),

    # Names
    (r"\b(first_name|firstname|given_name|fname)\b", "PERSON_NAME", "high"),
    (r"\b(last_name|lastname|surname|family_name|lname)\b", "PERSON_NAME", "high"),
    (r"\b(full_name|display_name|legal_name)\b", "PERSON_NAME", "medium"),
    (r"\b(middle_name|maiden_name)\b", "PERSON_NAME", "high"),

    # Financial
    (r"\b(credit_card|card_number|cc_number|pan)\b", "CREDIT_CARD", "high"),
    (r"\b(bank_account|account_number|iban|routing_number)\b", "BANK_ACCOUNT", "high"),
    (r"\b(salary|compensation|wage|income)\b", "FINANCIAL", "medium"),

    # Dates
    (r"\b(date_of_birth|dob|birth_date|birthday)\b", "DATE_OF_BIRTH", "high"),
    (r"\b(birth_year|age)\b", "AGE", "medium"),

    # Auth / Credentials
    (r"\b(password|passwd|pwd|secret|token|api_key|access_key)\b", "CREDENTIAL", "high"),
    (r"\b(ip_address|ip|client_ip|remote_ip|source_ip)\b", "IP_ADDRESS", "high"),
    (r"\b(mac_address)\b", "MAC_ADDRESS", "high"),
    (r"\b(user_agent|browser)\b", "DEVICE_INFO", "medium"),

    # Health
    (r"\b(diagnosis|medical|health|prescription|medication)\b", "HEALTH", "medium"),
    (r"\b(blood_type|allergy|condition)\b", "HEALTH", "medium"),

    # Biometric
    (r"\b(fingerprint|face_id|retina|biometric)\b", "BIOMETRIC", "high"),

    # Other
    (r"\b(gender|sex|race|ethnicity|religion|nationality)\b", "DEMOGRAPHIC", "medium"),
    (r"\b(lat|latitude|lon|longitude|geo|coordinates)\b", "GEOLOCATION", "medium"),
]

# Suffixes that indicate the column is metadata ABOUT the PII field, not PII itself.
# e.g. "email_sent_count", "phone_validated_at", "address_type"
_FALSE_POSITIVE_SUFFIXES = re.compile(
    r"_(count|cnt|flag|status|type|format|length|len|hash|hashed|"
    r"encrypted|masked|valid|validated|validation|verified|verification|"
    r"enabled|disabled|sent|received|updated|created|deleted|"
    r"at|date|timestamp|ts|time|source|method|provider|"
    r"preference|setting|config|mode|template|label|category|"
    r"index|idx|seq|order|rank|score|rating|level)$",
    re.IGNORECASE,
)

# Prefixes that indicate metadata rather than PII
_FALSE_POSITIVE_PREFIXES = re.compile(
    r"^(is_|has_|num_|total_|max_|min_|avg_|count_|n_|default_)",
    re.IGNORECASE,
)

# Data types that are NOT plausible for text-based PII (names, emails, etc.)
_NON_TEXT_TYPES = frozenset({
    "BOOLEAN", "BOOL",
    "INTEGER", "INT", "BIGINT", "SMALLINT", "TINYINT",
    "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC", "NUMBER", "REAL",
    "DATE", "DATETIME", "TIMESTAMP", "TIMESTAMP_NTZ", "TIMESTAMP_LTZ", "TIMESTAMP_TZ",
    "TIME",
    "BINARY", "VARBINARY", "BYTEA",
    "ARRAY", "OBJECT", "VARIANT", "MAP",
})

# PII categories that inherently store text values — these should have text-compatible types
_TEXT_PII_CATEGORIES = frozenset({
    "SSN", "PASSPORT", "DRIVERS_LICENSE", "NATIONAL_ID", "TAX_ID",
    "EMAIL", "PHONE", "ADDRESS", "POSTAL_CODE",
    "PERSON_NAME", "CREDIT_CARD", "BANK_ACCOUNT",
    "CREDENTIAL", "IP_ADDRESS", "MAC_ADDRESS",
})

# Confidence downgrade mapping: if data type doesn't match, reduce confidence
_CONFIDENCE_DOWNGRADE = {"high": "medium", "medium": "low", "low": "low"}


def detect_pii(
    warehouse: str | None = None,
    schema_name: str | None = None,
    table: str | None = None,
    cache: SchemaCache | None = None,
) -> dict:
    """Scan columns for potential PII based on name patterns and data type validation.

    Uses a two-pass approach:
    1. Match column names against 30+ PII regex patterns
    2. Filter false positives using suffix/prefix heuristics and data type checks

    Args:
        warehouse: Limit scan to a specific warehouse
        schema_name: Limit scan to a specific schema
        table: Limit scan to a specific table
        cache: SchemaCache instance (uses default if not provided)

    Returns:
        Dict with PII findings grouped by category and table.
    """
    if cache is None:
        cache = SchemaCache()

    conn = cache._conn

    # Build query to fetch columns
    conditions = []
    params = []

    if warehouse:
        conditions.append("warehouse = ?")
        params.append(warehouse)
    if schema_name:
        conditions.append("schema_name = ?")
        params.append(schema_name)
    if table:
        conditions.append("table_name = ?")
        params.append(table)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    rows = conn.execute(
        f"SELECT warehouse, schema_name, table_name, column_name, data_type FROM columns_cache {where}",
        params,
    ).fetchall()

    findings = []
    by_category: dict[str, int] = {}
    by_table: dict[str, list[dict]] = {}

    for row in rows:
        col_name = row["column_name"].lower()
        matches = _check_column_pii(col_name, row["data_type"])

        for match in matches:
            finding = {
                "warehouse": row["warehouse"],
                "schema": row["schema_name"],
                "table": row["table_name"],
                "column": row["column_name"],
                "data_type": row["data_type"],
                "pii_category": match["category"],
                "confidence": match["confidence"],
            }
            findings.append(finding)

            by_category[match["category"]] = by_category.get(match["category"], 0) + 1

            table_key = f"{row['warehouse']}.{row['schema_name']}.{row['table_name']}"
            by_table.setdefault(table_key, []).append(finding)

    return {
        "success": True,
        "findings": findings,
        "finding_count": len(findings),
        "columns_scanned": len(rows),
        "by_category": by_category,
        "tables_with_pii": len(by_table),
    }


def _check_column_pii(col_name: str, data_type: str | None) -> list[dict]:
    """Check a column name against PII patterns with false-positive filtering.

    Three-step process:
    1. Match against PII regex patterns
    2. Filter out false positives (metadata suffixes/prefixes)
    3. Adjust confidence based on data type compatibility
    """
    # Step 1: Check for false-positive indicators before pattern matching.
    # If the column looks like metadata about a PII field, skip it entirely
    # for high-confidence patterns, but still flag with reduced confidence.
    is_metadata = bool(
        _FALSE_POSITIVE_SUFFIXES.search(col_name)
        or _FALSE_POSITIVE_PREFIXES.match(col_name)
    )

    # Determine base data type (strip precision/length: "VARCHAR(100)" → "VARCHAR")
    base_type = _normalize_type(data_type) if data_type else None

    matches = []
    for pattern, category, base_confidence in _PII_PATTERNS:
        if not re.search(pattern, col_name, re.IGNORECASE):
            continue

        confidence = base_confidence

        # Step 2: Downgrade metadata-looking columns
        if is_metadata:
            confidence = _CONFIDENCE_DOWNGRADE.get(confidence, "low")

        # Step 3: Check data type compatibility for text-based PII categories
        if base_type and category in _TEXT_PII_CATEGORIES:
            if base_type in _NON_TEXT_TYPES:
                # A column named "email" with type INTEGER is unlikely to be PII
                confidence = _CONFIDENCE_DOWNGRADE.get(confidence, "low")

        # Only include if confidence isn't completely degraded for metadata columns
        # (skip "low" confidence metadata hits to reduce noise)
        if is_metadata and confidence == "low":
            continue

        matches.append({"category": category, "confidence": confidence})
    return matches


def _normalize_type(data_type: str) -> str:
    """Normalize a data type string: strip precision, parentheses, uppercase."""
    t = data_type.upper().strip()
    # Remove parenthesized precision: VARCHAR(100) → VARCHAR
    paren = t.find("(")
    if paren != -1:
        t = t[:paren].strip()
    return t
