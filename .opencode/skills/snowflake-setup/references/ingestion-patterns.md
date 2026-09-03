# Data Ingestion Patterns

## Decision Tree: Which ingestion method?

```
Data already in S3/GCS/Azure Blob?
  ├─ Yes, continuous (event-driven, files land within minutes)  → Snowpipe
  ├─ Yes, scheduled batch (hourly/daily dumps)                  → Task + COPY INTO
  └─ No, need to move it there first:
       ├─ SaaS source (Salesforce, HubSpot, Stripe, etc.)      → Third-party connector (Fivetran, Airbyte)
       ├─ Operational DB (Postgres, MySQL, MongoDB)             → CDC connector or pg_dump + S3 + COPY
       └─ Streaming (Kafka, Kinesis)                            → Kafka Connector for Snowflake (Snowpipe Streaming)
```

## Pattern 1 — Snowpipe (Event-Driven Continuous Load)

Best for: Files landing in S3/GCS/Azure within minutes of creation, near-real-time latency requirements.

### Full setup sequence

```sql
-- 1. Storage integration (ACCOUNTADMIN required)
CREATE STORAGE INTEGRATION s3_raw_integration
  TYPE = EXTERNAL_STAGE
  STORAGE_PROVIDER = 'S3'
  ENABLED = TRUE
  STORAGE_AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/snowflake-s3-role'
  STORAGE_ALLOWED_LOCATIONS = ('s3://your-data-bucket/');

DESC INTEGRATION s3_raw_integration;
-- Note: STORAGE_AWS_IAM_USER_ARN and STORAGE_AWS_EXTERNAL_ID
-- Add these to the IAM role's trust policy in AWS

-- 2. External stage
CREATE STAGE RAW.SALESFORCE.s3_stage
  STORAGE_INTEGRATION = s3_raw_integration
  URL = 's3://your-data-bucket/salesforce/'
  FILE_FORMAT = (TYPE = 'PARQUET');

-- 3. Target table
CREATE TABLE RAW.SALESFORCE.ACCOUNTS (
  _airbyte_raw_id       VARCHAR,
  _airbyte_emitted_at   TIMESTAMP_LTZ,
  _airbyte_data         VARIANT    -- for JSON/Parquet with dynamic schema
);

-- 4. Pipe
CREATE PIPE RAW.SALESFORCE.accounts_pipe
  AUTO_INGEST = TRUE
  AS
  COPY INTO RAW.SALESFORCE.ACCOUNTS
  FROM @RAW.SALESFORCE.s3_stage/accounts/
  FILE_FORMAT = (TYPE = 'PARQUET');

-- 5. Get the SQS queue ARN for S3 event notification
SHOW PIPES IN SCHEMA RAW.SALESFORCE;
-- Use the notification_channel value in S3 → Properties → Event notifications
```

### AWS S3 event notification setup (manual step)
- S3 bucket → Properties → Event notifications → Create
- Event type: `s3:ObjectCreated:*`
- Prefix: `salesforce/accounts/` (match your stage path)
- Destination: SQS queue ARN from `SHOW PIPES`

### Monitor Snowpipe

```sql
-- Check pipe status
SELECT SYSTEM$PIPE_STATUS('RAW.SALESFORCE.ACCOUNTS_PIPE');

-- Recent load history
SELECT * FROM TABLE(INFORMATION_SCHEMA.COPY_HISTORY(
  TABLE_NAME => 'RAW.SALESFORCE.ACCOUNTS',
  START_TIME => DATEADD('hour', -24, CURRENT_TIMESTAMP())
))
ORDER BY last_load_time DESC;

-- Files with errors
SELECT stage_location, file_name, error_count, status
FROM TABLE(INFORMATION_SCHEMA.COPY_HISTORY(
  TABLE_NAME => 'RAW.SALESFORCE.ACCOUNTS',
  START_TIME => DATEADD('day', -7, CURRENT_TIMESTAMP())
))
WHERE status != 'Loaded'
ORDER BY last_load_time DESC;
```

## Pattern 2 — Task + COPY INTO (Scheduled Batch)

Best for: Scheduled batch files (hourly/daily), simpler setup than Snowpipe, no S3 event notification required.

```sql
-- File format (define once, reuse across tables)
CREATE FILE FORMAT RAW.PUBLIC.csv_standard
  TYPE = 'CSV'
  FIELD_OPTIONALLY_ENCLOSED_BY = '"'
  NULL_IF = ('NULL', 'null', '', '\\N')
  EMPTY_FIELD_AS_NULL = TRUE
  DATE_FORMAT = 'AUTO'
  TIMESTAMP_FORMAT = 'AUTO'
  SKIP_HEADER = 1;

-- Task runs every hour
CREATE TASK RAW.SALESFORCE.load_accounts_hourly
  WAREHOUSE = LOADING_WH
  SCHEDULE = 'USING CRON 0 * * * * UTC'
AS
  COPY INTO RAW.SALESFORCE.ACCOUNTS
  FROM @RAW.SALESFORCE.s3_stage/accounts/
  FILE_FORMAT = (FORMAT_NAME = RAW.PUBLIC.csv_standard)
  ON_ERROR = 'CONTINUE'     -- skip bad files, log errors
  PURGE = FALSE;            -- don't delete source files after load

-- Enable the task (tasks start suspended)
ALTER TASK RAW.SALESFORCE.load_accounts_hourly RESUME;

-- Check task history
SELECT *
FROM TABLE(INFORMATION_SCHEMA.TASK_HISTORY(
  TASK_NAME => 'LOAD_ACCOUNTS_HOURLY',
  SCHEDULED_TIME_RANGE_START => DATEADD('day', -7, CURRENT_TIMESTAMP())
))
ORDER BY scheduled_time DESC;
```

## Pattern 3 — Third-Party Connectors (Fivetran / Airbyte)

For SaaS sources (Salesforce, HubSpot, Stripe, GitHub, etc.), use a managed connector. Snowflake setup:

```sql
-- Create a dedicated schema per connector (Fivetran convention)
CREATE SCHEMA RAW.FIVETRAN_SALESFORCE;
CREATE SCHEMA RAW.FIVETRAN_STRIPE;
CREATE SCHEMA RAW.AIRBYTE_HUBSPOT;

-- Create a loader service account for the connector
CREATE USER fivetran_loader
  DEFAULT_ROLE = LOADER_ROLE
  DEFAULT_WAREHOUSE = LOADING_WH
  MUST_CHANGE_PASSWORD = FALSE;
GRANT ROLE LOADER_ROLE TO USER fivetran_loader;

-- Fivetran requires CREATE TABLE + MODIFY on its schemas
GRANT ALL ON SCHEMA RAW.FIVETRAN_SALESFORCE TO ROLE LOADER_ROLE;
GRANT ALL ON FUTURE TABLES IN SCHEMA RAW.FIVETRAN_SALESFORCE TO ROLE LOADER_ROLE;
```

In Fivetran/Airbyte: use the `LOADING_WH` warehouse, the `fivetran_loader` user, and point to `RAW.FIVETRAN_SALESFORCE` as the destination schema.

## Pattern 4 — Snowpipe Streaming (Kafka / Real-Time)

For Kafka topics or high-throughput streams needing sub-minute latency.

```sql
-- Snowpipe Streaming uses a different API (not COPY INTO)
-- Create the target table with CLUSTER BY for query performance
CREATE TABLE RAW.EVENTS.clickstream (
  event_id        VARCHAR,
  session_id      VARCHAR,
  event_type      VARCHAR,
  properties      VARIANT,
  received_at     TIMESTAMP_LTZ
)
CLUSTER BY (DATE_TRUNC('day', received_at));
```

The Kafka Connector for Snowflake handles the pipe creation automatically. Configure it with:
- `snowflake.url.name`: your account URL
- `snowflake.user.name`: streaming service account
- `snowflake.private.key`: base64-encoded private key (key-pair auth required for Snowpipe Streaming)
- `snowflake.database`, `snowflake.schema`: target location

## Loading from Internal Stages (Local Files)

```sql
-- Create an internal (Snowflake-managed) stage
CREATE STAGE RAW.SALESFORCE.local_uploads;

-- Upload files via SnowSQL CLI
-- snowsql -q "PUT file:///path/to/data.csv @RAW.SALESFORCE.local_uploads"

-- Load from internal stage
COPY INTO RAW.SALESFORCE.ACCOUNTS
FROM @RAW.SALESFORCE.local_uploads/data.csv
FILE_FORMAT = (FORMAT_NAME = RAW.PUBLIC.csv_standard);

-- Clean up after load
REMOVE @RAW.SALESFORCE.local_uploads/data.csv;
```

## File Format Reference

```sql
-- JSON (semistructured data)
CREATE FILE FORMAT json_standard
  TYPE = 'JSON'
  STRIP_OUTER_ARRAY = TRUE       -- if file is a JSON array at top level
  NULL_IF = ('null', 'NULL');

-- Parquet (best compression and performance)
CREATE FILE FORMAT parquet_standard
  TYPE = 'PARQUET'
  SNAPPY_COMPRESSION = TRUE;

-- Avro
CREATE FILE FORMAT avro_standard
  TYPE = 'AVRO';

-- ORC
CREATE FILE FORMAT orc_standard
  TYPE = 'ORC';
```

## COPY INTO Best Practices

```sql
-- Load only new files (Snowflake tracks loaded files by default)
COPY INTO <table> FROM @<stage>
  FILE_FORMAT = (FORMAT_NAME = <format>)
  ON_ERROR = 'CONTINUE'         -- don't fail the whole batch on one bad file
  FORCE = FALSE;                -- default; FORCE = TRUE reloads already-loaded files

-- Validate without loading (dry run)
COPY INTO <table> FROM @<stage>
  FILE_FORMAT = (FORMAT_NAME = <format>)
  VALIDATION_MODE = 'RETURN_ERRORS';

-- Load a specific file
COPY INTO <table> FROM @<stage>/<specific_file.parquet>
  FILE_FORMAT = (FORMAT_NAME = <format>);
```
