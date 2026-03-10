# Databricks App Kit SDK

## TypeScript Import Rules

This template uses strict TypeScript settings with `verbatimModuleSyntax: true`. **Always use `import type` for type-only imports**.

Template enforces `noUnusedLocals` - remove unused imports immediately or build fails.

```typescript
// ✅ CORRECT - use import type for types
import type { MyInterface, MyType } from './types';

// ❌ WRONG - will fail compilation
import { MyInterface, MyType } from './types';
```

## Server Setup

For server configuration, see: `npx @databricks/appkit docs ./docs/plugins.md`

## useAnalyticsQuery Hook

**ONLY use when displaying data in a custom way that isn't a chart or table.** For charts/tables, pass `queryKey` directly to the component — don't double-fetch. Charts also accept a `format` option (`"json"` | `"arrow"` | `"auto"`, default `"auto"`) to control the data transfer format.

Use cases:
- Custom HTML layouts (cards, lists, grids)
- Summary statistics and KPIs
- Conditional rendering based on data values
- Data that needs transformation before display

### ⚠️ Memoize Parameters to Prevent Infinite Loops

```typescript
// ❌ WRONG - creates new object every render → infinite refetch loop
const { data } = useAnalyticsQuery('query', { id: sql.string(selectedId) });

// ✅ CORRECT - memoize parameters
const params = useMemo(() => ({ id: sql.string(selectedId) }), [selectedId]);
const { data } = useAnalyticsQuery('query', params);
```

### Conditional Queries

```typescript
// ❌ WRONG - `enabled` is NOT a valid option (this is a React Query pattern)
const { data } = useAnalyticsQuery('query', params, { enabled: !!selectedId });

// ✅ CORRECT - use autoStart: false
const { data } = useAnalyticsQuery('query', params, { autoStart: false });

// ✅ ALSO CORRECT - conditional rendering (component only mounts when data exists)
{selectedId && <DetailsComponent id={selectedId} />}
```

### Type Inference

When `appKitTypes.d.ts` has been generated (via `npm run typegen`), types are inferred automatically:
```typescript
// ✅ After typegen - types are automatic, no generic needed
const { data } = useAnalyticsQuery('my_query', params);

// ⚠️ Before typegen - data is `unknown`, you must provide type manually
const { data } = useAnalyticsQuery<MyRow[]>('my_query', params);
```

**Common mistake** — don't define interfaces that duplicate generated types:
```typescript
// ❌ WRONG - manual interface may conflict with generated QueryRegistry
interface MyData { id: string; value: number; }
const { data } = useAnalyticsQuery<MyData[]>('my_query', params);

// ✅ CORRECT - run `npm run typegen` and let it provide types
const { data } = useAnalyticsQuery('my_query', params);
```

### Basic Usage

```typescript
import { useAnalyticsQuery, Skeleton } from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { useMemo } from 'react';

function CustomDisplay() {
  const params = useMemo(() => ({
    start_date: sql.date('2024-01-01'),
    category: sql.string("tools")
  }), []);

  const { data, loading, error } = useAnalyticsQuery('query_name', params);

  if (loading) return <Skeleton className="h-4 w-3/4" />;
  if (error) return <div className="text-destructive">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="grid gap-4">
      {data.map(row => (
        <div key={row.column_name} className="p-4 border rounded">
          <h3>{row.column_name}</h3>
          <p>{Number(row.value).toFixed(2)}</p>
        </div>
      ))}
    </div>
  );
}
```
