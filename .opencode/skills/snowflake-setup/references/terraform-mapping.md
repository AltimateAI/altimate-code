# Terraform / IaC Output Mapping

Every Snowflake object created by this skill has a `Snowflake-Labs/snowflake` Terraform provider equivalent. This reference is the DDL → HCL mapping the skill uses when `Output format = terraform` or `both`.

## Provider Bootstrap

Always emitted first when Terraform output is selected.

```hcl
# providers.tf
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    snowflake = {
      source  = "Snowflake-Labs/snowflake"
      version = "~> 0.95"
    }
  }
}

provider "snowflake" {
  account_name       = var.snowflake_account
  organization_name  = var.snowflake_org
  user               = var.snowflake_user
  authenticator      = "SNOWFLAKE_JWT"
  private_key        = file(var.snowflake_private_key_path)
  role               = "ACCOUNTADMIN"
  # ACCOUNTADMIN required for initial bootstrap; switch to SYSADMIN
  # provider alias for day-2 operations
}

provider "snowflake" {
  alias              = "sysadmin"
  account_name       = var.snowflake_account
  organization_name  = var.snowflake_org
  user               = var.snowflake_user
  authenticator      = "SNOWFLAKE_JWT"
  private_key        = file(var.snowflake_private_key_path)
  role               = "SYSADMIN"
}

provider "snowflake" {
  alias              = "securityadmin"
  account_name       = var.snowflake_account
  organization_name  = var.snowflake_org
  user               = var.snowflake_user
  authenticator      = "SNOWFLAKE_JWT"
  private_key        = file(var.snowflake_private_key_path)
  role               = "SECURITYADMIN"
}
```

```hcl
# variables.tf
variable "snowflake_account"          { type = string }
variable "snowflake_org"              { type = string }
variable "snowflake_user"             { type = string }
variable "snowflake_private_key_path" {
  type      = string
  sensitive = true
}
variable "environment" {
  type    = string
  default = "prod"
  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment must be prod, staging, or dev"
  }
}
```

## DDL → HCL Mapping Table

### Databases and Schemas

```hcl
resource "snowflake_database" "raw" {
  name                        = "RAW"
  comment                     = "Raw ingestion layer"
  data_retention_time_in_days = 1
}

resource "snowflake_schema" "raw_salesforce" {
  database = snowflake_database.raw.name
  name     = "SALESFORCE"
  comment  = "Salesforce ingestion (Fivetran)"
}
```

### Warehouses

```hcl
resource "snowflake_warehouse" "transform_wh" {
  name                = "TRANSFORM_WH"
  warehouse_size      = "SMALL"
  auto_suspend        = 60
  auto_resume         = true
  initially_suspended = true

  # Attach resource monitor here (not on the resource monitor's `warehouses`
  # attribute, which was removed in provider v0.90+):
  resource_monitor = snowflake_resource_monitor.transform_wh_monitor.name

  # Cost-attribution tags applied via snowflake_tag_association below
}
```

### Custom Roles + Hierarchy

```hcl
resource "snowflake_account_role" "transform" {
  name    = "TRANSFORM_ROLE"
  comment = "dbt transformation role"
}

resource "snowflake_grant_account_role" "transform_to_sysadmin" {
  provider         = snowflake.securityadmin
  role_name        = snowflake_account_role.transform.name
  parent_role_name = "SYSADMIN"
}
```

### Object Grants (regular + FUTURE)

```hcl
# Grant SELECT on all existing tables in RAW.SALESFORCE
resource "snowflake_grant_privileges_to_account_role" "analyst_select_raw_sf" {
  provider          = snowflake.sysadmin
  account_role_name = snowflake_account_role.analyst.name
  privileges        = ["SELECT"]

  on_schema_object {
    all {
      object_type_plural = "TABLES"
      in_schema          = "\"${snowflake_database.raw.name}\".\"${snowflake_schema.raw_salesforce.name}\""
    }
  }
}

# CRITICAL: also grant on FUTURE tables — otherwise new tables are invisible
resource "snowflake_grant_privileges_to_account_role" "analyst_select_raw_sf_future" {
  provider          = snowflake.sysadmin
  account_role_name = snowflake_account_role.analyst.name
  privileges        = ["SELECT"]

  on_schema_object {
    future {
      object_type_plural = "TABLES"
      in_schema          = "\"${snowflake_database.raw.name}\".\"${snowflake_schema.raw_salesforce.name}\""
    }
  }
}
```

### Warehouse Usage Grants

```hcl
resource "snowflake_grant_privileges_to_account_role" "analyst_use_analytics_wh" {
  provider          = snowflake.sysadmin
  account_role_name = snowflake_account_role.analyst.name
  privileges        = ["USAGE"]

  on_account_object {
    object_type = "WAREHOUSE"
    object_name = snowflake_warehouse.analytics_wh.name
  }
}
```

### Service Accounts

```hcl
resource "snowflake_user" "fivetran_loader" {
  provider          = snowflake.securityadmin
  name              = "FIVETRAN_LOADER"
  default_role      = snowflake_account_role.loader.name
  default_warehouse = snowflake_warehouse.loading_wh.name
  rsa_public_key    = file("${path.module}/keys/fivetran_loader.pub")

  must_change_password = false
}

resource "snowflake_grant_account_role" "fivetran_loader_gets_loader" {
  provider  = snowflake.securityadmin
  role_name = snowflake_account_role.loader.name
  user_name = snowflake_user.fivetran_loader.name
}
```

### Resource Monitors

```hcl
# Schema note: as of Snowflake-Labs/snowflake v0.90+:
# - `set_for_account` is removed. Use `snowflake_account_parameter` with
#   key = "RESOURCE_MONITOR" to attach a monitor at the account level.
# - `warehouses` is removed. Set `resource_monitor = "MONITOR_NAME"` on the
#   `snowflake_warehouse` resource instead.
# Verified against v0.100.0 on 2026-08-26.

resource "snowflake_resource_monitor" "account_monitor" {
  name            = "ACCOUNT_MONITOR"
  credit_quota    = 500
  frequency       = "MONTHLY"
  start_timestamp = "IMMEDIATELY"

  notify_triggers = [50, 75, 90]
  suspend_trigger = 100
}

# Attach the account-level monitor. NOTE: `snowflake_account_parameter` does
# NOT accept "RESOURCE_MONITOR" as a key — the provider validates the key
# against a fixed allowlist of Snowflake account parameters and rejects with
# "invalid account parameter: RESOURCE_MONITOR" during `tofu validate`.
# Verified 2026-08-26 against provider v0.100.0. Use `snowflake_execute`
# instead, which shells out to raw SQL:
resource "snowflake_execute" "attach_account_monitor" {
  execute = "ALTER ACCOUNT SET RESOURCE_MONITOR = ${snowflake_resource_monitor.account_monitor.name}"
  revert  = "ALTER ACCOUNT UNSET RESOURCE_MONITOR"
  query   = "SELECT SYSTEM$GET_ACCOUNT_ATTRIBUTE('RESOURCE_MONITOR') AS monitor"
}

resource "snowflake_resource_monitor" "transform_wh_monitor" {
  name         = "TRANSFORM_WH_MONITOR"
  credit_quota = 150
  frequency    = "MONTHLY"

  notify_triggers = [75, 90]
  suspend_trigger = 100
}

# The warehouse attaches the monitor via its own resource_monitor attribute
# (see the snowflake_warehouse block earlier in this file — add:
#   resource_monitor = snowflake_resource_monitor.transform_wh_monitor.name
# )
```

### Storage Integrations

```hcl
resource "snowflake_storage_integration" "s3_raw" {
  name    = "S3_RAW_INTEGRATION"
  type    = "EXTERNAL_STAGE"
  enabled = true

  storage_provider          = "S3"
  storage_aws_role_arn      = var.aws_snowflake_role_arn
  storage_allowed_locations = ["s3://${var.raw_bucket}/"]
}

# Output the values needed to configure the IAM trust policy on AWS side
output "storage_integration_aws_iam_user_arn" {
  value = snowflake_storage_integration.s3_raw.storage_aws_iam_user_arn
}

output "storage_integration_aws_external_id" {
  value = snowflake_storage_integration.s3_raw.storage_aws_external_id
}
```

### Stages and File Formats

```hcl
resource "snowflake_file_format" "csv_standard" {
  provider           = snowflake.sysadmin
  name               = "CSV_STANDARD"
  database           = snowflake_database.raw.name
  schema             = "PUBLIC"
  format_type        = "CSV"
  field_optionally_enclosed_by = "\""
  null_if            = ["NULL", "null", ""]
  empty_field_as_null = true
  skip_header        = 1
}

resource "snowflake_stage" "raw_sf_s3" {
  provider            = snowflake.sysadmin
  name                = "S3_STAGE"
  database            = snowflake_database.raw.name
  schema              = snowflake_schema.raw_salesforce.name
  storage_integration = snowflake_storage_integration.s3_raw.name
  url                 = "s3://${var.raw_bucket}/salesforce/"
  file_format         = "TYPE = 'PARQUET'"
}
```

### Pipes

```hcl
resource "snowflake_pipe" "accounts_pipe" {
  provider       = snowflake.sysadmin
  name           = "ACCOUNTS_PIPE"
  database       = snowflake_database.raw.name
  schema         = snowflake_schema.raw_salesforce.name
  auto_ingest    = true
  copy_statement = <<EOT
    COPY INTO ${snowflake_database.raw.name}.${snowflake_schema.raw_salesforce.name}.ACCOUNTS
    FROM @${snowflake_database.raw.name}.${snowflake_schema.raw_salesforce.name}.${snowflake_stage.raw_sf_s3.name}/accounts/
    FILE_FORMAT = (TYPE = 'PARQUET')
  EOT
}

# The notification_channel output feeds the S3 bucket event notification setup
output "accounts_pipe_notification_channel" {
  value = snowflake_pipe.accounts_pipe.notification_channel
}
```

### Tasks

```hcl
resource "snowflake_task" "load_accounts_hourly" {
  provider      = snowflake.sysadmin
  name          = "LOAD_ACCOUNTS_HOURLY"
  database      = snowflake_database.raw.name
  schema        = snowflake_schema.raw_salesforce.name
  warehouse     = snowflake_warehouse.loading_wh.name
  schedule      = "USING CRON 0 * * * * UTC"
  sql_statement = <<EOT
    COPY INTO ${snowflake_database.raw.name}.${snowflake_schema.raw_salesforce.name}.ACCOUNTS
    FROM @${snowflake_database.raw.name}.${snowflake_schema.raw_salesforce.name}.${snowflake_stage.raw_sf_s3.name}/accounts/
    FILE_FORMAT = (FORMAT_NAME = ${snowflake_file_format.csv_standard.fully_qualified_name})
    ON_ERROR = 'CONTINUE'
  EOT
  enabled       = true
}
```

### Masking Policies

```hcl
# Schema note: `snowflake_masking_policy` uses `argument` blocks and `body` (not
# `signature { column { ... } }` and `masking_expression`) as of provider
# v0.90+. Verified against Snowflake-Labs/snowflake v0.100.0 on 2026-08-26 via
# `tofu validate`. Emitting the old form fails validation with "The argument
# 'body' is required" and "Blocks of type 'signature' are not expected here".
resource "snowflake_masking_policy" "mask_email" {
  provider         = snowflake.sysadmin
  name             = "MASK_EMAIL"
  database         = snowflake_database.raw.name
  schema           = "PUBLIC"
  argument {
    name = "VAL"
    type = "STRING"
  }
  return_data_type = "STRING"
  body             = <<-EOT
    CASE
      WHEN CURRENT_ROLE() IN ('DATA_PLATFORM_ADMIN', 'LOADER_ROLE') THEN VAL
      WHEN CURRENT_ROLE() IN ('ANALYST_ROLE', 'BI_ROLE') THEN REGEXP_REPLACE(VAL, '^[^@]+', '****')
      ELSE '****@****.***'
    END
  EOT
}

# Apply masking policy to a column
resource "snowflake_table_column_masking_policy_application" "contacts_email" {
  provider       = snowflake.sysadmin
  table          = "${snowflake_database.raw.name}.${snowflake_schema.raw_salesforce.name}.CONTACTS"
  column         = "EMAIL"
  masking_policy = snowflake_masking_policy.mask_email.fully_qualified_name
}
```

### Row Access Policies

```hcl
# Schema note: `snowflake_row_access_policy` uses `argument` blocks and `body`
# (not `signature = {}` and `row_access_expression`) as of provider v0.90+.
# Same reasoning as snowflake_masking_policy above.
resource "snowflake_row_access_policy" "team_access" {
  provider = snowflake.sysadmin
  name     = "TEAM_ACCESS_POLICY"
  database = snowflake_database.analytics.name
  schema   = "CORE"
  argument {
    name = "TEAM_ID"
    type = "VARCHAR"
  }
  body     = <<-EOT
    EXISTS (
      SELECT 1 FROM ${snowflake_database.analytics.name}.CORE.USER_DATA_ACCESS_MAP m
      WHERE m.user_email = CURRENT_USER() AND m.team_id = TEAM_ID
    )
    OR CURRENT_ROLE() = 'DATA_PLATFORM_ADMIN'
  EOT
}
```

### Tags

```hcl
resource "snowflake_tag" "cost_center" {
  provider       = snowflake.sysadmin
  name           = "COST_CENTER"
  database       = snowflake_database.raw.name
  schema         = "PUBLIC"
  allowed_values = ["engineering", "marketing", "finance", "data-platform", "ml"]
}

resource "snowflake_tag_association" "transform_wh_cost_center" {
  provider   = snowflake.sysadmin
  tag_id     = snowflake_tag.cost_center.fully_qualified_name
  object_type = "WAREHOUSE"
  object_identifiers = [snowflake_warehouse.transform_wh.fully_qualified_name]
  tag_value  = "data-platform"
}
```

### Network Policies

```hcl
resource "snowflake_network_policy" "office_and_vpn" {
  provider   = snowflake.securityadmin
  name       = "OFFICE_AND_VPN"
  allowed_ip_list = var.allowed_ip_cidrs  # e.g. ["10.0.0.0/8", "203.0.113.5/32"]
  comment    = "Allow office and VPN ranges only"
}

resource "snowflake_account_parameter" "default_network_policy" {
  provider = snowflake.securityadmin
  key      = "NETWORK_POLICY"
  value    = snowflake_network_policy.office_and_vpn.name
}
```

## Terraform-Specific Guardrails

Beyond the DDL guardrails, Terraform mode adds these:

1. **State file protection** — emit a warning if the user isn't using a remote backend (S3 + DynamoDB lock, or Terraform Cloud). Never store Snowflake credentials in a local `.tfstate`.
2. **`prevent_destroy` lifecycle blocks** on prod databases:
   ```hcl
   lifecycle {
     prevent_destroy = true
   }
   ```
3. **Sensitive outputs** — `storage_integration_aws_external_id` and any private key paths must be marked `sensitive = true`.
4. **Provider alias discipline** — every resource that needs a non-ACCOUNTADMIN role must set the `provider` field explicitly. Never let the default (ACCOUNTADMIN) run day-2 operations.
5. **`for_each` for repeated objects** — when creating many schemas or grants that follow the same shape, emit `for_each` blocks driven by locals so future additions are one-line changes.

## Import-Existing Escape Hatch

For brownfield accounts already partially configured, the skill emits an `imports.tf` file mapping existing objects to Terraform state:

```hcl
import {
  to = snowflake_database.raw
  id = "RAW"
}

import {
  to = snowflake_warehouse.transform_wh
  id = "TRANSFORM_WH"
}
```

Users run `terraform plan -generate-config-out=generated.tf` to reverse-engineer HCL from live state, then reconcile with the emitted config.
