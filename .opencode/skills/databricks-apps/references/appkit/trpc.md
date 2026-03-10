# tRPC for Custom Endpoints

**CRITICAL**: Do NOT use tRPC for SQL queries or data retrieval. Use `config/queries/` + `useAnalyticsQuery` instead.

Use tRPC ONLY for:

- **Mutations**: Creating, updating, or deleting data (INSERT, UPDATE, DELETE)
- **External APIs**: Calling Databricks APIs (serving endpoints, jobs, MLflow, etc.)
- **Complex business logic**: Multi-step operations that cannot be expressed in SQL
- **File operations**: File uploads, processing, transformations
- **Custom computations**: Operations requiring TypeScript/Node.js logic

## Server-side Pattern

```typescript
// server/trpc.ts
import { initTRPC } from '@trpc/server';
import { getExecutionContext } from '@databricks/appkit';
import { z } from 'zod';
import superjson from 'superjson';

const t = initTRPC.create({ transformer: superjson });
const publicProcedure = t.procedure;

export const appRouter = t.router({
  // Example: Query a serving endpoint
  queryModel: publicProcedure.input(z.object({ prompt: z.string() })).query(async ({ input: { prompt } }) => {
    const { serviceDatabricksClient: client } = getExecutionContext();
    const response = await client.servingEndpoints.query({
      name: 'your-endpoint-name',
      messages: [{ role: 'user', content: prompt }],
    });
    return response;
  }),

  // Example: Mutation
  createRecord: publicProcedure.input(z.object({ name: z.string() })).mutation(async ({ input }) => {
    // Custom logic here
    return { success: true, id: 123 };
  }),
});
```

## Client-side Pattern

```typescript
// client/src/components/MyComponent.tsx
import { trpc } from '@/lib/trpc';
import { useState, useEffect } from 'react';

function MyComponent() {
  const [result, setResult] = useState(null);

  useEffect(() => {
    trpc.queryModel
      .query({ prompt: "Hello" })
      .then(setResult)
      .catch(console.error);
  }, []);

  const handleCreate = async () => {
    await trpc.createRecord.mutate({ name: "test" });
  };

  return <div>{/* component JSX */}</div>;
}
```

## Decision Tree for Data Operations

1. **Need to display data from SQL?**
   - **Chart or Table?** → Use visualization components (`BarChart`, `LineChart`, `DataTable`, etc.)
   - **Custom display (KPIs, cards, lists)?** → Use `useAnalyticsQuery` hook
   - **Never** use tRPC for SQL SELECT statements

2. **Need to call a Databricks API?** → Use tRPC
   - Serving endpoints (model inference)
   - MLflow operations
   - Jobs API
   - Workspace API

3. **Need to modify data?** → Use tRPC mutations
   - INSERT, UPDATE, DELETE operations
   - Multi-step transactions
   - Business logic with side effects

4. **Need non-SQL custom logic?** → Use tRPC
   - File processing
   - External API calls
   - Complex computations in TypeScript

**Summary:**
- ✅ SQL queries → Visualization components or `useAnalyticsQuery`
- ✅ Databricks APIs → tRPC
- ✅ Data mutations → tRPC
- ❌ SQL queries → tRPC (NEVER do this)
