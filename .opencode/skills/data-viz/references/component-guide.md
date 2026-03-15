# Component Library Reference Guide

Detailed patterns, code snippets, and API references for building AI-first data
visualizations. Read the section relevant to your chosen library.

## Table of Contents

1. [shadcn/ui Charts](#shadcnui-charts)
2. [Recharts Patterns](#recharts-patterns)
3. [Tremor Dashboard Components](#tremor-dashboard-components)
4. [Nivo Advanced Charts](#nivo-advanced-charts)
5. [D3.js Custom Visualizations](#d3js-custom-visualizations)
6. [visx Low-Level Primitives](#visx-low-level-primitives)
7. [Layout Patterns](#layout-patterns)
8. [Color Systems](#color-systems)
9. [Data Transformation Patterns](#data-transformation-patterns)
10. [Force-Directed DAG](#force-directed-dag)
11. [Radar / Spider Chart](#radar--spider-chart)
12. [Calendar Heatmap](#calendar-heatmap)
13. [Waterfall Chart](#waterfall-chart)
14. [Annotation Patterns](#annotation-patterns)

---

## shadcn/ui Charts

shadcn/ui charts are built on top of Recharts and provide themed, accessible
chart components that integrate with the shadcn design system.

### Core Concepts

- **ChartContainer**: Wraps every chart. Accepts a `config` object and handles
  theming, responsive sizing, and accessibility.
- **ChartConfig**: Defines labels, colors, and icons for each data series.
  Decoupled from data — reusable across charts.
- **ChartTooltip / ChartTooltipContent**: Custom tooltip components styled to
  match the design system.
- **ChartLegend / ChartLegendContent**: Interactive legend with toggle behavior.

### Config Pattern

```tsx
import { type ChartConfig } from "@/components/ui/chart"

const chartConfig = {
  revenue: {
    label: "Revenue",
    color: "hsl(var(--chart-1))",
  },
  expenses: {
    label: "Expenses",
    color: "hsl(var(--chart-2))",
  },
} satisfies ChartConfig
```

### Bar Chart

```tsx
<ChartContainer config={chartConfig} className="min-h-[300px] w-full">
  <BarChart accessibilityLayer data={data}>
    <CartesianGrid vertical={false} />
    <XAxis
      dataKey="month"
      tickLine={false}
      tickMargin={10}
      axisLine={false}
      tickFormatter={(v) => v.slice(0, 3)}
    />
    <ChartTooltip content={<ChartTooltipContent />} />
    <ChartLegend content={<ChartLegendContent />} />
    <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
    <Bar dataKey="expenses" fill="var(--color-expenses)" radius={4} />
  </BarChart>
</ChartContainer>
```

### Area Chart with Gradient

```tsx
<ChartContainer config={chartConfig} className="min-h-[300px] w-full">
  <AreaChart data={data}>
    <defs>
      <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
        <stop offset="5%" stopColor="var(--color-revenue)" stopOpacity={0.8} />
        <stop offset="95%" stopColor="var(--color-revenue)" stopOpacity={0.1} />
      </linearGradient>
    </defs>
    <CartesianGrid vertical={false} />
    <XAxis dataKey="date" tickLine={false} axisLine={false} />
    <ChartTooltip content={<ChartTooltipContent />} />
    <Area
      type="monotone"
      dataKey="revenue"
      stroke="var(--color-revenue)"
      fill="url(#fillRevenue)"
    />
  </AreaChart>
</ChartContainer>
```

### Key Rules

- Always set `min-h-[VALUE]` on ChartContainer (required for responsiveness)
- Use `accessibilityLayer` prop on the main chart component
- Use CSS variables `var(--color-{key})` for colors, not hardcoded values
- Use `ChartTooltip` + `ChartTooltipContent` instead of Recharts' default

---

## Recharts Patterns

When using Recharts directly (without shadcn wrapper), follow these patterns.

### Composed Chart (Multiple Series Types)

```tsx
<ResponsiveContainer width="100%" height={400}>
  <ComposedChart data={data}>
    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
    <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
    <Tooltip
      contentStyle={{
        backgroundColor: "hsl(var(--background))",
        border: "1px solid hsl(var(--border))",
        borderRadius: "8px",
      }}
    />
    <Bar yAxisId="left" dataKey="revenue" fill="#3b82f6" radius={[4,4,0,0]} />
    <Line yAxisId="right" dataKey="growth" stroke="#10b981" strokeWidth={2} />
  </ComposedChart>
</ResponsiveContainer>
```

### Pie / Donut Chart

```tsx
<ResponsiveContainer width="100%" height={300}>
  <PieChart>
    <Pie
      data={data}
      cx="50%"
      cy="50%"
      innerRadius={60}   // > 0 = donut
      outerRadius={100}
      paddingAngle={2}
      dataKey="value"
    >
      {data.map((entry, i) => (
        <Cell key={i} fill={COLORS[i % COLORS.length]} />
      ))}
    </Pie>
    <Tooltip />
    <Legend />
  </PieChart>
</ResponsiveContainer>
```

### Scatter Plot

```tsx
<ResponsiveContainer width="100%" height={400}>
  <ScatterChart>
    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
    <XAxis dataKey="x" name="Revenue" unit="$k" />
    <YAxis dataKey="y" name="Growth" unit="%" />
    <ZAxis dataKey="z" range={[50, 400]} name="Customers" />
    <Tooltip cursor={{ strokeDasharray: "3 3" }} />
    <Scatter data={data} fill="#6366f1" opacity={0.7} />
  </ScatterChart>
</ResponsiveContainer>
```

---

## Tremor Dashboard Components

Tremor excels at complete dashboard layouts with KPI cards, metric displays, and
integrated charts.

### KPI Card

```tsx
import { Card, BadgeDelta, SparkAreaChart } from "@tremor/react"

<Card className="max-w-sm">
  <div className="flex items-center justify-between">
    <p className="text-tremor-default text-tremor-content">Revenue</p>
    <BadgeDelta deltaType="increase" size="xs">+12.3%</BadgeDelta>
  </div>
  <p className="text-tremor-metric font-semibold mt-1">$1.24M</p>
  <SparkAreaChart
    data={sparkData}
    categories={["value"]}
    index="date"
    colors={["emerald"]}
    className="h-8 w-full mt-4"
  />
</Card>
```

### Dashboard Grid

```tsx
<div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
  <KPICard title="Revenue" value="$1.24M" delta="+12.3%" />
  <KPICard title="Users" value="34,521" delta="+8.1%" />
  <KPICard title="Churn" value="2.4%" delta="-0.3%" deltaType="decrease" />
  <KPICard title="NPS" value="72" delta="+5" />
</div>
```

### Area Chart with Tremor

```tsx
import { AreaChart, Card, Title } from "@tremor/react"

<Card>
  <Title>Monthly Revenue</Title>
  <AreaChart
    data={data}
    index="month"
    categories={["Revenue", "Expenses"]}
    colors={["blue", "red"]}
    valueFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
    className="h-72 mt-4"
    showAnimation
  />
</Card>
```

### Bar List (Ranking)

```tsx
import { BarList, Card, Title } from "@tremor/react"

<Card>
  <Title>Top Traffic Sources</Title>
  <BarList
    data={[
      { name: "Google", value: 45632 },
      { name: "Direct", value: 23120 },
      { name: "Twitter", value: 12340 },
      { name: "GitHub", value: 8920 },
    ]}
    className="mt-4"
  />
</Card>
```

### Tracker (Status Grid)

```tsx
import { Tracker } from "@tremor/react"

<Tracker
  data={last30Days.map(d => ({
    color: d.uptime > 99.9 ? "emerald" : d.uptime > 99 ? "yellow" : "red",
    tooltip: `${d.date}: ${d.uptime}%`,
  }))}
  className="mt-2"
/>
```

---

## Nivo Advanced Charts

Nivo is ideal for chart types that shadcn/Recharts don't cover well.

### Heatmap

```tsx
import { ResponsiveHeatMap } from "@nivo/heatmap"

<div style={{ height: 400 }}>
  <ResponsiveHeatMap
    data={data}
    margin={{ top: 60, right: 90, bottom: 60, left: 90 }}
    axisTop={{ tickRotation: -45 }}
    colors={{ type: "sequential", scheme: "blues" }}
    emptyColor="#f3f4f6"
    borderColor={{ from: "color", modifiers: [["darker", 0.4]] }}
    labelTextColor={{ from: "color", modifiers: [["darker", 1.8]] }}
    animate
  />
</div>
```

### Treemap

```tsx
import { ResponsiveTreeMap } from "@nivo/treemap"

<div style={{ height: 400 }}>
  <ResponsiveTreeMap
    data={hierarchicalData}
    identity="name"
    value="value"
    valueFormat=".02s"
    margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
    labelSkipSize={12}
    colors={{ scheme: "paired" }}
    borderWidth={2}
    borderColor={{ from: "color", modifiers: [["darker", 0.3]] }}
  />
</div>
```

### Sankey (Flow Diagram)

```tsx
import { ResponsiveSankey } from "@nivo/sankey"

<div style={{ height: 400 }}>
  <ResponsiveSankey
    data={{ nodes, links }}
    margin={{ top: 40, right: 160, bottom: 40, left: 50 }}
    align="justify"
    colors={{ scheme: "category10" }}
    nodeOpacity={1}
    nodeThickness={18}
    linkOpacity={0.5}
    linkBlendMode="multiply"
    enableLinkGradient
  />
</div>
```

### Choropleth (Geographic)

```tsx
import { ResponsiveChoropleth } from "@nivo/geo"

<div style={{ height: 500 }}>
  <ResponsiveChoropleth
    data={countryData}
    features={worldGeoJson.features}
    margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
    colors="blues"
    domain={[0, 1000000]}
    unknownColor="#f3f4f6"
    label="properties.name"
    projectionScale={150}
    projectionTranslation={[0.5, 0.5]}
    projectionRotation={[0, 0, 0]}
    borderWidth={0.5}
    borderColor="#94a3b8"
  />
</div>
```

---

## D3.js Custom Visualizations

Use D3 when you need complete control. In React, use D3 for calculations and
React for rendering (the "D3 for math, React for DOM" pattern).

### Force-Directed Graph

```tsx
const simulation = d3.forceSimulation(nodes)
  .force("link", d3.forceLink(links).id(d => d.id).distance(80))
  .force("charge", d3.forceManyBody().strength(-200))
  .force("center", d3.forceCenter(width / 2, height / 2))
  .force("collision", d3.forceCollide().radius(20))

// Render with React SVG elements, update positions on simulation tick
```

### Arc / Radial Layout

```tsx
const arc = d3.arc()
  .innerRadius(innerR)
  .outerRadius(outerR)
  .cornerRadius(3)

const pie = d3.pie()
  .sort(null)
  .value(d => d.value)
  .padAngle(0.02)
```

---

## visx Low-Level Primitives

visx (by Airbnb) provides D3-powered React components. Use when you want D3
precision with React rendering.

### Key Modules

- `@visx/shape` — Bars, lines, areas, arcs, pies
- `@visx/axis` — Configurable axes
- `@visx/scale` — D3 scales as hooks
- `@visx/tooltip` — Tooltip positioning
- `@visx/grid` — Background grids
- `@visx/gradient` — SVG gradients
- `@visx/responsive` — `ParentSize` wrapper for responsive charts

### Pattern

```tsx
import { scaleBand, scaleLinear } from "@visx/scale"
import { Bar } from "@visx/shape"
import { AxisBottom, AxisLeft } from "@visx/axis"
import { Group } from "@visx/group"

const xScale = scaleBand({ domain: data.map(getX), range: [0, width], padding: 0.3 })
const yScale = scaleLinear({ domain: [0, max(data, getY)], range: [height, 0] })

<svg width={width} height={height}>
  <Group left={margin.left} top={margin.top}>
    {data.map((d) => (
      <Bar
        key={getX(d)}
        x={xScale(getX(d))}
        y={yScale(getY(d))}
        width={xScale.bandwidth()}
        height={height - yScale(getY(d))}
        fill="#6366f1"
        rx={4}
      />
    ))}
    <AxisBottom scale={xScale} top={height} />
    <AxisLeft scale={yScale} />
  </Group>
</svg>
```

---

## Layout Patterns

### Dashboard Grid (Tailwind)

```tsx
// Full dashboard layout
<div className="min-h-screen bg-background p-6">
  {/* Header */}
  <div className="mb-8 flex items-center justify-between">
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
      <p className="text-muted-foreground">Your performance overview</p>
    </div>
    <DateRangePicker />
  </div>

  {/* KPI Row */}
  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
    {kpis.map(kpi => <KPICard key={kpi.id} {...kpi} />)}
  </div>

  {/* Charts Row */}
  <div className="grid gap-4 md:grid-cols-7 mb-8">
    <Card className="col-span-4">{/* Primary chart */}</Card>
    <Card className="col-span-3">{/* Secondary chart */}</Card>
  </div>

  {/* Detail Table */}
  <Card>{/* DataTable component */}</Card>
</div>
```

### Card Component (shadcn-style)

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

### Semantic Palette (recommended)

```css
/* Use CSS variables for theming */
--chart-1: 221.2 83.2% 53.3%;   /* Primary blue */
--chart-2: 142.1 76.2% 36.3%;   /* Success green */
--chart-3: 24.6 95% 53.1%;      /* Warning orange */
--chart-4: 346.8 77.2% 49.8%;   /* Danger red */
--chart-5: 262.1 83.3% 57.8%;   /* Accent purple */
```

### Sequential (for gradients / heatmaps)

Single hue, vary lightness: `blue-100` → `blue-900` (Tailwind scale) or use
Nivo's built-in schemes: `blues`, `greens`, `oranges`, `purples`.

### Diverging (for +/- values)

Red ↔ White ↔ Green or Red ↔ Grey ↔ Blue. Center on zero or mean.

### Categorical (for distinct groups)

Max 7 colors. Use Tailwind's `500` shade variants:
`blue-500`, `emerald-500`, `amber-500`, `rose-500`, `violet-500`, `cyan-500`,
`orange-500`.

---

## Data Transformation Patterns

### Reshape for Recharts

Recharts expects flat arrays where each object represents one data point with
all series as keys:

```ts
// Input: { date, category, value } rows
// Output: { date, category_A: value, category_B: value }
const pivoted = _.chain(rawData)
  .groupBy("date")
  .map((items, date) => ({
    date,
    ..._.fromPairs(items.map(i => [i.category, i.value]))
  }))
  .value()
```

### Aggregate for KPI Cards

```ts
const kpis = {
  total: _.sumBy(data, "revenue"),
  average: _.meanBy(data, "revenue"),
  max: _.maxBy(data, "revenue"),
  count: data.length,
  growth: ((current - previous) / previous * 100).toFixed(1),
}
```

### Hierarchical for Treemaps

```ts
// Flat → hierarchical
const tree = {
  name: "root",
  children: _.chain(data)
    .groupBy("category")
    .map((items, name) => ({
      name,
      children: items.map(i => ({ name: i.label, value: i.amount })),
    }))
    .value(),
}
```

### Time Bucketing

```ts
import { format, startOfWeek, startOfMonth } from "date-fns"

const weeklyData = _.chain(data)
  .groupBy(d => format(startOfWeek(new Date(d.date)), "yyyy-MM-dd"))
  .map((items, week) => ({
    week,
    total: _.sumBy(items, "value"),
    count: items.length,
  }))
  .value()
```

### Waterfall Pre-computation

```ts
// Compute running start position for each waterfall bar
// Input: [{ name, value }] — positive = gain, negative = loss
const waterfallData = rawItems.reduce<WaterfallItem[]>((acc, item, i) => {
  const prev = acc[i - 1]
  const start = prev ? prev.start + prev.value : 0
  return [...acc, { ...item, start, end: start + item.value }]
}, [])
```

---

## Force-Directed DAG

Use D3's force simulation to render lineage graphs, dependency trees, and
pipeline DAGs. The pattern: D3 computes positions, React renders SVG elements.

```tsx
import { useEffect, useRef } from "react"
import * as d3 from "d3"

interface DagNode { id: string; label: string; type: "source" | "middle" | "output" }
interface DagLink { source: string; target: string; label?: string }

const NODE_COLORS: Record<DagNode["type"], { fill: string; stroke: string }> = {
  source:  { fill: "#dbeafe", stroke: "#3b82f6" },
  middle:  { fill: "#f1f5f9", stroke: "#94a3b8" },
  output:  { fill: "#dcfce7", stroke: "#22c55e" },
}

export function ForceDAG({ nodes, links }: { nodes: DagNode[]; links: DagLink[] }) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!svgRef.current) return
    const width = svgRef.current.clientWidth || 800
    const height = 500

    const svg = d3.select(svgRef.current).attr("height", height)
    svg.selectAll("*").remove()

    // Arrowhead marker
    svg.append("defs").append("marker")
      .attr("id", "dag-arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 22).attr("refY", 0)
      .attr("markerWidth", 6).attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#94a3b8")

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
      .call(
        d3.drag<SVGGElement, any>()
          .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
          .on("drag",  (e, d) => { d.fx = e.x; d.fy = e.y })
          .on("end",   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
      )

    nodeSel.append("rect")
      .attr("x", -54).attr("y", -18)
      .attr("width", 108).attr("height", 36).attr("rx", 6)
      .attr("fill",   (d: any) => NODE_COLORS[d.type].fill)
      .attr("stroke", (d: any) => NODE_COLORS[d.type].stroke)
      .attr("stroke-width", 1.5)

    nodeSel.append("text")
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("font-size", 11).attr("fill", "#374151")
      .text((d: any) => d.label.length > 16 ? d.label.slice(0, 15) + "…" : d.label)

    sim.on("tick", () => {
      linkSel
        .attr("x1", (d: any) => d.source.x).attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x).attr("y2", (d: any) => d.target.y)
      nodeSel.attr("transform", (d: any) => `translate(${d.x},${d.y})`)
    })

    return () => { sim.stop() }
  }, [nodes, links])

  return <svg ref={svgRef} className="w-full" style={{ minHeight: 500 }} />
}
```

**Key rules:**
- Always copy nodes/links before passing to D3 (D3 mutates them with `x`/`y`/`vx`/`vy`)
- Use `clientWidth` for responsive width — read it after mount
- Truncate long labels inside the node rect; show full label in a tooltip on hover
- `alphaTarget(0)` in drag end lets the simulation cool down naturally

---

## Radar / Spider Chart

Use Recharts `RadarChart` for multi-dimensional scoring — SQL quality dimensions,
test coverage breakdown, feature completeness, etc.

```tsx
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  PolarRadiusAxis, ResponsiveContainer, Legend, Tooltip,
} from "recharts"

// Data shape: one object per axis dimension
// [{ dimension: "Performance", score: 72, benchmark: 85 }, ...]
interface RadarDatum { dimension: string; score: number; benchmark?: number }

export function QualityRadar({ data }: { data: RadarDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={340}>
      <RadarChart cx="50%" cy="50%" outerRadius="75%" data={data}>
        <PolarGrid stroke="#e2e8f0" />
        <PolarAngleAxis
          dataKey="dimension"
          tick={{ fontSize: 12, fill: "#64748b" }}
        />
        <PolarRadiusAxis
          angle={90}
          domain={[0, 100]}
          tick={{ fontSize: 10, fill: "#94a3b8" }}
          tickCount={5}
        />
        <Radar
          name="Current"
          dataKey="score"
          stroke="#6366f1"
          fill="#6366f1"
          fillOpacity={0.25}
          strokeWidth={2}
        />
        {/* Optional benchmark / target overlay */}
        <Radar
          name="Benchmark"
          dataKey="benchmark"
          stroke="#e2e8f0"
          fill="none"
          strokeDasharray="5 3"
          strokeWidth={1.5}
        />
        <Tooltip
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
          formatter={(v: number) => [`${v}`, ""]}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </RadarChart>
    </ResponsiveContainer>
  )
}
```

**Usage notes:**
- `domain={[0, 100]}` — keep consistent so comparisons are meaningful
- Dashed benchmark line gives context without overwhelming the primary series
- Avoid more than 2 series; the chart becomes unreadable beyond that

---

## Calendar Heatmap

Nivo `ResponsiveCalendar` renders one square per day colored by value intensity.
Use for query frequency, pipeline run density, incident counts, or daily usage.

```tsx
import { ResponsiveCalendar } from "@nivo/calendar"

// Data shape: [{ day: "2026-03-15", value: 42 }, ...]
interface CalendarDatum { day: string; value: number }

export function ActivityCalendar({
  data,
  from,
  to,
}: {
  data: CalendarDatum[]
  from: string  // "YYYY-MM-DD"
  to: string
}) {
  return (
    <div style={{ height: 200 }}>
      <ResponsiveCalendar
        data={data}
        from={from}
        to={to}
        emptyColor="#f8fafc"
        colors={["#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"]}
        margin={{ top: 24, right: 20, bottom: 8, left: 20 }}
        yearSpacing={40}
        monthBorderColor="#ffffff"
        dayBorderWidth={2}
        dayBorderColor="#ffffff"
        legends={[
          {
            anchor: "bottom-right",
            direction: "row",
            itemCount: 4,
            itemWidth: 42,
            itemHeight: 36,
            itemsSpacing: 14,
            itemDirection: "right-to-left",
          },
        ]}
        tooltip={({ day, value }) => (
          <div className="bg-white border rounded px-2 py-1 text-xs shadow-md">
            <span className="font-medium">{day}</span>: {value}
          </div>
        )}
      />
    </div>
  )
}
```

**Notes:**
- Set `height` on the wrapper div, not on the Nivo component
- Use a single-hue sequential palette (light → dark) — avoid rainbow
- For sparse data, `emptyColor="#f8fafc"` (near-white) makes gaps non-distracting

---

## Waterfall Chart

Recharts doesn't have a native waterfall, but a stacked `Bar` with an invisible
spacer achieves the same result.

```tsx
import { ComposedChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"

interface WaterfallItem { name: string; value: number; start: number }

// Pre-compute running start positions (see Data Transformation Patterns)
function toWaterfallSeries(items: { name: string; value: number }[]): WaterfallItem[] {
  let running = 0
  return items.map(item => {
    const start = item.value >= 0 ? running : running + item.value
    running += item.value
    return { name: item.name, value: Math.abs(item.value), start, _raw: item.value }
  })
}

export function WaterfallChart({ items }: { items: { name: string; value: number }[] }) {
  const data = toWaterfallSeries(items)

  return (
    <ResponsiveContainer width="100%" height={360}>
      <ComposedChart data={data} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip
          formatter={(value, name, props) => {
            if (name === "start") return null  // hide spacer in tooltip
            const raw = (props.payload as any)._raw
            return [`${raw >= 0 ? "+" : ""}${raw.toLocaleString()}`, ""]
          }}
        />
        {/* Invisible spacer — lifts the visible bar to the right Y position */}
        <Bar dataKey="start" stackId="wf" fill="transparent" isAnimationActive={false} />
        {/* Visible bar — colored by positive/negative */}
        <Bar dataKey="value" stackId="wf" radius={[4, 4, 0, 0]}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={(entry as any)._raw >= 0 ? "#22c55e" : "#ef4444"}
            />
          ))}
        </Bar>
      </ComposedChart>
    </ResponsiveContainer>
  )
}
```

**Key rules:**
- The spacer bar (`fill="transparent"`) must use `isAnimationActive={false}` — animating it reveals the trick
- Hide the spacer from the tooltip by returning `null` in the formatter
- For a "total" bar at the end, set `start: 0` and `value: runningTotal` with a distinct color (e.g., slate)

---

## Annotation Patterns

Annotations are what make a chart tell a *story*. Add them after the core chart
is working. Recharts provides `ReferenceLine` and `ReferenceArea` for this.

### Goal / threshold line

```tsx
import { ReferenceLine } from "recharts"

<ReferenceLine
  y={targetValue}
  stroke="#f59e0b"
  strokeDasharray="6 3"
  strokeWidth={1.5}
  label={{
    value: `Target: ${targetValue.toLocaleString()}`,
    position: "insideTopRight",
    fontSize: 11,
    fill: "#f59e0b",
  }}
/>
```

### Time range highlight (incident, campaign, sprint)

```tsx
import { ReferenceArea } from "recharts"

<ReferenceArea
  x1={incidentStart}
  x2={incidentEnd}
  fill="#fee2e2"
  fillOpacity={0.5}
  label={{
    value: "Incident",
    position: "insideTopLeft",
    fontSize: 10,
    fill: "#ef4444",
  }}
/>
```

### Floating callout label on a reference line

```tsx
const CalloutLabel = ({
  viewBox,
  label,
  color = "#1e293b",
}: {
  viewBox?: { x: number; y: number }
  label: string
  color?: string
}) => {
  if (!viewBox) return null
  const { x, y } = viewBox
  const w = label.length * 7 + 16
  return (
    <g>
      <rect x={x - w / 2} y={y - 34} width={w} height={20} rx={4} fill={color} />
      <text
        x={x}
        y={y - 20}
        textAnchor="middle"
        fontSize={11}
        fill="white"
        fontWeight={500}
      >
        {label}
      </text>
      <line x1={x} y1={y - 14} x2={x} y2={y} stroke={color} strokeWidth={1} />
    </g>
  )
}

// Usage
<ReferenceLine
  x={releaseDate}
  stroke="#6366f1"
  strokeDasharray="4 4"
  label={<CalloutLabel label="v2.0 shipped" color="#6366f1" />}
/>
```

### Anomaly dot highlight

```tsx
// Custom dot renderer — normal points get a small circle; anomalies get a
// larger highlighted dot with a warning indicator above it
<Line
  dataKey="value"
  strokeWidth={2}
  dot={(props) => {
    const { cx, cy, payload, key } = props
    if (!payload?.isAnomaly) {
      return <circle key={key} cx={cx} cy={cy} r={3} fill="#6366f1" />
    }
    return (
      <g key={key}>
        <circle cx={cx} cy={cy} r={10} fill="#ef4444" opacity={0.15} />
        <circle cx={cx} cy={cy} r={4}  fill="#ef4444" />
        <text x={cx} y={cy - 14} textAnchor="middle" fontSize={11} fill="#ef4444">
          ▲
        </text>
      </g>
    )
  }}
/>
```

### Rules for annotations

- **Limit to 3 per chart** — more annotations dilute all of them
- **Color by urgency**: amber (`#f59e0b`) = target/goal, red (`#ef4444`) = incident/risk,
  indigo (`#6366f1`) = event/release, green (`#22c55e`) = achievement
- **Never overlap data** — use `position: "insideTopRight"` or `"insideTopLeft"` on
  `ReferenceArea` labels; use the floating `CalloutLabel` above the line for `ReferenceLine`
- **Pair with tooltip** — the annotation names the event; the tooltip shows the value
