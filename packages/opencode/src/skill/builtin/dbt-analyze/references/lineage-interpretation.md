# Lineage Interpretation Guide

## Understanding Column-Level Lineage

Column-level lineage traces how data flows from source columns through transformations to output columns.

### Direct Lineage
```
source.customers.name → stg_customers.customer_name → dim_customers.full_name
```
Column was renamed at each step. A change to the source column affects all downstream.

### Aggregation Lineage
```
source.orders.amount → (SUM) → fct_daily_revenue.total_revenue
```
Multiple source rows feed into one output value. The column type changes from row-level to aggregate.

### Conditional Lineage
```
source.orders.status → (CASE WHEN) → fct_orders.is_completed
```
The source column feeds a derived boolean. The relationship is logical, not direct.

## Impact Classification

### BREAKING Changes
- **Column removed**: Downstream models referencing it will fail
- **Column renamed**: Same as removed — downstream still uses the old name
- **Type changed**: May cause cast errors or silent data loss downstream
- **Logic changed**: Downstream aggregations/filters may produce wrong results

### SAFE Changes
- **Column added**: No downstream model can reference what didn't exist
- **Description changed**: No runtime impact
- **Test added/modified**: No impact on model data

### REQUIRES REVIEW
- **Filter changed**: May change which rows appear → downstream counts change
- **JOIN type changed**: LEFT→INNER drops rows, INNER→LEFT adds NULLs
- **Materialization changed**: view→table has no logical impact but affects freshness

## Reading the DAG

```bash
altimate-dbt parents --model <name>     # what this model depends on
altimate-dbt children --model <name>    # what depends on this model
```

A model with many children has high blast radius. A model with many parents has high complexity.

## Depth Matters

- **Depth 1**: Direct consumers — highest risk, most likely to break
- **Depth 2+**: Cascading impact — will break IF depth 1 breaks
- **Depth 3+**: Usually only affected by breaking column removals/renames

Focus investigation on depth 1 first.
