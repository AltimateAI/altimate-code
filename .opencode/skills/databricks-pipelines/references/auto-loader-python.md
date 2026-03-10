Auto Loader (`cloudFiles`) is recommended for ingesting from cloud storage.

**Basic Syntax:**

```python
@dp.table()
def my_table():
    return (
        spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "json")  # or csv, parquet, etc.
        .load("s3://bucket/path")
    )
```

**Critical Spark Declarative Pipelines + Auto Loader Rules:**

- Databricks automatically manages `cloudFiles.schemaLocation` and checkpoint - do NOT specify these
- Auto Loader returns a streaming DataFrame - general API guidelines for `streamingTable` apply (MANDATORY to look up `streamingTable` guide)
  - Can be used in either a streaming `@dp.table()` / `@dlt.table()` or via `@dp.append_flow()` / `@dlt.append_flow()`
  - Use `spark.readStream` not `spark.read` for streaming ingestion
- If manually specifying a schema, include the rescued data column (default `_rescued_data STRING`, configurable via `rescuedDataColumn` option)
- Common Schema Options:
  - `cloudFiles.inferColumnTypes`: Enable type inference (default: strings for JSON/CSV/XML)
  - `cloudFiles.schemaHints`: Optionally specify known column types (e.g., `"id int, name string"`)
- File detection: File notification mode recommended for scalability

**Common Auto Loader Options**
Below are all format agnostic options for Auto Loader.

Common Auto Loader Options

| Option                                   | Type            | Notes                              |
| ---------------------------------------- | --------------- | ---------------------------------- |
| cloudFiles.allowOverwrites               | Boolean         |                                    |
| cloudFiles.backfillInterval              | Interval String |                                    |
| cloudFiles.cleanSource                   | String          |                                    |
| cloudFiles.cleanSource.retentionDuration | Interval String |                                    |
| cloudFiles.cleanSource.moveDestination   | String          |                                    |
| cloudFiles.format                        | String          |                                    |
| cloudFiles.includeExistingFiles          | Boolean         |                                    |
| cloudFiles.inferColumnTypes              | Boolean         |                                    |
| cloudFiles.maxBytesPerTrigger            | Byte String     |                                    |
| cloudFiles.maxFileAge                    | Interval String |                                    |
| cloudFiles.maxFilesPerTrigger            | Integer         |                                    |
| cloudFiles.partitionColumns              | String          |                                    |
| cloudFiles.schemaEvolutionMode           | String          |                                    |
| cloudFiles.schemaHints                   | String          |                                    |
| cloudFiles.schemaLocation                | String          | DO NOT SET - managed automatically |
| cloudFiles.useStrictGlobber              | Boolean         |                                    |
| cloudFiles.validateOptions               | Boolean         |                                    |

Directory Listing Options

| Option                           | Type   |
| -------------------------------- | ------ |
| cloudFiles.useIncrementalListing | String |

File Notification Options

| Option                          | Type                |
| ------------------------------- | ------------------- |
| cloudFiles.fetchParallelism     | Integer             |
| cloudFiles.pathRewrites         | JSON String         |
| cloudFiles.resourceTag          | Map(String, String) |
| cloudFiles.useManagedFileEvents | Boolean             |
| cloudFiles.useNotifications     | Boolean             |

AWS-Specific Options

| Option                       | Type   |
| ---------------------------- | ------ |
| cloudFiles.region            | String |
| cloudFiles.queueUrl          | String |
| cloudFiles.awsAccessKey      | String |
| cloudFiles.awsSecretKey      | String |
| cloudFiles.roleArn           | String |
| cloudFiles.roleExternalId    | String |
| cloudFiles.roleSessionName   | String |
| cloudFiles.stsEndpoint       | String |
| databricks.serviceCredential | String |

Azure-Specific Options

| Option                       | Type   |
| ---------------------------- | ------ |
| cloudFiles.resourceGroup     | String |
| cloudFiles.subscriptionId    | String |
| cloudFiles.clientId          | String |
| cloudFiles.clientSecret      | String |
| cloudFiles.connectionString  | String |
| cloudFiles.tenantId          | String |
| cloudFiles.queueName         | String |
| databricks.serviceCredential | String |

GCP-Specific Options

| Option                       | Type   |
| ---------------------------- | ------ |
| cloudFiles.projectId         | String |
| cloudFiles.client            | String |
| cloudFiles.clientEmail       | String |
| cloudFiles.privateKey        | String |
| cloudFiles.privateKeyId      | String |
| cloudFiles.subscription      | String |
| databricks.serviceCredential | String |

Generic File Format Options

| Option                           | Type             |
| -------------------------------- | ---------------- |
| ignoreCorruptFiles               | Boolean          |
| ignoreMissingFiles               | Boolean          |
| modifiedAfter                    | Timestamp String |
| modifiedBefore                   | Timestamp String |
| pathGlobFilter / fileNamePattern | String           |
| recursiveFileLookup              | Boolean          |

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
MANDATORY: Look up the official Databricks documentation for detailed information on any specific cloudFiles (Auto Loader) option before use. Each option has extensive documentation. No exceptions.
