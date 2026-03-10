Auto Loader with SQL (`read_files`) is recommended for ingesting from cloud storage.

**Basic Syntax:**

```sql
-- Using Auto Loader with CREATE STREAMING TABLE
CREATE OR REFRESH STREAMING TABLE my_table
AS SELECT * FROM STREAM(read_files(
  's3://bucket/path',
  format => 'json'
));

-- Using Auto Loader directly with CREATE FLOW (no intermediate table needed)
CREATE STREAMING TABLE target_table;

CREATE FLOW ingest_flow
AS INSERT INTO target_table BY NAME
SELECT * FROM STREAM(read_files(
  's3://bucket/path',
  format => 'json'
));
```

**Critical Spark Declarative Pipelines + Auto Loader Rules:**

- **MUST use `STREAM` keyword with `read_files` in streaming contexts** (e.g., `SELECT * FROM STREAM read_files(...)`)
- `inferColumnTypes` defaults to `true` - column types are automatically inferred, no need to specify unless setting to `false`
- Schema inference: Samples data initially to determine structure, then adapts as new data is encountered
  - Use `schemaHints` to specify known column types (e.g., `schemaHints => 'id int, name string'`)
  - Use `schemaEvolutionMode` to control how schema adapts when encountering new columns
- Unity Catalog pipelines must use external locations when loading files

**Common read_files Options**
Below are all format agnostic options for `read_files`.

Basic Options

| Option             | Type    |
| ------------------ | ------- |
| `format`           | String  |
| `inferColumnTypes` | Boolean |
| `partitionColumns` | String  |
| `schemaHints`      | String  |
| `useStrictGlobber` | Boolean |

Generic File Format Options

| Option                               | Type             |
| ------------------------------------ | ---------------- |
| `ignoreCorruptFiles`                 | Boolean          |
| `ignoreMissingFiles`                 | Boolean          |
| `modifiedAfter`                      | Timestamp String |
| `modifiedBefore`                     | Timestamp String |
| `pathGlobFilter` / `fileNamePattern` | String           |
| `recursiveFileLookup`                | Boolean          |

Streaming Options

| Option                 | Type        |
| ---------------------- | ----------- |
| `allowOverwrites`      | Boolean     |
| `includeExistingFiles` | Boolean     |
| `maxBytesPerTrigger`   | Byte String |
| `maxFilesPerTrigger`   | Integer     |
| `schemaEvolutionMode`  | String      |
| `schemaLocation`       | String      |

Format-Specific Options

For detailed format-specific options, refer to these files:

- **[JSON Options](options-json.md)**: Options for reading JSON files
- **[CSV Options](options-csv.md)**: Options for reading CSV files
- **[Parquet Options](options-parquet.md)**: Options for reading Parquet files
- **[Avro Options](options-avro.md)**: Options for reading Avro files
- **[ORC Options](options-orc.md)**: Options for reading ORC files
- **[XML Options](options-xml.md)**: Options for reading XML files
- **[Text Options](options-text.md)**: Options for reading text files

See the linked format option files for specific documentation.

**Auto Loader documentation:**
MANDATORY: Look up the official Databricks documentation for detailed information on any specific read_files (Auto Loader) option before use. Each option has extensive documentation. No exceptions.
