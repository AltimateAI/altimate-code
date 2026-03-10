# AppKit Overview

AppKit is the recommended way to build Databricks Apps - provides type-safe SQL queries, React components, and seamless deployment.

## Choose Your Data Pattern FIRST

Before scaffolding, decide which data pattern the app needs:

| Pattern | When to use | Init command |
|---------|-------------|-------------|
| **Analytics** (read-only) | Dashboards, charts, KPIs from warehouse | `--features analytics --set analytics.sql-warehouse.id=<ID>` |
| **Lakebase (OLTP)** (read/write) | CRUD forms, persistent state, user data | `--features lakebase --set lakebase.postgres.branch=<BRANCH> --set lakebase.postgres.database=<DB>` |
| **Both** | Dashboard + user data or preferences | `--features analytics,lakebase` with all required `--set` flags |

See [Lakebase Guide](lakebase.md) for full Lakebase scaffolding and app-code patterns.

## Workflow

1. **Scaffold**: Run `databricks apps manifest`, then `databricks apps init` with `--features` and `--set` as in parent SKILL.md (App Manifest and Scaffolding)
2. **Develop**: `cd <NAME> && npm install && npm run dev`
3. **Validate**: `databricks apps validate`
4. **Deploy**: `databricks apps deploy --profile <PROFILE>`

## Data Discovery (Before Writing SQL)

**Use the parent `databricks` skill for data discovery** (table search, schema exploration, query execution).

## Pre-Implementation Checklist

Before writing App.tsx, complete these steps:

1. ✅ Create SQL files in `config/queries/`
2. ✅ Run `npm run typegen` to generate query types
3. ✅ Read `client/src/appKitTypes.d.ts` to see available query result types
4. ✅ Verify component props via `npx @databricks/appkit docs` (check the relevant component page)
5. ✅ Plan smoke test updates (default expects "Minimal Databricks App")

**DO NOT** write UI code until types are generated and verified.

## Post-Implementation Checklist

Before running `databricks apps validate`:

1. ✅ Update `tests/smoke.spec.ts` heading selector to match your app title
2. ✅ Update or remove the 'hello world' text assertion
3. ✅ Verify `npm run typegen` has been run after all SQL files are finalized
4. ✅ Ensure all numeric SQL values use `Number()` conversion in display code

## Project Structure

```
my-app/
├── server/
│   ├── server.ts             # Backend entry point (AppKit)
│   └── .env                  # Optional local dev env vars (do not commit)
├── client/
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       └── App.tsx           # <- Main app component (start here)
├── config/
│   └── queries/
│       └── my_query.sql      # -> queryKey: "my_query"
├── app.yaml                  # Deployment config
├── package.json
└── tsconfig.json
```

**Key files to modify:**
| Task | File |
|------|------|
| Build UI | `client/src/App.tsx` |
| Add SQL query | `config/queries/<NAME>.sql` |
| Add API endpoint | `server/server.ts` (tRPC) |
| Add shared helpers (optional) | create `shared/types.ts` or `client/src/lib/formatters.ts` |
| Fix smoke test | `tests/smoke.spec.ts` |

## Type Safety

For type generation details, see: `npx @databricks/appkit docs ./docs/development/type-generation.md`

**Quick workflow:**
1. Add/modify SQL in `config/queries/`
2. Types auto-generate during dev via the Vite plugin (or run `npm run typegen` manually)
3. Types appear in `client/src/appKitTypes.d.ts`

## Adding Visualizations

**Step 1**: Create SQL file `config/queries/my_data.sql`
```sql
SELECT category, COUNT(*) as count FROM my_table GROUP BY category
```

**Step 2**: Use component (types auto-generated!)
```typescript
import { BarChart } from '@databricks/appkit-ui/react';
// Query mode: fetches data automatically
<BarChart queryKey="my_data" parameters={{}} />

// Data mode: pass static data directly (no queryKey/parameters needed)
<BarChart data={myData} xKey="category" yKey="count" />
```

## AppKit Official Documentation

**Always use AppKit docs as the source of truth for API details.**

```bash
npx @databricks/appkit docs                              # show the docs index (start here)
npx @databricks/appkit docs <query>                      # look up a section by name or doc path
```

Do not guess paths — run without args first, then pick from the index.

## References

| When you're about to... | Read |
|-------------------------|------|
| Write SQL files | [SQL Queries](sql-queries.md) — parameterization, dialect, sql.* helpers |
| Use `useAnalyticsQuery` | [AppKit SDK](appkit-sdk.md) — memoization, conditional queries |
| Add chart/table components | [Frontend](frontend.md) — component quick reference, anti-patterns |
| Add API mutation endpoints | [tRPC](trpc.md) — only if you need server-side logic |
| Use Lakebase for CRUD / persistent state | [Lakebase](lakebase.md) — createLakebasePool, tRPC patterns, schema init |

## Critical Rules

1. **SQL for data retrieval**: Use `config/queries/` + visualization components. Never tRPC for SELECT.
2. **Numeric types**: SQL numbers may return as strings. Always convert: `Number(row.amount)`
3. **Type imports**: Use `import type { ... }` (verbatimModuleSyntax enabled).
4. **Charts are ECharts**: No Recharts children — use props (`xKey`, `yKey`, `colors`). `xKey`/`yKey` auto-detect from schema if omitted.
5. **Two data modes**: Charts/tables support query mode (`queryKey` + `parameters`) and data mode (static `data` prop).
6. **Conditional queries**: Use `autoStart: false` option or conditional rendering to control query execution.

## Decision Tree

- **Display data from SQL?**
  - Chart/Table → `BarChart`, `LineChart`, `DataTable` components
  - Custom layout (KPIs, cards) → `useAnalyticsQuery` hook
- **Call Databricks API?** → tRPC (serving endpoints, MLflow, Jobs)
- **Modify data?** → tRPC mutations
