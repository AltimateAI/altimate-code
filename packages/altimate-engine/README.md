# altimate-engine

Python engine for [Altimate Code](https://github.com/AltimateAI/altimate-code) — SQL analysis, column-level lineage, and dbt integration.

## Installation

```
pip install altimate-engine
```

For warehouse connectivity (Snowflake, BigQuery, Databricks, etc.):

```
pip install altimate-engine[warehouses]
```

## Usage

This package is designed to be used as a sidecar process for the Altimate Code CLI. It communicates via JSON-RPC over stdio.

```python
python -m altimate_engine.server
```

## Documentation

See the main repository for full documentation: https://github.com/AltimateAI/altimate-code

## License

MIT
