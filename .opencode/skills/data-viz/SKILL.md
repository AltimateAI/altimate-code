---
name: data-viz
description: >
  Build modern, AI-first data visualizations and data storytelling interfaces
  using code-based component libraries (shadcn/ui, Recharts, Tremor, Nivo, D3,
  Victory, visx) instead of legacy BI tools. Use this skill whenever the user
  asks to visualize data, build dashboards, create analytics views, chart
  metrics, tell a data story, build a reporting interface, create KPI cards,
  plot graphs, or explore a dataset — even if they mention PowerBI, Tableau,
  Streamlit, Metabase, Looker, Grafana, or similar tools. Also trigger when the
  user says "make a dashboard", "show me the data", "chart this", "visualize
  trends", "build an analytics page", "data story", or anything involving
  turning raw data into interactive visual interfaces. If the task involves
  presenting data visually — this is the skill. Always prefer building a real,
  interactive, code-based UI over exporting to or recommending a BI platform.
---

# AI-First Data Visualization

## Table of Contents

1. [Philosophy](#philosophy)
2. [Technology Stack](#technology-stack)
3. [Building a Data Visualization](#building-a-data-visualization)
   - [Step 1: Understand the Data Story](#step-1-understand-the-data-story)
   - [Step 2: Choose the Right Chart Type](#step-2-choose-the-right-chart-type)
   - [Step 3: Build the Interface](#step-3-build-the-interface)
   - [Step 4: Apply Design Principles](#step-4-apply-design-principles)
   - [Step 5: Add Interactivity & Annotations](#step-5-add-interactivity--annotations)
   - [Step 6: Tell the Story](#step-6-tell-the-story)
4. [Environment-Specific Guidance](#environment-specific-guidance)
5. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)
6. [Quick Reference](#quick-reference)

---

## Philosophy

AI agents can generate production-quality, interactive data interfaces in
minutes using modern component libraries — more customizable, no vendor lock-in,
embeddable anywhere.

**Default behavior**: When the user hasn't specified a tool, build a code-first
interactive UI using the stack below. Don't ask — just deliver something great.

**When the user explicitly names a tool** (PowerBI, Tableau, Looker, Metabase,
Grafana, Streamlit, etc.) — **use that tool**. They have a reason: org policy,
existing infra, stakeholder requirements. Help them do it well in their chosen
tool. Only suggest the code-first alternative if they ask for options or if
there's a clear technical blocker (e.g., the BI tool can't support what they
need).

---

## Technology Stack

Full library docs: `references/component-guide.md`

### Framework Priority

1. **React + Tailwind** — Default. Use when the environment supports JSX/TSX.
2. **HTML + CSS + Vanilla JS** — Fallback without React. Use D3 or Chart.js.
3. **Python (Plotly/Dash)** — Only for Python-only environments (Jupyter, scripts).

### Component Libraries

| Library | Best For | When to Use |
|---------|----------|-------------|
| **shadcn/ui charts** | General dashboards, most chart types | Default first choice |
| **Recharts** | Line, bar, area, composed, radar charts | Fine-grained control |
| **Tremor** | KPI cards, metric displays, full layouts | Complete analytics dashboards |
| **Nivo** | Heatmaps, treemaps, choropleth, calendar, Sankey | Advanced / exotic types |
| **visx** | Bespoke custom visualizations | D3-level control with React |
| **D3.js** | Force-directed graphs, DAGs, maps | Maximum flexibility |
| **Victory** | Animated charts | When animation quality matters most |

**Supporting**: Tailwind CSS · Radix UI · Framer Motion · Lucide React · date-fns · Papaparse · lodash

---

## Building a Data Visualization

### Step 1: Understand the Data Story

Before writing any code, identify:

- **What question does the data answer?** ("How are costs trending?", "Where do users drop off?")
- **Who is the audience?** Executive → KPIs only. Analyst → drill-down + filters. Public → narrative flow.
- **What's the key insight?** Every great viz has ONE takeaway. Design around it.

### Step 2: Choose the Right Chart Type

| Data Relationship | Chart Type | Library |
|-------------------|-----------|---------|
| Trend over time | Line chart, Area chart | shadcn/Recharts |
| Comparison across categories | Bar chart (horizontal for many) | shadcn/Recharts |
| Part of a whole | Donut, Treemap | shadcn/Nivo |
| Distribution | Histogram, Box plot, Violin | Nivo/visx |
| Correlation | Scatter, Bubble chart | Recharts/visx |
| Geographic | Choropleth, Dot map | Nivo/D3 |
| Hierarchical | Treemap, Sunburst | Nivo |
| Flow / Process | Sankey, Funnel | Nivo/D3 |
| Single KPI | Metric card, Gauge, Sparkline | Tremor/shadcn |
| Multi-metric overview | Dashboard grid of cards | Tremor + shadcn |
| Ranking | Horizontal bar, Bar list | Tremor |
| Status / Progress | Tracker, Progress bar | Tremor |
| **Column / model lineage** | **Force-directed DAG** | **D3** |
| **Pipeline dependencies** | **Hierarchical tree, DAG** | **D3 / Nivo** |
| **Multi-dimensional quality** | **Radar / Spider chart** | **Recharts** |
| **Activity density over time** | **Calendar heatmap** | **Nivo** |
| **Incremental change breakdown** | **Waterfall chart** | **Recharts (custom)** |
| **Ranking shift over time** | **Bump chart** | **Recharts (custom)** |

### Step 3: Build the Interface

Start from this layout and remove what the data doesn't need:

```
┌─────────────────────────────────────────────────┐
│  Header: Title + Description + Date Range       │
├─────────────────────────────────────────────────┤
│  KPI Row: 3-5 metric cards with sparklines      │
├─────────────────────────────────────────────────┤
│  Primary Visualization (largest chart)           │
├────────────────────┬────────────────────────────┤
│  Secondary Chart   │  Supporting Chart / Table   │
├────────────────────┴────────────────────────────┤
│  Detail Table (sortable, filterable)             │
└─────────────────────────────────────────────────┘
```

A single insight might just be one chart with a headline and annotation.
Scale complexity to match the data and audience.

### Step 4: Apply Design Principles

- **Data-ink ratio**: Remove chartjunk — unnecessary gridlines, redundant labels, decorative borders.
- **Color with purpose**: Encode meaning (red = bad, green = good, blue = neutral). Max 5–7 colors. Single-hue gradient for sequential data.
- **Typography hierarchy**: Title → subtitle (muted) → axis labels (small) → data labels.
- **Responsive**: `min-h-[VALUE]` on all charts. Grid stacks on mobile. Test at 375/768/1280px.
- **Whitespace**: Give charts room. A padded dashboard reads better than a dense wall.
- **Animation**: Entry transitions only. `duration-300` to `duration-500`. Never continuous.
- **Accessibility**: `aria-label` on charts, WCAG AA contrast, don't rely on color alone.

### Step 5: Add Interactivity & Annotations

**Interactivity priority order:**
1. Tooltips — exact values on hover (every chart)
2. Filtering — date range, category, segment
3. Sorting — click column headers in tables
4. Drill-down — click bar/slice to reveal detail
5. Cross-filtering — selection in one chart filters others
6. Export — CSV download of underlying data
7. Annotations — callouts that turn a chart into a story

**Annotations** are the most underused technique in data storytelling. Every
chart with a clear insight should have at least one. Use them to mark:
- Inflection points and trend reversals
- Threshold crossings and goal lines (amber)
- External events: releases, incidents, campaigns (indigo / red)
- Anomalies that demand explanation (red)
- Achievements against target (green)

Limit to **3 annotations per chart** — more and none stand out. Never overlap
data. Implementation patterns: `references/component-guide.md` → Annotation Patterns.

### Step 6: Tell the Story

- **Headline states the insight**: "Revenue grew 23% QoQ, driven by enterprise deals" — not "Q3 Revenue Chart"
- **Annotate key moments**: Mark inflection points, anomalies, goal lines directly on the chart
- **Contextual comparisons**: vs. prior period, vs. target, vs. benchmark
- **Progressive disclosure**: Overview first — detail on demand. Don't front-load complexity.

---

## Environment-Specific Guidance

| Environment | Approach |
|-------------|----------|
| **Claude Artifacts** | React (JSX), single file, default export. Available: `recharts`, `lodash`, `d3`, `lucide-react`, shadcn via `@/components/ui/*`, Tailwind. |
| **Claude Code / Terminal** | Full project: Vite + React + Tailwind. Add shadcn/ui + Recharts. Structure: `src/components/charts/`, `src/components/cards/`, `src/data/`. |
| **Python / Jupyter** | Plotly for charts, Plotly Dash for dashboards. Same design principles apply. |
| **Cursor / Bolt / other IDEs** | Match existing framework. Include install commands. Prefer shadcn/ui if already present, Tremor for dashboard-heavy apps. |

---

## Anti-Patterns to Avoid

- **Screenshot charts** — build interactive components, never static images
- **Defaulting to BI tools unprompted** — when no tool is specified, build code-first; don't suggest "just use Tableau" as a lazy out
- **Default matplotlib** — always customize if forced into Python
- **Rainbow palettes** — use deliberate, meaningful colors
- **3D charts** — almost never appropriate
- **Pie charts > 5 slices** — use horizontal bar instead
- **Unlabeled dual y-axes** — use two separate charts instead
- **Truncated bar axes** — always start at zero
- **Chartjunk** — no gratuitous gradients, shadows, or decoration

---

## Quick Reference

| Pattern | Implementation |
|---------|---------------|
| KPI card + sparkline | Tremor `Card` + `SparkAreaChart` or shadcn `Card` + axisless Recharts `AreaChart` |
| Time series | shadcn `ChartContainer` + Recharts `LineChart`. Add date picker, granularity toggle, prior-period dashed overlay. |
| Categorical comparison | Recharts `BarChart`. Horizontal bars for 10+ categories. Sort toggle + threshold line. |
| Funnel | Nivo `Funnel`. Show step labels, conversion %, drop-off highlight. |
| Geographic | Nivo `Choropleth` + GeoJSON. Color legend + hover tooltip. |
| Table with inline visuals | Tremor/shadcn `Table` with embedded sparklines, progress bars, badges. Sortable + searchable. |
| Force-directed DAG | D3 force simulation + React SVG. Rectangles nodes, directed edges, arrowheads, drag. Color by node type. |
| Radar / spider | Recharts `RadarChart`. Current vs. benchmark (dashed). `domain={[0,100]}` for consistent axes. |
| Calendar heatmap | Nivo `ResponsiveCalendar`. Single-hue sequential palette. Wrap in fixed-height div. |
| Waterfall | Recharts `ComposedChart` with invisible spacer `Bar` + colored value `Bar`. Green = positive, red = negative. |
| Annotations | Recharts `ReferenceLine` (goal/event), `ReferenceArea` (time window), custom dot renderer (anomalies). |

Full implementations: `references/component-guide.md`
