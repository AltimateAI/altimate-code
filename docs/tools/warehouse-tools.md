---
layout: default
title: Warehouse Tools
parent: Tools
nav_order: 6
---

# Warehouse Tools

## warehouse_list

List all configured warehouse connections.

```
> warehouse_list

┌─────────────────┬───────────┬────────────┬─────────────┐
│ Name            │ Type      │ Database   │ Status      │
├─────────────────┼───────────┼────────────┼─────────────┤
│ prod-snowflake  │ snowflake │ ANALYTICS  │ configured  │
│ dev-duckdb      │ duckdb    │ dev.duckdb │ configured  │
│ bigquery-prod   │ bigquery  │ my-project │ configured  │
│ databricks-prod │ databricks│ main       │ configured  │
└─────────────────┴───────────┴────────────┴─────────────┘
```

---

## warehouse_test

Test a warehouse connection.

```
> warehouse_test prod-snowflake

Testing connection to prod-snowflake (snowflake)...
  ✓ Connected successfully
  Account: xy12345.us-east-1
  User: analytics_user
  Role: ANALYST_ROLE
  Warehouse: COMPUTE_WH
  Database: ANALYTICS
```

```
> warehouse_test bigquery-prod

Testing connection to bigquery-prod (bigquery)...
  ✓ Connected successfully
  Project: my-gcp-project
  Dataset: analytics
  Auth: Service Account (svc-altimate@my-gcp-project.iam.gserviceaccount.com)
```

### Connection troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Authentication failed` | Wrong credentials | Check password/token in config |
| `Connection refused` | Network/firewall | Verify host/port, check VPN |
| `Object does not exist` | Wrong database/schema | Verify database name in config |
| `Role not authorized` | Insufficient privileges | Use a role with USAGE on warehouse |
| `Timeout` | Network latency | Increase connection timeout |
