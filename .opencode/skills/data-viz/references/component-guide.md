# Component Library Reference

Non-obvious patterns, gotchas, and custom implementations. Standard library usage (basic bar/line/area/pie/scatter) is well-documented — this covers what agents get wrong or can't infer.

## Table of Contents

1. [shadcn/ui Charts](#shadcnui-charts) — Config pattern & key rules
2. [Tremor Essentials](#tremor-essentials) — KPI cards, dashboard grid
3. [Nivo Gotchas](#nivo-gotchas) — Height wrapper, common props
4. [D3 + React Pattern](#d3--react-pattern) — Force-directed DAG
5. [Layout Patterns](#layout-patterns) — Dashboard grid, card component
6. [Color Systems](#color-systems) — Semantic, sequential, diverging, categorical
7. [Data Transformations](#data-transformations) — Recharts pivot, KPI aggregate, treemap, time bucketing
8. [Waterfall Chart](#waterfall-chart) — Custom Recharts pattern
9. [Radar / Spider Chart](#radar--spider-chart) — Key rules
10. [Calendar Heatmap](#calendar-heatmap) — Nivo setup
11. [Annotation Patterns](#annotation-patterns) — Goal lines, highlights, callouts, anomaly dots

---

## shadcn/ui Charts

Built on Recharts with themed, accessible wrappers. **Unique config pattern — don't skip this.**

```tsx
import { type ChartConfig } from "@/components/ui/chart"

const chartConfig = {
  revenue: { label: "Revenue", color: "hsl(var(--chart-1))" },
  expenses: { label: "Expenses", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig
```

**Key rules:**
- Always `min-h-[VALUE]` on `ChartContainer` (required for responsiveness)
- Use `accessibilityLayer` prop on the main chart component
- Colors via CSS variables `var(--color-{key})`, never hardcoded
- Use `ChartTooltip` + `ChartTooltipContent`, not Recharts defaults
- Use `ChartLegend` + `ChartLegendContent` for interactive legends

### Area Chart Gradient (common pattern)

```tsx
<defs>
  <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
    <stop offset="5%" stopColor="var(--color-revenue)" stopOpacity={0.8} />
    <stop offset="95%" stopColor="var(--color-revenue)" stopOpacity={0.1} />
  </linearGradient>
</defs>
<Area type="monotone" dataKey="revenue" stroke="var(--color-revenue)" fill="url(#fillRevenue)" />
```

---

## Tremor Essentials

### KPI Card Pattern

```tsx
import { Card, BadgeDelta, SparkAreaChart } from "@tremor/react"

<Card className="max-w-sm">
  <div className="flex items-center justify-between">
    <p className="text-tremor-default text-tremor-content">Revenue</p>
    <BadgeDelta deltaType="increase" size="xs">+12.3%</BadgeDelta>
  </div>
  <p className="text-tremor-metric font-semibold mt-1">$1.24M</p>
  <SparkAreaChart data={sparkData} categories={["value"]} index="date"
    colors={["emerald"]} className="h-8 w-full mt-4" />
</Card>
```

### Dashboard Grid

```tsx
<div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
  {kpis.map(kpi => <KPICard key={kpi.id} {...kpi} />)}
</div>
```

### Tremor AreaChart / BarList

```tsx
<AreaChart data={data} index="month" categories={["Revenue", "Expenses"]}
  colors={["blue", "red"]} valueFormatter={(v) => `$${(v/1000).toFixed(0)}k`}
  className="h-72 mt-4" showAnimation />

<BarList data={[{ name: "Google", value: 45632 }, ...]} className="mt-4" />
```

---

## Nivo Gotchas

- **Always set `height` on the wrapper div**, not on the Nivo component: `<div style={{ height: 400 }}><ResponsiveHeatMap ... /></div>`
- Use `emptyColor="#f3f4f6"` for missing data cells
- For heatmaps: `colors={{ type: "sequential", scheme: "blues" }}`
- For treemaps: `identity="name"` + `value="value"` + `labelSkipSize={12}`
- For Sankey: `enableLinkGradient` + `linkBlendMode="multiply"` for polish
- For Choropleth: needs GeoJSON features, `projectionScale={150}`, `projectionTranslation={[0.5, 0.5]}`

---

## D3 + React Pattern: Force-Directed DAG

Use for lineage graphs, dependency trees, pipeline DAGs. **D3 computes positions, React renders SVG.**

```tsx
import { useEffect, useRef } from "react"
import * as d3 from "d3"

interface DagNode { id: string; label: string; type: "source" | "middle" | "output" }
interface DagLink { source: string; target: string }

const NODE_COLORS: Record<DagNode["type"], { fill: string; stroke: string }> = {
  source: { fill: "#dbeafe", stroke: "#3b82f6" },
  middle: { fill: "#f1f5f9", stroke: "#94a3b8" },
  output: { fill: "#dcfce7", stroke: "#22c55e" },
}

export function ForceDAG({ nodes, links }: { nodes: DagNode[]; links: DagLink[] }) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!svgRef.current) return
    const width = svgRef.current.clientWidth || 800, height = 500
    const svg = d3.select(svgRef.current).attr("height", height)
    svg.selectAll("*").remove()

    // Arrowhead marker
    svg.append("defs").append("marker")
      .attr("id", "dag-arrow").attr("viewBox", "0 -5 10 10")
      .attr("refX", 22).attr("refY", 0)
      .attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
      .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#94a3b8")

    // CRITICAL: Copy arrays — D3 mutates them with x/y/vx/vy
    const nodesCopy = nodes.map(n => ({ ...n }))
    const linksCopy = links.map(l => ({ ...l }))

    const sim = d3.forceSimulation(nodesCopy as any)
      .force("link", d3.forceLink(linksCopy).id((d: any) => d.id).distance(140))
      .force("charge", d3.forceManyBody().strength(-350))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(50))

    const linkSel = svg.append("g").selectAll("line")
      .data(linksCopy).join("line")
      .attr("stroke", "#cbd5e1").attr("stroke-width", 1.5)
      .attr("marker-end", "url(#dag-arrow)")

    const nodeSel = svg.append("g").selectAll<SVGGElement, DagNode>("g")
      .data(nodesCopy).join("g")
      .call(d3.drag<SVGGElement, any>()
        .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y })
        .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null }))

    nodeSel.append("rect").attr("x", -54).attr("y", -18)
      .attr("width", 108).attr("height", 36).attr("rx", 6)
      .attr("fill", (d: any) => NODE_COLORS[d.type].fill)
      .attr("stroke", (d: any) => NODE_COLORS[d.type].stroke).attr("stroke-width", 1.5)

    nodeSel.append("text").attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("font-size", 11).attr("fill", "#374151")
      .text((d: any) => d.label.length > 16 ? d.label.slice(0, 15) + "…" : d.label)

    sim.on("tick", () => {
      linkSel.attr("x1", (d: any) => d.source.x).attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x).attr("y2", (d: any) => d.target.y)
      nodeSel.attr("transform", (d: any) => `translate(${d.x},${d.y})`)
    })
    return () => { sim.stop() }
  }, [nodes, links])

  return <svg ref={svgRef} className="w-full" style={{ minHeight: 500 }} />
}
```

**Rules:** Always copy nodes/links before D3. Use `clientWidth` for responsive width. Truncate labels, show full on hover. `alphaTarget(0)` on drag end lets sim cool naturally.

---

## Layout Patterns

### Dashboard Grid (Tailwind)

```tsx
<div className="min-h-screen bg-background p-6">
  <div className="mb-8 flex items-center justify-between">
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
      <p className="text-muted-foreground">Your performance overview</p>
    </div>
    <DateRangePicker />
  </div>
  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
    {kpis.map(kpi => <KPICard key={kpi.id} {...kpi} />)}
  </div>
  <div className="grid gap-4 md:grid-cols-7 mb-8">
    <Card className="col-span-4">{/* Primary chart */}</Card>
    <Card className="col-span-3">{/* Secondary chart */}</Card>
  </div>
  <Card>{/* DataTable */}</Card>
</div>
```

### shadcn-style Card

```tsx
<div className="rounded-xl border bg-card p-6 shadow-sm">
  <div className="flex items-center justify-between">
    <p className="text-sm font-medium text-muted-foreground">{title}</p>
    <Icon className="h-4 w-4 text-muted-foreground" />
  </div>
  <div className="mt-2">
    <p className="text-2xl font-bold">{value}</p>
    <p className={cn("text-xs mt-1", delta > 0 ? "text-green-600" : "text-red-600")}>
      {delta > 0 ? "+" : ""}{delta}% from last period
    </p>
  </div>
</div>
```

---

## Color Systems

**Semantic (default):**
```css
--chart-1: 221.2 83.2% 53.3%;  /* Blue */
--chart-2: 142.1 76.2% 36.3%;  /* Green */
--chart-3: 24.6 95% 53.1%;     /* Orange */
--chart-4: 346.8 77.2% 49.8%;  /* Red */
--chart-5: 262.1 83.3% 57.8%;  /* Purple */
```

**Sequential** (heatmaps/gradients): Single hue light→dark. Tailwind `blue-100`→`blue-900` or Nivo schemes: `blues`, `greens`, `oranges`.

**Diverging** (+/- values): Red ↔ White ↔ Green, or Red ↔ Grey ↔ Blue. Center on zero.

**Categorical** (distinct groups): Max 7. Tailwind `500` shades: `blue`, `emerald`, `amber`, `rose`, `violet`, `cyan`, `orange`.

---

## Data Transformations

### Pivot for Recharts

Recharts needs flat arrays with all series as keys per data point:

```ts
// { date, category, value } rows → { date, cat_A: val, cat_B: val }
const pivoted = _.chain(rawData).groupBy("date")
  .map((items, date) => ({ date, ..._.fromPairs(items.map(i => [i.category, i.value])) }))
  .value()
```

### KPI Aggregation

```ts
const kpis = {
  total: _.sumBy(data, "revenue"), average: _.meanBy(data, "revenue"),
  max: _.maxBy(data, "revenue"), count: data.length,
  growth: ((current - previous) / previous * 100).toFixed(1),
}
```

### Flat → Hierarchical (Treemaps)

```ts
const tree = { name: "root", children: _.chain(data).groupBy("category")
  .map((items, name) => ({ name, children: items.map(i => ({ name: i.label, value: i.amount })) })).value() }
```

### Time Bucketing

```ts
import { format, startOfWeek } from "date-fns"
const weekly = _.chain(data).groupBy(d => format(startOfWeek(new Date(d.date)), "yyyy-MM-dd"))
  .map((items, week) => ({ week, total: _.sumBy(items, "value"), count: items.length })).value()
```

---

## Waterfall Chart

Recharts has no native waterfall. Use stacked Bar with invisible spacer:

```tsx
function toWaterfallSeries(items: { name: string; value: number }[]) {
  let running = 0
  return items.map(item => {
    const start = item.value >= 0 ? running : running + item.value
    running += item.value
    return { name: item.name, value: Math.abs(item.value), start, _raw: item.value }
  })
}

// In ComposedChart:
<Bar dataKey="start" stackId="wf" fill="transparent" isAnimationActive={false} />
<Bar dataKey="value" stackId="wf" radius={[4,4,0,0]}>
  {data.map((e, i) => <Cell key={i} fill={e._raw >= 0 ? "#22c55e" : "#ef4444"} />)}
</Bar>
```

**Critical:** Spacer bar must have `isAnimationActive={false}` (animating it reveals the trick). Hide spacer from tooltip by returning `null` in formatter. For "total" bar: `start: 0`, `value: runningTotal`, distinct color (slate).

---

## Radar / Spider Chart

```tsx
<RadarChart cx="50%" cy="50%" outerRadius="75%" data={data}>
  <PolarGrid stroke="#e2e8f0" />
  <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 12, fill: "#64748b" }} />
  <PolarRadiusAxis angle={90} domain={[0, 100]} tickCount={5} />
  <Radar name="Current" dataKey="score" stroke="#6366f1" fill="#6366f1" fillOpacity={0.25} strokeWidth={2} />
  <Radar name="Benchmark" dataKey="benchmark" stroke="#e2e8f0" fill="none" strokeDasharray="5 3" strokeWidth={1.5} />
  <Tooltip /><Legend />
</RadarChart>
```

**Rules:** `domain={[0, 100]}` for consistent comparison. Dashed benchmark gives context. Max 2 series.

---

## Calendar Heatmap

```tsx
import { ResponsiveCalendar } from "@nivo/calendar"

<div style={{ height: 200 }}>
  <ResponsiveCalendar data={data} from={from} to={to}
    emptyColor="#f8fafc" colors={["#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"]}
    margin={{ top: 24, right: 20, bottom: 8, left: 20 }}
    yearSpacing={40} dayBorderWidth={2} dayBorderColor="#ffffff" />
</div>
```

**Rules:** Height on wrapper div, not component. Single-hue sequential palette. `emptyColor` near-white for sparse data.

---

## Annotation Patterns

Annotations turn charts into stories. **Limit 3 per chart.**

**Color by type:** amber `#f59e0b` = target/goal, red `#ef4444` = incident/risk, indigo `#6366f1` = event/release, green `#22c55e` = achievement.

### Goal/Threshold Line

```tsx
<ReferenceLine y={targetValue} stroke="#f59e0b" strokeDasharray="6 3" strokeWidth={1.5}
  label={{ value: `Target: ${targetValue.toLocaleString()}`, position: "insideTopRight", fontSize: 11, fill: "#f59e0b" }} />
```

### Time Range Highlight

```tsx
<ReferenceArea x1={start} x2={end} fill="#fee2e2" fillOpacity={0.5}
  label={{ value: "Incident", position: "insideTopLeft", fontSize: 10, fill: "#ef4444" }} />
```

### Floating Callout Label

```tsx
const CalloutLabel = ({ viewBox, label, color = "#1e293b" }: { viewBox?: { x: number; y: number }; label: string; color?: string }) => {
  if (!viewBox) return null
  const { x, y } = viewBox, w = label.length * 7 + 16
  return (<g>
    <rect x={x - w/2} y={y - 34} width={w} height={20} rx={4} fill={color} />
    <text x={x} y={y - 20} textAnchor="middle" fontSize={11} fill="white" fontWeight={500}>{label}</text>
    <line x1={x} y1={y - 14} x2={x} y2={y} stroke={color} strokeWidth={1} />
  </g>)
}
// Usage: <ReferenceLine x={date} stroke="#6366f1" strokeDasharray="4 4" label={<CalloutLabel label="v2.0 shipped" color="#6366f1" />} />
```

### Anomaly Dot Highlight

```tsx
<Line dataKey="value" strokeWidth={2} dot={(props) => {
  const { cx, cy, payload, key } = props
  if (!payload?.isAnomaly) return <circle key={key} cx={cx} cy={cy} r={3} fill="#6366f1" />
  return (<g key={key}>
    <circle cx={cx} cy={cy} r={10} fill="#ef4444" opacity={0.15} />
    <circle cx={cx} cy={cy} r={4} fill="#ef4444" />
    <text x={cx} y={cy - 14} textAnchor="middle" fontSize={11} fill="#ef4444">▲</text>
  </g>)
}} />
```

**Rules:** Never overlap data. Use `position: "insideTopRight"/"insideTopLeft"` on labels. Pair annotations with tooltips — annotation names the event, tooltip shows the value.

---

## Multi-Tab Dashboard — Lazy Chart Initialization

Charts initialized inside a hidden container (`display:none`) render blank. Chart.js, Recharts, and Nivo all read container dimensions at mount time — a hidden container measures as `0×0`.

**Rule: never initialize a chart until its container is visible.**

```js
// Vanilla JS pattern
var _inited = {};

function activateTab(name) {
  // 1. make the tab visible first
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  // 2. then initialize charts — only on first visit
  if (!_inited[name]) {
    _inited[name] = true;
    initChartsFor(name);
  }
}

activateTab('overview'); // init the default visible tab on page load
```

Library-specific notes:
- **Chart.js**: canvas reads as `0×0` inside `display:none` — bars/lines never appear
- **Recharts `ResponsiveContainer`**: reads `clientWidth = 0` — chart collapses to nothing
- **Nivo `Responsive*`**: uses `ResizeObserver` via `useMeasure`/`useDimensions` in `@nivo/core` — initially measures `0×0` when hidden and skips rendering; re-measures and re-renders correctly when container becomes visible, but the initial blank frame can cause a flash
- **React conditional rendering**: prefer `visibility:hidden` + `position:absolute` over toggling `display:none` if you want charts to stay mounted and pre-rendered

---

## Programmatic Dashboard Generation — Data-Code Separation

When generating a standalone HTML dashboard from a script (Python, shell, etc.), never embed JSON data inside a template string that also contains JavaScript. Curly-brace collisions in f-strings / template literals cause silent JS parse failures that are hard to debug.

**Wrong** — data and JS logic share one f-string, every `{` in JS must be escaped as `{{`:

```python
html = f"""
<script>
  const data = {json.dumps(data)};          // fine
  const fn = () => {{ return x; }}           // must escape — easy to miss
  const obj = {{ key: getValue() }};         // one missed escape = blank page
</script>
"""
```

**Right** — separate data from logic entirely:

```python
# Step 1: write data to its own file — no template string needed
with open('data.js', 'w') as f:
    f.write('const DATA = ' + json.dumps(data) + ';')

# Step 2: HTML loads both files; app.js is static and never needs escaping
```

```html
<script src="data.js"></script>   <!-- generated, data only -->
<script src="app.js"></script>    <!-- static, logic only   -->
```

Benefits: `app.js` is static and independently testable; `data.js` is regenerated without touching logic; no escaping required in either file.
