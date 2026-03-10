"""Template code injected into Jupyter kernels.

Contains SQL helper functions and private key loaders for Snowflake auth.
"""

from string import Template

# --- SQL Helpers (injected into kernel after connection) ---

# ruff: noqa: F821
HELPERS_CODE = '''\
def run_sql(query: str, limit: int = 100):
    """Execute SQL and return Polars DataFrame."""
    cursor = _conn.cursor()
    try:
        cursor.execute(query)
        try:
            df = cursor.fetch_pandas_all()
            result = pl.from_pandas(df)
        except Exception:
            rows = cursor.fetchall()
            columns = (
                [desc[0] for desc in cursor.description] if cursor.description else []
            )
            result = pl.DataFrame(rows, schema=columns, orient="row")
        return result.head(limit) if limit > 0 and len(result) > limit else result
    finally:
        cursor.close()


def run_sql_pandas(query: str, limit: int = 100):
    """Execute SQL and return Pandas DataFrame."""
    cursor = _conn.cursor()
    try:
        cursor.execute(query)
        try:
            df = cursor.fetch_pandas_all()
        except Exception:
            rows = cursor.fetchall()
            columns = (
                [desc[0] for desc in cursor.description] if cursor.description else []
            )
            df = pd.DataFrame(rows, columns=columns)
        return df.head(limit) if limit > 0 and len(df) > limit else df
    finally:
        cursor.close()
'''

# --- Private Key Templates (for Snowflake auth) ---

PRIVATE_KEY_CONTENT_TEMPLATE = Template(
    """
def _load_private_key():
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization

    key_content = $KEY_CODE
    p_key = serialization.load_pem_private_key(
        key_content.encode(), password=$PASSPHRASE_CODE, backend=default_backend()
    )
    return p_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
"""
)

PRIVATE_KEY_FILE_TEMPLATE = Template(
    """
def _load_private_key():
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    from pathlib import Path

    with open(Path($KEY_PATH).expanduser(), "rb") as f:
        p_key = serialization.load_pem_private_key(
            f.read(), password=$PASSPHRASE_CODE, backend=default_backend()
        )
    return p_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
"""
)
