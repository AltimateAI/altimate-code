"""PII detection — identify columns likely to contain personally identifiable information."""

from __future__ import annotations

import re
from altimate_engine.schema.cache import SchemaCache

# PII patterns: (regex for column name, PII category, confidence)
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
    (r"\b(full_name|name|display_name|legal_name)\b", "PERSON_NAME", "medium"),
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

# Data type patterns that increase PII likelihood
_TYPE_INDICATORS = {
    "VARCHAR": 0.1,
    "STRING": 0.1,
    "TEXT": 0.1,
    "CHAR": 0.1,
}


def detect_pii(
    warehouse: str | None = None,
    schema_name: str | None = None,
    table: str | None = None,
    cache: SchemaCache | None = None,
) -> dict:
    """Scan columns for potential PII based on name patterns.

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
    """Check a column name against PII patterns."""
    matches = []
    for pattern, category, confidence in _PII_PATTERNS:
        if re.search(pattern, col_name, re.IGNORECASE):
            matches.append({"category": category, "confidence": confidence})
    return matches
