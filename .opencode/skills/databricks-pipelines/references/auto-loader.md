# Auto Loader (cloudFiles)

Auto Loader is the recommended approach for incrementally ingesting data from cloud storage into Delta Lake tables. It automatically processes new files as they arrive in cloud storage.

## Key Concepts

Auto Loader (`cloudFiles`) provides:

- Automatic file discovery and processing
- Schema inference and evolution
- Exactly-once processing guarantees
- Scalable incremental ingestion
- Support for various file formats

## Language-Specific Implementations

For detailed implementation guides:

- **Python**: [auto-loader-python.md](auto-loader-python.md)
- **SQL**: [auto-loader-sql.md](auto-loader-sql.md)

## Format-Specific Options

For format-specific configuration options, refer to:

- **JSON**: [options-json.md](options-json.md)
- **CSV**: [options-csv.md](options-csv.md)
- **XML**: [options-xml.md](options-xml.md)
- **Parquet**: [options-parquet.md](options-parquet.md)
- **Avro**: [options-avro.md](options-avro.md)
- **Text**: [options-text.md](options-text.md)
- **ORC**: [options-orc.md](options-orc.md)
