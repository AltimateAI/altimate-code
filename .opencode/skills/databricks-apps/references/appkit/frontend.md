# Frontend Guidelines

**For full component API**: run `npx @databricks/appkit docs` and navigate to the component you need.

## Common Anti-Patterns

These mistakes appear frequently — check the official docs for actual prop names:

| Mistake | Why it's wrong | What to do |
|---------|---------------|------------|
| `xAxisKey`, `dataKey` on charts | Recharts naming, not AppKit | Use `xKey`, `yKey` (auto-detected from schema if omitted) |
| `yAxisKeys`, `yKeys` on charts | Recharts naming | Use `yKey` (string or string[]) |
| `config` on charts | Not a valid prop name | Use `options` for ECharts overrides |
| `<XAxis>`, `<YAxis>` children | AppKit charts are ECharts-based, NOT Recharts wrappers — configure via props only |  |
| `columns` on DataTable | DataTable auto-generates columns from data | Use `queryKey` + `parameters`; use `transform` for formatting |
| Double-fetching with `useAnalyticsQuery` + chart component | Components handle their own fetching | Just pass `queryKey` to the component |

**Always verify props against docs before using a component.**

## Chart Data Modes

All chart/data components support two modes:

- **Query mode**: pass `queryKey` + `parameters` — component fetches data automatically. `parameters` is REQUIRED even if empty (`parameters={{}}`).
- **Data mode**: pass static data via `data` prop (JSON array or Arrow Table) — no `queryKey`/`parameters` needed.

```tsx
// Query mode (recommended for Databricks SQL)
<BarChart queryKey="sales_by_region" parameters={{}} />

// Data mode (static/pre-fetched data)
<BarChart data={myData} xKey="category" yKey="count" />
```

## Chart Props Quick Reference

All charts accept these core props (verify full list via `npx @databricks/appkit docs`):

```tsx
<BarChart
  queryKey="sales_by_region"   // SQL query filename without .sql
  parameters={{}}              // query params — REQUIRED in query mode, even if empty
  xKey="region"                // X axis field (auto-detected from schema if omitted)
  yKey="revenue"               // Y axis field(s) — string or string[] (auto-detected if omitted)
  format="auto"                // "json" | "arrow" | "auto" (default: "auto")
  transformer={(d) => d}       // transform raw data before rendering
  colors={['#40d1f5']}         // custom colors (overrides colorPalette)
  colorPalette="categorical"   // "categorical" | "sequential" | "diverging"
  title="Sales by Region"      // chart title
  showLegend                   // show legend
  options={{}}                 // additional ECharts options to merge
  height={400}                 // default: 300
  orientation="vertical"       // "vertical" | "horizontal" (BarChart/LineChart/AreaChart)
  stacked                      // stack bars/areas (BarChart/AreaChart)
/>

<LineChart queryKey="monthly_trend" parameters={{}} xKey="month" yKey={["revenue", "expenses"]}
  smooth showSymbol={false} />
```

Charts are **ECharts-based** — configure via props, not Recharts-style children. Components handle data fetching, loading, and error states internally.

> ⚠️ **`parameters` is REQUIRED on all data components**, even when the query has no params. Always include `parameters={{}}`.

```typescript
// ❌ Don't double-fetch
const { data } = useAnalyticsQuery('sales_data', {});
return <BarChart queryKey="sales_data" parameters={{}} />;  // fetches again!
```

## DataTable

DataTable auto-generates columns from data and handles fetching, loading, error, and empty states.

**For full props**: `npx @databricks/appkit docs "DataTable"`.

```tsx
// ❌ WRONG - missing required `parameters` prop
<DataTable queryKey="my_query" />

// ✅ CORRECT - minimal
<DataTable queryKey="my_query" parameters={{}} />

// ✅ CORRECT - with filtering and pagination
<DataTable
  queryKey="my_query"
  parameters={{}}
  filterColumn="name"
  filterPlaceholder="Filter by name..."
  pageSize={10}
  pageSizeOptions={[10, 25, 50]}
/>

// ✅ CORRECT - with row selection
<DataTable
  queryKey="my_query"
  parameters={{}}
  enableRowSelection
  onRowSelectionChange={(selection) => console.log(selection)}
/>
```

**Custom column formatting** — use the `transform` prop or format in SQL:

```typescript
<DataTable
  queryKey="products"
  parameters={{}}
  transform={(data) => data.map(row => ({
    ...row,
    price: `$${Number(row.price).toFixed(2)}`,
  }))}
/>
```

## Available Components (Quick Reference)

**For full prop details**: `npx @databricks/appkit docs "appkit-ui API reference"`.

All data components support both query mode (`queryKey` + `parameters`) and data mode (static `data` prop). Common props across all charts: `format`, `transformer`, `colors`, `colorPalette`, `title`, `showLegend`, `height`, `options`, `ariaLabel`, `testId`.

### Data Components (`@databricks/appkit-ui/react`)

| Component | Extra Props | Use For |
|-----------|-------------|---------|
| `BarChart` | `xKey`, `yKey`, `orientation`, `stacked` | Categorical comparisons |
| `LineChart` | `xKey`, `yKey`, `smooth`, `showSymbol`, `orientation` | Time series, trends |
| `AreaChart` | `xKey`, `yKey`, `smooth`, `showSymbol`, `stacked`, `orientation` | Cumulative/stacked trends |
| `PieChart` | `xKey`, `yKey`, `innerRadius`, `showLabels`, `labelPosition` | Part-of-whole |
| `DonutChart` | `xKey`, `yKey`, `innerRadius`, `showLabels`, `labelPosition` | Donut (pie with inner radius) |
| `ScatterChart` | `xKey`, `yKey`, `symbolSize` | Correlation, distribution |
| `HeatmapChart` | `xKey`, `yKey`, `yAxisKey`, `min`, `max`, `showLabels` | Matrix-style data |
| `RadarChart` | `xKey`, `yKey`, `showArea` | Multi-dimensional comparison |
| `DataTable` | `filterColumn`, `filterPlaceholder`, `transform`, `pageSize`, `enableRowSelection`, `children` | Tabular data display |

### UI Components (`@databricks/appkit-ui/react`)

| Component | Common Props |
|-----------|-------------|
| `Card`, `CardHeader`, `CardTitle`, `CardContent` | Standard container |
| `Badge` | `variant`: "default" \| "secondary" \| "destructive" \| "outline" |
| `Button` | `variant`, `size`, `onClick` |
| `Input` | `placeholder`, `value`, `onChange` |
| `Select`, `SelectTrigger`, `SelectContent`, `SelectItem` | Dropdown; `SelectItem` value cannot be "" |
| `Skeleton` | `className` — use for loading states |
| `Separator` | Visual divider |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Tabbed interface |

All data components **require `parameters={{}}`** even when the query has no params.

## Layout Structure

```tsx
<div className="container mx-auto p-4">
  <h1 className="text-2xl font-bold mb-4">Page Title</h1>
  <form className="space-y-4 mb-8">{/* form inputs */}</form>
  <div className="grid gap-4">{/* list items */}</div>
</div>
```

## Component Organization

- Shared UI components: `@databricks/appkit-ui/react`
- Feature components: `client/src/components/FeatureName.tsx`
- Split components when logic exceeds ~100 lines or component is reused

## Gotchas

- `SelectItem` cannot have `value=""`. Use sentinel value like `"all"` for "show all" options.
- Use `<Skeleton>` components instead of plain "Loading..." text
- Handle nullable fields: `value={field || ''}` for inputs
- For maps with React 19, use react-leaflet v5: `npm install react-leaflet@^5.0.0 leaflet @types/leaflet`

Databricks brand colors: `['#40d1f5', '#4462c9', '#EB1600', '#0B2026', '#4A4A4A', '#353a4a']`
