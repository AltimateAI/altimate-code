# Advanced Features

Optional sections the skill emits when specific opt-in questions are answered. Each has its own trigger question and can be enabled independently.

## Network Security and SSO

### Trigger questions
- "Restrict Snowflake access to specific IP ranges?" (VPN, office, cloud VPC)
- "Federate authentication via Okta / Azure AD / Google Workspace?"

### Account-level network policy

```sql
USE ROLE SECURITYADMIN;

CREATE NETWORK POLICY office_and_vpn
  ALLOWED_IP_LIST = ('203.0.113.0/24', '198.51.100.5/32', '10.100.0.0/16')
  BLOCKED_IP_LIST = ()
  COMMENT = 'Corporate office + VPN ranges';

-- Apply to entire account (default policy)
ALTER ACCOUNT SET NETWORK_POLICY = office_and_vpn;

-- Or apply per-user (overrides account default)
ALTER USER alice SET NETWORK_POLICY = office_and_vpn;

-- Service accounts often need a different policy (CI runner IPs)
CREATE NETWORK POLICY ci_runners
  ALLOWED_IP_LIST = ('52.0.0.0/8', '54.0.0.0/8');  -- GitHub-hosted runners; tighten in production
ALTER USER dbt_service SET NETWORK_POLICY = ci_runners;
```

### Key-pair auth for service accounts

Password auth for service accounts is a critical audit finding. Generate a keypair:

```bash
# Generate encrypted private key (recommended)
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out fivetran_loader.p8 -v2 aes-256-cbc
# Extract the public key
openssl rsa -in fivetran_loader.p8 -pubout -out fivetran_loader.pub
# Strip PEM headers for Snowflake ALTER USER
cat fivetran_loader.pub | grep -v -- ----- | tr -d '\n'
```

```sql
ALTER USER fivetran_loader SET RSA_PUBLIC_KEY = '<PUBLIC_KEY_BODY_HERE>';
-- Rotate by setting RSA_PUBLIC_KEY_2, then swapping later
```

### SCIM provisioning (Okta / Azure AD)

```sql
USE ROLE ACCOUNTADMIN;

-- Enable SCIM
CREATE SECURITY INTEGRATION okta_scim
  TYPE = SCIM
  SCIM_CLIENT = 'OKTA'
  RUN_AS_ROLE = 'OKTA_PROVISIONER';

-- Custom role SCIM provisioner runs as (least privilege)
CREATE ROLE OKTA_PROVISIONER;
GRANT CREATE USER, CREATE ROLE ON ACCOUNT TO ROLE OKTA_PROVISIONER;
GRANT ROLE OKTA_PROVISIONER TO ROLE ACCOUNTADMIN;

-- Retrieve SCIM auth token — paste this into Okta's SCIM app config
SELECT SYSTEM$GENERATE_SCIM_ACCESS_TOKEN('OKTA_SCIM');
```

### SAML SSO

```sql
CREATE SECURITY INTEGRATION okta_saml
  TYPE = SAML2
  ENABLED = TRUE
  SAML2_ISSUER = 'http://www.okta.com/<okta-issuer-id>'
  SAML2_SSO_URL = 'https://<org>.okta.com/app/<app-id>/sso/saml'
  SAML2_PROVIDER = 'OKTA'
  SAML2_X509_CERT = '<cert-body>'
  SAML2_SP_INITIATED_LOGIN_PAGE_LABEL = 'Okta'
  SAML2_ENABLE_SP_INITIATED = TRUE;

-- Force SSO for all human users (block password login)
ALTER ACCOUNT SET SSO_LOGIN_PAGE = TRUE;
```

### MFA enforcement

```sql
-- Enforce Duo MFA for password-auth users
ALTER USER alice SET MINS_TO_BYPASS_MFA = 0;
-- SET DISABLE_MFA = FALSE for all users
```

## Disaster Recovery (Replication + Failover)

### Trigger question
- "Set up cross-region replication for disaster recovery?"

### Replication group (data-only, no automatic failover)

```sql
USE ROLE ACCOUNTADMIN;

-- On source account (primary region)
CREATE REPLICATION GROUP prod_replication
  OBJECT_TYPES = DATABASES, SHARES, ROLES, WAREHOUSES, RESOURCE MONITORS, INTEGRATIONS, NETWORK POLICIES
  ALLOWED_DATABASES = RAW, TRANSFORM, ANALYTICS
  ALLOWED_SHARES = ()
  ALLOWED_ACCOUNTS = <org_name>.<secondary_account_locator>
  REPLICATION_SCHEDULE = '60 MINUTE';

-- On target account (secondary region)
CREATE REPLICATION GROUP prod_replication_secondary
  AS REPLICA OF <org_name>.<primary_account>.prod_replication;

-- Trigger initial replication
ALTER REPLICATION GROUP prod_replication_secondary REFRESH;
```

### Failover group (automatic failover with client redirect)

```sql
-- Failover groups replicate AND enable failover — clients use a Connection URL
CREATE FAILOVER GROUP prod_failover
  OBJECT_TYPES = DATABASES, SHARES, ROLES, WAREHOUSES, RESOURCE MONITORS, INTEGRATIONS, NETWORK POLICIES
  ALLOWED_DATABASES = RAW, TRANSFORM, ANALYTICS
  ALLOWED_ACCOUNTS = <org_name>.<secondary_account>
  REPLICATION_SCHEDULE = '15 MINUTE';

-- Client connection URL that survives failover
CREATE CONNECTION prod_connection
  AS PRIMARY OF <org_name>.<primary_account>.prod_failover;

-- Manually failover to secondary (or automate via monitoring)
ALTER FAILOVER GROUP prod_failover PRIMARY;  -- on secondary account
ALTER CONNECTION prod_connection PRIMARY;    -- redirect clients
```

### DR monitoring

```sql
-- Replication lag
SELECT phase, start_time, end_time, DATEDIFF('second', start_time, end_time) AS duration_s,
       total_bytes / POWER(1024, 3) AS gb_replicated
FROM TABLE(INFORMATION_SCHEMA.REPLICATION_GROUP_REFRESH_HISTORY('prod_replication'))
ORDER BY start_time DESC LIMIT 20;

-- Estimated RPO (recovery point objective) = max age of last successful refresh
SELECT DATEDIFF('minute', MAX(end_time), CURRENT_TIMESTAMP()) AS minutes_since_last_sync
FROM TABLE(INFORMATION_SCHEMA.REPLICATION_GROUP_REFRESH_HISTORY('prod_replication'))
WHERE phase = 'COMPLETED';
```

## Data Sharing

### Trigger question
- "Share data with external consumers (Snowflake or reader accounts)?"

### Outbound share to another Snowflake account

```sql
USE ROLE ACCOUNTADMIN;

CREATE SHARE finance_metrics_share
  COMMENT = 'Monthly finance dashboards for parent-company data team';

-- Grant objects to the share
GRANT USAGE ON DATABASE ANALYTICS TO SHARE finance_metrics_share;
GRANT USAGE ON SCHEMA ANALYTICS.FINANCE TO SHARE finance_metrics_share;
GRANT SELECT ON ALL TABLES IN SCHEMA ANALYTICS.FINANCE TO SHARE finance_metrics_share;
GRANT SELECT ON FUTURE TABLES IN SCHEMA ANALYTICS.FINANCE TO SHARE finance_metrics_share;

-- Add consumer accounts (must be in same region + cloud, or cross-region-enabled)
ALTER SHARE finance_metrics_share ADD ACCOUNTS = <consumer_org>.<consumer_account>;

-- Consumer side: consume the share as a read-only database
CREATE DATABASE finance_metrics_from_provider FROM SHARE <provider_org>.<provider_account>.finance_metrics_share;
```

### Reader account (for consumers without Snowflake)

```sql
-- Provider creates the reader account (billed to provider)
CREATE MANAGED ACCOUNT client_x_reader
  ADMIN_NAME = client_x_admin
  ADMIN_PASSWORD = '<initial-password>'
  TYPE = READER
  COMMENT = 'Read-only account for Client X';

-- Add the reader account to the share
ALTER SHARE finance_metrics_share ADD ACCOUNTS = <provider_account>.client_x_reader;
```

### Secure views for shared data

Never share raw tables directly — always use secure views to control column exposure.

```sql
CREATE SECURE VIEW ANALYTICS.FINANCE.monthly_revenue_share AS
SELECT
  DATE_TRUNC('month', order_date) AS month,
  region,
  SUM(revenue)                    AS total_revenue
  -- customer_id and email intentionally excluded from share
FROM ANALYTICS.FINANCE.fact_orders
GROUP BY 1, 2;

GRANT SELECT ON VIEW ANALYTICS.FINANCE.monthly_revenue_share TO SHARE finance_metrics_share;
```

## Snowflake Cortex / ML

### Trigger question
- "Enable Snowflake Cortex for LLM functions or Cortex Search?"

### Cortex functions warehouse

```sql
USE ROLE ACCOUNTADMIN;

-- Cortex functions run on a regular warehouse but benefit from Snowpark-optimized instances
CREATE WAREHOUSE CORTEX_WH
  WAREHOUSE_SIZE = 'MEDIUM'
  WAREHOUSE_TYPE = 'SNOWPARK-OPTIMIZED'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  COMMENT = 'Cortex LLM and ML functions';

-- Grant usage to roles that will call Cortex functions
GRANT USAGE ON WAREHOUSE CORTEX_WH TO ROLE ANALYST_ROLE;

-- The account-level parameter enables Cortex features
-- (already true by default in most regions; check first)
SHOW PARAMETERS LIKE 'CORTEX_ENABLED_CROSS_REGION' IN ACCOUNT;
```

### Cortex Search service (for RAG applications)

```sql
CREATE CORTEX SEARCH SERVICE support_docs_search
  ON content
  ATTRIBUTES doc_id, title, url, updated_at
  WAREHOUSE = CORTEX_WH
  TARGET_LAG = '1 hour'
  AS (
    SELECT doc_id, title, url, content, updated_at
    FROM ANALYTICS.SUPPORT.help_articles
  );

-- Query the service from an application
SELECT PARSE_JSON(
  SNOWFLAKE.CORTEX.SEARCH_PREVIEW(
    'ANALYTICS.SUPPORT.support_docs_search',
    '{ "query": "how to reset password", "limit": 5 }'
  )
):results;
```

### Cortex LLM function grants

```sql
-- Cortex functions live in SNOWFLAKE.CORTEX schema
GRANT USAGE ON DATABASE SNOWFLAKE TO ROLE ANALYST_ROLE;
GRANT USAGE ON SCHEMA SNOWFLAKE.CORTEX TO ROLE ANALYST_ROLE;
-- Functions are already granted USAGE to PUBLIC by default
```

### Cortex usage governance

```sql
-- Track Cortex spend
SELECT
  DATE_TRUNC('day', start_time) AS day,
  function_name,
  SUM(token_credits) AS credits
FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_FUNCTIONS_USAGE_HISTORY
WHERE start_time >= DATEADD('day', -30, CURRENT_TIMESTAMP())
GROUP BY 1, 2
ORDER BY day DESC, credits DESC;
```

## Cost Forecasting

### Trigger question
- Automatic when a monthly credit budget is not provided, or user opts in for a tailored budget

### Forecast inputs

The skill collects:
- Expected data volume ingested per day (GB)
- Expected number of dbt models
- Expected concurrent BI users
- Expected ad-hoc analyst sessions per week

### Forecast formulas

```
LOADING_WH credits/month
  ≈ (daily_gb × 30) / <load_throughput_gb_per_credit>
  where load_throughput ≈ 100 GB/credit on XS/S warehouses

TRANSFORM_WH credits/month
  ≈ (dbt_models × avg_runtime_minutes × runs_per_day × 30) / 60
  where avg_runtime_minutes defaults to 2 (SMALL wh, ~10 rows/sec)

ANALYTICS_WH credits/month
  ≈ (concurrent_users × active_hours_per_day × 30) × warehouse_size_credits_per_hour
  where MEDIUM = 4 credits/hour
```

### Budget output

```
Estimated monthly credits (500 GB/day, 200 dbt models, 15 BI users):
  LOADING_WH:    150 credits  → $450 at $3/credit
  TRANSFORM_WH:  200 credits  → $600
  ANALYTICS_WH:  300 credits  → $900
  DEV_WH:         50 credits  → $150
  Buffer (20%):  140 credits  → $420
  ─────────────────────────────
  Total budget:  840 credits  → $2,520/month

Resource monitor recommendations:
  Account-level:  840 credits (100% suspend, 75%/90% notify)
  TRANSFORM_WH:   240 credits (20% headroom over forecast)
  ANALYTICS_WH:   360 credits
  LOADING_WH:     180 credits
```

### Forecast validation

After 30 days, re-run the audit and compare actual to forecast:

```sql
-- Actual vs. forecast (feed forecast values as literals)
SELECT
  warehouse_name,
  SUM(credits_used) AS actual_credits,
  CASE warehouse_name
    WHEN 'LOADING_WH'   THEN 150
    WHEN 'TRANSFORM_WH' THEN 200
    WHEN 'ANALYTICS_WH' THEN 300
    WHEN 'DEV_WH'       THEN 50
  END AS forecast_credits,
  ROUND(SUM(credits_used) / NULLIF(forecast_credits, 0) * 100, 1) AS pct_of_forecast
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time >= DATEADD('day', -30, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY pct_of_forecast DESC;
```

If any warehouse is > 120% of forecast, the skill recommends either a size-up (if queue time is high) or workload investigation via the `query-optimize` and `cost-report` skills.
