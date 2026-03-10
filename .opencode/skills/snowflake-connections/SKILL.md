---
name: snowflake-connections
description:
  Configuring Snowflake connections using connections.toml (for Snowflake CLI, Streamlit, Snowpark)
  or profiles.yml (for dbt) with multiple authentication methods (SSO, key pair, username/password,
  OAuth), managing multiple environments, and overriding settings with environment variables. Use
  this skill when setting up Snowflake CLI, Streamlit apps, dbt, or any tool requiring Snowflake
  authentication and connection management.
tags: ["snowflake"]
---

# Snowflake Connections

Configure and manage Snowflake connections for CLI tools, Streamlit apps, dbt, and Snowpark
applications.

**Configuration Files:**

- **`connections.toml`** - Used by Snowflake CLI, Streamlit, and Snowpark
- **`profiles.yml`** - Used by dbt (different format, covered in dbt-core skill)

## When to Use This Skill

Activate this skill when users ask about:

- Setting up Snowflake connections for CLI, Streamlit, or Snowpark
- Configuring `connections.toml` file
- Authentication methods (SSO, key pair, username/password, OAuth)
- Managing multiple environments (dev, staging, prod)
- Overriding connection settings with environment variables
- Troubleshooting authentication or connection issues
- Rotating credentials or keys
- Setting up CI/CD authentication

**Note:** For dbt-specific connection setup using `profiles.yml`, see the **`dbt-core` skill**. The
concepts and authentication methods in this skill still apply, but dbt uses a different
configuration file format.

## Configuration File

**This skill covers `connections.toml`** used by Snowflake CLI, Streamlit, and Snowpark.

**For dbt:** Use `~/.dbt/profiles.yml` instead. See the **`dbt-core` skill** for dbt configuration.
The authentication methods described here apply to both files.

### Location

| OS           | Path                                        |
| ------------ | ------------------------------------------- |
| **Unix/Mac** | `~/.snowflake/connections.toml`             |
| **Windows**  | `%USERPROFILE%\.snowflake\connections.toml` |

### Basic Structure

```toml
[default]
account = "your_account"
user = "your_username"
warehouse = "COMPUTE_WH"
database = "MY_DB"
schema = "PUBLIC"
role = "MY_ROLE"

# Add authentication method (see below)
```

**Key Fields:**

- `account` - Snowflake account identifier (e.g., `xy12345.us-east-1`)
- `user` - Snowflake username
- `warehouse` - Default warehouse for queries
- `database` - Default database context
- `schema` - Default schema context
- `role` - Default role to use

---

## Authentication Methods

### Option 1: SSO/External Browser (Recommended for Development)

**Best for:** Organizations with SSO, interactive development

```toml
[default]
account = "your_account"
user = "your_username"
authenticator = "externalbrowser"
```

**How it works:** Opens browser for SSO authentication

**Pros:**

- ✅ Most secure for development
- ✅ Leverages existing SSO infrastructure
- ✅ No password storage required
- ✅ MFA support built-in

**Cons:**

- ❌ Requires browser access
- ❌ Not suitable for headless/CI environments

**Usage:**

```bash
# Browser opens automatically for authentication
streamlit run app.py
snow sql -c default -q "SELECT CURRENT_USER()"
```

---

### Option 2: Key Pair Authentication (Recommended for Production)

**Best for:** Production deployments, CI/CD pipelines, automation

```toml
[default]
account = "your_account"
user = "your_username"
authenticator = "snowflake_jwt"
private_key_path = "~/.ssh/snowflake_key.p8"
private_key_passphrase = "your_passphrase"  # Optional if key is encrypted
```

**Setup Steps:**

**1. Generate Key Pair:**

```bash
# Generate encrypted private key (recommended)
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out snowflake_key.p8

# Or unencrypted (less secure, but no passphrase needed)
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out snowflake_key.p8 -nocrypt

# Generate public key
openssl rsa -in snowflake_key.p8 -pubout -out snowflake_key.pub
```

**2. Extract Public Key (remove header/footer/newlines):**

```bash
# Remove header, footer, and newlines
cat snowflake_key.pub | grep -v "BEGIN PUBLIC" | grep -v "END PUBLIC" | tr -d '\n'
```

**3. Add Public Key to Snowflake:**

```sql
-- Set public key for user
ALTER USER your_username SET RSA_PUBLIC_KEY='MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...';

-- Verify
DESC USER your_username;
-- Check RSA_PUBLIC_KEY_FP field is populated
```

**4. Test Connection:**

```bash
snow sql -c default -q "SELECT CURRENT_USER()"
```

**Pros:**

- ✅ Very secure for production
- ✅ No password storage
- ✅ Ideal for CI/CD and automation
- ✅ Works in headless environments
- ✅ No interactive prompts

**Cons:**

- ❌ More complex initial setup
- ❌ Requires key management and rotation

**Security Best Practices:**

- Store private keys outside project directory
- Use encrypted keys with passphrases
- Rotate keys every 90 days
- Use different keys for different environments
- Never commit keys to version control

---

### Option 3: Username/Password (Development Only)

**Best for:** Quick testing, local development

```toml
[default]
account = "your_account"
user = "your_username"
password = "your_password"
```

**Pros:**

- ✅ Simple setup
- ✅ Works everywhere

**Cons:**

- ❌ Less secure (password in plain text)
- ❌ Not recommended for production
- ❌ MFA requires separate handling

**⚠️ WARNING:** Never use for production or commit `connections.toml` with passwords to git!

---

### Option 4: OAuth Token

**Best for:** OAuth-based integrations, programmatic access

```toml
[default]
account = "your_account"
authenticator = "oauth"
token = "your_oauth_token"
```

**Pros:**

- ✅ Supports OAuth workflows
- ✅ Token-based security

**Cons:**

- ❌ Requires token refresh logic
- ❌ Token expiration management

**Usage Pattern:**

```python
# Token needs to be refreshed before expiration
from snowflake.snowpark import Session
import os

session = Session.builder.configs({
    "account": "your_account",
    "authenticator": "oauth",
    "token": os.getenv("OAUTH_TOKEN")
}).create()
```

---

## Multiple Connections (Multi-Environment)

Define multiple connection profiles for different environments:

```toml
[default]
account = "dev_account"
user = "dev_user"
authenticator = "externalbrowser"
warehouse = "DEV_WH"
database = "DEV_DB"
schema = "PUBLIC"

[staging]
account = "staging_account"
user = "staging_user"
authenticator = "externalbrowser"
warehouse = "STAGING_WH"
database = "STAGING_DB"
schema = "PUBLIC"

[prod]
account = "prod_account"
user = "prod_user"
authenticator = "snowflake_jwt"
private_key_path = "~/.ssh/prod_key.p8"
warehouse = "PROD_WH"
database = "PROD_DB"
schema = "PUBLIC"
```

### Using Connection Profiles

**Snowflake CLI:**

```bash
# Use specific connection
snow sql -c default -q "SELECT CURRENT_DATABASE()"
snow sql -c staging -q "SELECT CURRENT_DATABASE()"
snow sql -c prod -q "SELECT CURRENT_DATABASE()"

# Deploy with specific connection
snow streamlit deploy -c prod
```

**Streamlit Apps:**

```python
import streamlit as st
from snowflake.snowpark import Session

# Allow user to select environment
env = st.selectbox("Environment", ["default", "staging", "prod"])
session = Session.builder.config("connection_name", env).create()
```

**dbt:**

```yaml
# profiles.yml
snowflake_demo:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: "{{ env_var('SNOWFLAKE_ACCOUNT') }}"
      # Uses connections.toml if not specified
    prod:
      type: snowflake
      account: "{{ env_var('SNOWFLAKE_PROD_ACCOUNT') }}"
```

---

## Environment Variable Overrides

Override connection settings without modifying `connections.toml`:

### Supported Variables

| Variable              | Purpose            | Example             |
| --------------------- | ------------------ | ------------------- |
| `SNOWFLAKE_ACCOUNT`   | Override account   | `xy12345.us-east-1` |
| `SNOWFLAKE_USER`      | Override user      | `john_doe`          |
| `SNOWFLAKE_PASSWORD`  | Override password  | `secret123`         |
| `SNOWFLAKE_DATABASE`  | Override database  | `ANALYTICS_DB`      |
| `SNOWFLAKE_SCHEMA`    | Override schema    | `REPORTING`         |
| `SNOWFLAKE_WAREHOUSE` | Override warehouse | `LARGE_WH`          |
| `SNOWFLAKE_ROLE`      | Override role      | `ANALYST`           |

### Usage Examples

**Command-Line Overrides:**

```bash
# Override database/schema
export SNOWFLAKE_DATABASE=ANALYTICS_DB
export SNOWFLAKE_SCHEMA=REPORTING
streamlit run app.py

# Override warehouse for heavy query
export SNOWFLAKE_WAREHOUSE=XLARGE_WH
snow sql -c default -f heavy_query.sql

# Multiple overrides
export SNOWFLAKE_DATABASE=PROD_DB
export SNOWFLAKE_SCHEMA=PUBLIC
export SNOWFLAKE_WAREHOUSE=COMPUTE_WH
dbt run
```

**Startup Script Pattern:**

```bash
#!/bin/bash
# run_dev.sh

# Set environment-specific variables
export SNOWFLAKE_DATABASE=DEV_DB
export SNOWFLAKE_SCHEMA=DEV_SCHEMA
export SNOWFLAKE_WAREHOUSE=DEV_WH

# Start application
streamlit run app.py
```

**Multi-Environment Scripts:**

```bash
#!/bin/bash
# run.sh
ENV="${1:-dev}"

case $ENV in
  dev)
    export SNOWFLAKE_DATABASE=DEV_DB
    export SNOWFLAKE_WAREHOUSE=DEV_WH
    ;;
  staging)
    export SNOWFLAKE_DATABASE=STAGING_DB
    export SNOWFLAKE_WAREHOUSE=STAGING_WH
    ;;
  prod)
    export SNOWFLAKE_DATABASE=PROD_DB
    export SNOWFLAKE_WAREHOUSE=PROD_WH
    ;;
esac

streamlit run app.py
```

Usage: `./run.sh prod`

---

## Connection Patterns for Different Tools

### Streamlit Apps

**Required pattern for local/Snowflake compatibility:**

```python
import streamlit as st
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark import Session

@st.cache_resource
def get_snowpark_session():
    """Get or create Snowpark session (cached)"""
    try:
        # When running in Snowflake (deployed)
        return get_active_session()
    except:
        # When running locally - uses connections.toml
        return Session.builder.config('connection_name', 'default').create()

session = get_snowpark_session()
```

**With environment selection:**

```python
@st.cache_resource
def get_snowpark_session(connection_name='default'):
    try:
        return get_active_session()
    except:
        return Session.builder.config('connection_name', connection_name).create()

# Allow user to select environment
env = st.selectbox("Environment", ["default", "staging", "prod"])
session = get_snowpark_session(env)
```

### Snowflake CLI

```bash
# Use default connection
snow sql -c default -q "SELECT CURRENT_USER()"

# Use specific connection profile
snow sql -c prod -q "SELECT CURRENT_DATABASE()"

# Test connection
snow connection test -c default
```

### dbt

**Important:** dbt uses `~/.dbt/profiles.yml` instead of `connections.toml`.

```yaml
# ~/.dbt/profiles.yml (NOT connections.toml)
my_project:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: "{{ env_var('SNOWFLAKE_ACCOUNT') }}"
      user: "{{ env_var('SNOWFLAKE_USER') }}"
      # Authentication method - choose one:
      authenticator: externalbrowser # SSO
      # OR
      private_key_path: ~/.ssh/snowflake_key.p8 # Key pair
      # OR
      password: "{{ env_var('SNOWFLAKE_PASSWORD') }}" # Username/password

      warehouse: COMPUTE_WH
      database: MY_DB
      schema: PUBLIC
```

**Note:** While dbt uses a different configuration file, the authentication methods and environment
variable patterns are the same. See the **`dbt-core` skill** for complete dbt configuration.

### Snowpark Scripts

```python
from snowflake.snowpark import Session

# Use connections.toml
session = Session.builder.config('connection_name', 'default').create()

# Or with explicit config
session = Session.builder.configs({
    "account": "your_account",
    "user": "your_user",
    "authenticator": "externalbrowser"
}).create()
```

---

## Best Practices

### ✅ DO

**Development:**

- Use **SSO/externalbrowser** for local development
- Use separate connection profiles for each environment
- Use startup scripts for consistent configuration
- Test connections before running applications: `snow connection test -c <profile>`

**Production:**

- Use **key pair authentication** for production and CI/CD
- Store private keys outside project directory (e.g., `~/.ssh/`)
- Use encrypted keys with passphrases
- Rotate keys every 90 days
- Use different keys for different environments

**Security:**

- Add `connections.toml` to `.gitignore`
- Never commit credentials or keys to version control
- Use least-privilege roles
- Enable MFA where possible
- Audit connection usage regularly

**Configuration:**

- Use environment variables for overrides
- Document connection requirements in README
- Provide connection templates (without credentials)
- Use connection profiles for multi-environment setups

### ❌ DON'T

- Commit `connections.toml` to git (add to `.gitignore`)
- Hardcode credentials in code
- Share private keys between team members
- Use production credentials for local development
- Store passwords in plain text for production
- Use same authentication method for all environments
- Skip testing connections before deployment

---

## Testing Connections

### Test Connection Profile

```bash
# Basic test
snow connection test -c default

# Test with query
snow sql -c default -q "SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_DATABASE()"

# Verbose test
snow connection test -c default --verbose
```

### Verify Environment Variables

```bash
# Check which variables are set
env | grep SNOWFLAKE_

# Test override
export SNOWFLAKE_DATABASE=TEST_DB
snow sql -c default -q "SELECT CURRENT_DATABASE()"
```

### Debug Connection Issues

Add debug info to your application:

**Streamlit:**

```python
st.write("Database:", session.get_current_database())
st.write("Schema:", session.get_current_schema())
st.write("Warehouse:", session.get_current_warehouse())
st.write("Role:", session.get_current_role())
```

**Python Script:**

```python
print(f"Account: {session.get_current_account()}")
print(f"User: {session.get_current_user()}")
print(f"Database: {session.get_current_database()}")
print(f"Schema: {session.get_current_schema()}")
print(f"Warehouse: {session.get_current_warehouse()}")
print(f"Role: {session.get_current_role()}")
```

---

## Troubleshooting

### Connection Failed

**Error:** `Could not connect to Snowflake` or `Connection timeout`

**Solutions:**

1. Verify `connections.toml` exists at correct location
2. Check account identifier format (e.g., `xy12345.us-east-1`)
3. Verify user has appropriate permissions
4. Check network connectivity/firewall
5. Test with: `snow connection test -c <profile>`

### SSO/External Browser Issues

**Error:** `External browser authentication failed`

**Solutions:**

1. Ensure browser is installed and accessible
2. Check firewall/proxy settings
3. Try clearing browser cookies for Snowflake
4. Verify SSO configuration in Snowflake
5. Check if user exists: `DESC USER your_username`

### Key Pair Authentication Failed

**Error:** `JWT token is invalid` or `Private key authentication failed`

**Solutions:**

1. Verify public key is set: `DESC USER your_username` (check `RSA_PUBLIC_KEY_FP`)
2. Ensure private key path is correct in `connections.toml`
3. Verify private key format is PKCS#8 (not PKCS#1)
4. Check passphrase is correct (if key is encrypted)
5. Regenerate and re-upload public key if needed

### Wrong Database/Schema/Warehouse

**Problem:** Application uses unexpected database/schema/warehouse

**Solutions:**

1. Check connection profile settings in `connections.toml`
2. Verify environment variables: `env | grep SNOWFLAKE_`
3. Check for application-level overrides
4. Use `USE DATABASE/SCHEMA/WAREHOUSE` statements if needed
5. Debug with current context queries (see Testing Connections above)

### Environment Variables Not Applied

**Problem:** Overrides don't take effect

**Solutions:**

1. Verify variables are exported: `env | grep SNOWFLAKE_`
2. Restart application after setting variables
3. Check if application caches session (clear cache if needed)
4. Ensure variable names are correct (case-sensitive)
5. Try setting variables inline: `SNOWFLAKE_DATABASE=MY_DB streamlit run app.py`

### Connection Profile Not Found

**Error:** `Connection 'profile_name' not found`

**Solutions:**

1. Check `~/.snowflake/connections.toml` exists
2. Verify profile name in file (case-sensitive)
3. Check TOML syntax is valid
4. List available connections: `snow connection list`

### Permission Denied

**Error:** `Insufficient privileges` or `Access denied`

**Solutions:**

1. Verify role has necessary grants
2. Check if role is specified in connection profile
3. Try with different role: `snow sql -c default --role ACCOUNTADMIN`
4. Review grants: `SHOW GRANTS TO USER your_username`

---

## Security Considerations

### Credential Storage

**Never store credentials in:**

- ❌ Application code
- ❌ Version control (git)
- ❌ Shared drives
- ❌ Documentation
- ❌ Environment files committed to git

**Safe storage locations:**

- ✅ `~/.snowflake/connections.toml` (with appropriate file permissions)
- ✅ Secure secret management systems (AWS Secrets Manager, HashiCorp Vault, etc.)
- ✅ CI/CD secret stores (GitHub Secrets, GitLab CI Variables, etc.)
- ✅ Environment variables (for temporary overrides)

### File Permissions

Restrict access to connection files:

```bash
# Set restrictive permissions (Unix/Mac)
chmod 600 ~/.snowflake/connections.toml

# Verify permissions
ls -la ~/.snowflake/connections.toml
# Should show: -rw------- (owner read/write only)
```

### Key Management

**For key pair authentication:**

1. Generate separate keys for each environment
2. Use encrypted keys with strong passphrases
3. Store keys in secure location (`~/.ssh/` with 600 permissions)
4. Rotate keys every 90 days
5. Revoke old keys after rotation
6. Document key rotation procedures

**Key rotation process:**

```bash
# 1. Generate new key pair
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out snowflake_key_new.p8

# 2. Extract public key
openssl rsa -in snowflake_key_new.p8 -pubout -out snowflake_key_new.pub

# 3. Add new public key to Snowflake (keeps old key)
ALTER USER your_username SET RSA_PUBLIC_KEY_2='NEW_PUBLIC_KEY';

# 4. Test new key
mv ~/.ssh/snowflake_key.p8 ~/.ssh/snowflake_key_old.p8
mv ~/.ssh/snowflake_key_new.p8 ~/.ssh/snowflake_key.p8
snow connection test -c default

# 5. Remove old key after verification
ALTER USER your_username UNSET RSA_PUBLIC_KEY;
```

---

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy to Snowflake

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Setup Snowflake connection
        run: |
          mkdir -p ~/.snowflake
          cat > ~/.snowflake/connections.toml <<EOF
          [default]
          account = "${{ secrets.SNOWFLAKE_ACCOUNT }}"
          user = "${{ secrets.SNOWFLAKE_USER }}"
          authenticator = "snowflake_jwt"
          private_key_path = "~/.ssh/snowflake_key.p8"
          warehouse = "PROD_WH"
          database = "PROD_DB"
          EOF

          echo "${{ secrets.SNOWFLAKE_PRIVATE_KEY }}" > ~/.ssh/snowflake_key.p8
          chmod 600 ~/.ssh/snowflake_key.p8

      - name: Deploy
        run: |
          snow streamlit deploy -c default
```

### GitLab CI

```yaml
# .gitlab-ci.yml
deploy:
  stage: deploy
  script:
    - mkdir -p ~/.snowflake
    - |
      cat > ~/.snowflake/connections.toml <<EOF
      [default]
      account = "${SNOWFLAKE_ACCOUNT}"
      user = "${SNOWFLAKE_USER}"
      authenticator = "snowflake_jwt"
      private_key_path = "~/.ssh/snowflake_key.p8"
      EOF
    - echo "${SNOWFLAKE_PRIVATE_KEY}" > ~/.ssh/snowflake_key.p8
    - chmod 600 ~/.ssh/snowflake_key.p8
    - snow streamlit deploy -c default
  only:
    - main
```

---

## Quick Reference

### Basic Setup

```toml
# ~/.snowflake/connections.toml

# SSO (Development)
[default]
account = "your_account"
user = "your_username"
authenticator = "externalbrowser"
warehouse = "COMPUTE_WH"
database = "MY_DB"
schema = "PUBLIC"

# Key Pair (Production)
[prod]
account = "prod_account"
user = "prod_user"
authenticator = "snowflake_jwt"
private_key_path = "~/.ssh/snowflake_key.p8"
warehouse = "PROD_WH"
database = "PROD_DB"
schema = "PUBLIC"
```

### Common Commands

```bash
# Test connection
snow connection test -c default

# List connections
snow connection list

# Use specific connection
snow sql -c prod -q "SELECT CURRENT_USER()"

# Override settings
export SNOWFLAKE_DATABASE=MY_DB
streamlit run app.py

# Generate key pair
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out snowflake_key.p8 -nocrypt
openssl rsa -in snowflake_key.p8 -pubout -out snowflake_key.pub
```

### Connection Pattern (Streamlit)

```python
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark import Session

@st.cache_resource
def get_snowpark_session():
    try:
        return get_active_session()  # Snowflake
    except:
        return Session.builder.config('connection_name', 'default').create()  # Local
```

---

## Related Skills

- `snowflake-cli` skill - Snowflake CLI operations and commands
- `streamlit-development` skill - Streamlit application development
- `dbt-core` skill - dbt project configuration using `profiles.yml` (dbt's configuration format)

---

**Goal:** Transform AI agents into experts at configuring and managing Snowflake connections
securely across all tools and environments, with proper authentication methods, multi-environment
support, and security best practices.
