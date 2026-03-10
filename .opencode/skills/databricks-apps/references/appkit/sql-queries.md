# SQL Query Files

**IMPORTANT**: ALWAYS use SQL files in `config/queries/` for data retrieval. NEVER use tRPC for SQL queries.

- Store ALL SQL queries in `config/queries/` directory
- Name files descriptively: `trip_statistics.sql`, `user_metrics.sql`, `sales_by_region.sql`
- Reference by filename (without extension) in `useAnalyticsQuery` or directly in a visualization component passing it as `queryKey`
- App Kit automatically executes queries against configured Databricks warehouse
- Benefits: Built-in caching, proper connection pooling, better performance

## Type Generation

For full type generation details, see: `npx @databricks/appkit docs ./docs/development/type-generation.md`

**Type generation:** Types are auto-regenerated during dev whenever SQL files change.

**Quick workflow:** Add SQL files → Types auto-generate during dev → Types appear in `client/src/appKitTypes.d.ts`

## Query Schemas (Optional)

Create `config/queries/schema.ts` only if you need **runtime validation** with Zod.

```typescript
import { z } from 'zod';

export const querySchemas = {
  my_query: z.array(
    z.object({
      category: z.string(),
      // Use z.coerce.number() - handles both string and number from SQL
      amount: z.coerce.number(),
    })
  ),
};
```

**Why `z.coerce.number()`?**
- Auto-generated types use `number` based on SQL column types
- But some SQL types (DECIMAL, large BIGINT) return as strings at runtime
- `z.coerce.number()` handles both cases safely

## SQL Type Handling (Critical)

**Understanding Type Generation vs Runtime:**

1. **Auto-generated types** (`appKitTypes.d.ts`): Based on SQL column types
   - `BIGINT`, `INT`, `DECIMAL` → TypeScript `number`
   - These are the types you'll see in IntelliSense

2. **Runtime JSON values**: Some numeric types arrive as strings
   - `DECIMAL` often returns as string (e.g., `"123.45"`)
   - Large `BIGINT` values return as string
   - `ROUND()`, `AVG()`, `SUM()` results may be strings

**Best Practice - Always convert before numeric operations:**

```typescript
// ❌ WRONG - may fail if value is string at runtime
<span>{row.total_amount.toFixed(2)}</span>

// ✅ CORRECT - convert to number first
<span>{Number(row.total_amount).toFixed(2)}</span>
```

**Helper Functions:**

Create app-specific helpers for consistent numeric formatting (for example in `client/src/lib/formatters.ts`):

```typescript
// client/src/lib/formatters.ts
export const toNumber = (value: number | string): number => Number(value);
export const formatCurrency = (value: number | string): string =>
  `$${Number(value).toFixed(2)}`;
export const formatPercent = (value: number | string): string =>
  `${Number(value).toFixed(1)}%`;
```

Use them wherever you render query results:

```typescript
import { toNumber, formatCurrency, formatPercent } from './formatters'; // adjust import path to your file layout

// Convert to number
const amount = toNumber(row.amount);  // "123.45" → 123.45

// Format as currency
const formatted = formatCurrency(row.amount);  // "123.45" → "$123.45"

// Format as percentage
const percent = formatPercent(row.rate);  // "85.5" → "85.5%"
```

## Available sql.* Helpers

**Full API reference**: `npx @databricks/appkit docs ./docs/api/appkit/Variable.sql.md` — always check this for the latest available helpers.

```typescript
import { sql } from "@databricks/appkit-ui/js";

// ✅ These exist:
sql.string(value)      // For STRING parameters
sql.number(value)      // For NUMERIC parameters (INT, BIGINT, DOUBLE, DECIMAL)
sql.boolean(value)     // For BOOLEAN parameters
sql.date(value)        // For DATE parameters (YYYY-MM-DD format)
sql.timestamp(value)   // For TIMESTAMP parameters
sql.binary(value)      // For BINARY (returns hex string, use UNHEX() in SQL)

// ❌ These DO NOT exist:
// sql.null()     - use sentinel values instead
// sql.array()    - use comma-separated sql.string() and split in SQL
// sql.int()      - use sql.number()
// sql.float()    - use sql.number()
```

**For nullable string parameters**, use sentinel values or empty strings. **For nullable date parameters**, use sentinel dates only (empty strings cause validation errors) — see "Optional Date Parameters" section below.

## Databricks SQL Dialect

Databricks uses Databricks SQL (based on Spark SQL), NOT PostgreSQL/MySQL. Common mistakes:

| PostgreSQL | Databricks SQL |
|------------|---------------|
| `GENERATE_SERIES(1, 10)` | `explode(sequence(1, 10))` |
| `DATEDIFF(date1, date2)` | `DATEDIFF(DAY, date2, date1)` (3 args!) |
| `NOW()` | `CURRENT_TIMESTAMP()` |
| `INTERVAL '7 days'` | `INTERVAL 7 DAY` |
| `STRING_AGG(col, ',')` | `CONCAT_WS(',', COLLECT_LIST(col))` |
| `ILIKE` | `LOWER(col) LIKE LOWER(pattern)` |

**Sample data date ranges** — do NOT use `CURRENT_DATE()` on historical datasets:
- `samples.tpch.*` — historical dates, check with `SELECT MIN(o_orderdate), MAX(o_orderdate) FROM samples.tpch.orders`
- `samples.nyctaxi.trips` — NYC taxi data with specific date ranges
- `samples.tpcds.*` — data from 1998-2003

Always check date ranges before writing date-filtered queries.

## Before Running `npm run typegen`

Verify each SQL file before running typegen:

- [ ] Uses Databricks SQL syntax (NOT PostgreSQL) — check dialect table above
- [ ] `DATEDIFF` has 3 arguments: `DATEDIFF(DAY, start, end)`
- [ ] Uses `LOWER(col) LIKE LOWER(pattern)` instead of `ILIKE`
- [ ] Column aliases in `ORDER BY` match `SELECT` aliases exactly
- [ ] Date columns are not passed to numeric functions like `ROUND()`
- [ ] Date range filters use actual data dates (NOT `CURRENT_DATE()` on historical data — check date ranges first)

## Query Parameterization

SQL queries can accept parameters to make them dynamic and reusable.

**Key Points:**
- Parameters use colon prefix: `:parameter_name`
- Databricks infers types from values automatically
- For optional string parameters, use pattern: `(:param = '' OR column = :param)`
- **For optional date parameters, use sentinel dates** (`'1900-01-01'` and `'9999-12-31'`) instead of empty strings

### SQL Parameter Syntax

```sql
-- config/queries/filtered_data.sql
SELECT *
FROM my_table
WHERE column_value >= :min_value
  AND column_value <= :max_value
  AND category = :category
  AND (:optional_filter = '' OR status = :optional_filter)
```

### Frontend Parameter Passing

```typescript
import { sql } from "@databricks/appkit-ui/js";

const { data } = useAnalyticsQuery('filtered_data', {
  min_value: sql.number(minValue),
  max_value: sql.number(maxValue),
  category: sql.string(category),
  optional_filter: sql.string(optionalFilter || ''),  // empty string for optional params
});
```

### Date Parameters

Use `sql.date()` for date parameters with `YYYY-MM-DD` format strings.

**Frontend - Using Date Parameters:**

```typescript
import { sql } from '@databricks/appkit-ui/js';
import { useState } from 'react';

function MyComponent() {
  const [startDate, setStartDate] = useState<string>('2016-02-01');
  const [endDate, setEndDate] = useState<string>('2016-02-29');

  const queryParams = {
    start_date: sql.date(startDate),  // Pass YYYY-MM-DD string to sql.date()
    end_date: sql.date(endDate),
  };

  const { data } = useAnalyticsQuery('my_query', queryParams);

  // ...
}
```

**SQL - Date Filtering:**

```sql
-- Filter by date range using DATE() function
SELECT COUNT(*) as trip_count
FROM samples.nyctaxi.trips
WHERE DATE(tpep_pickup_datetime) >= :start_date
  AND DATE(tpep_pickup_datetime) <= :end_date
```

**Date Helper Functions:**

```typescript
// Helper to get YYYY-MM-DD string for dates relative to today
const daysAgo = (n: number): string => {
  const date = new Date(Date.now() - n * 86400000);
  return date.toISOString().split('T')[0];  // "2024-01-15"
};

const params = {
  start_date: sql.date(daysAgo(7)),   // 7 days ago
  end_date: sql.date(daysAgo(0)),     // Today
};
```

### Optional Date Parameters - Use Sentinel Dates

Databricks App Kit validates parameter types before query execution. **DO NOT use empty strings (`''`) for optional date parameters** as this causes validation errors.

**✅ CORRECT - Use Sentinel Dates:**

```typescript
// Frontend: Use sentinel dates for "no filter" instead of empty strings
const revenueParams = {
  group_by: 'month',
  start_date: sql.date('1900-01-01'),  // Sentinel: effectively no lower bound
  end_date: sql.date('9999-12-31'),    // Sentinel: effectively no upper bound
  country: sql.string(country || ''),
  property_type: sql.string(propertyType || ''),
};
```

```sql
-- SQL: Simple comparison since sentinel dates are always valid
WHERE b.check_in >= CAST(:start_date AS DATE)
  AND b.check_in <= CAST(:end_date AS DATE)
```

**Why Sentinel Dates Work:**
- `1900-01-01` is before any real data (effectively no lower bound filter)
- `9999-12-31` is after any real data (effectively no upper bound filter)
- Always valid DATE types, so no parameter validation errors
- All real dates fall within this range, so no filtering occurs

**Parameter Types Summary:**
- ALWAYS use sql.* helper functions from the `@databricks/appkit-ui/js` package to define SQL parameters
- **Strings/Numbers**: Use directly in SQL with `:param_name`
- **Dates**: Use with `CAST(:param AS DATE)` in SQL
- **Optional Strings**: Use empty string default, check with `(:param = '' OR column = :param)`
- **Optional Dates**: Use sentinel dates (`sql.date('1900-01-01')` and `sql.date('9999-12-31')`) instead of empty strings
