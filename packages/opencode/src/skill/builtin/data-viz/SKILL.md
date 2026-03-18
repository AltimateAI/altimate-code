---
name: data-viz
description: >
  Build modern, interactive data visualizations and dashboards using code-based
  component libraries (shadcn/ui, Recharts, Tremor, Nivo, D3, Victory, visx).
  Use this skill whenever the user asks to visualize data, build dashboards,
  create analytics views, chart metrics, tell a data story, build a reporting
  interface, create KPI cards, plot graphs, or explore a dataset — even if they
  mention PowerBI, Tableau, Streamlit, Metabase, Looker, Grafana, or similar
  tools. Also trigger when the user says "make a dashboard", "show me the data",
  "chart this", "visualize trends", "build an analytics page", "data story", or
  anything involving turning raw data into interactive visual interfaces. If the
  task involves presenting data visually — this is the skill. Always prefer
  building a real, interactive, code-based UI over exporting to or recommending
  a BI platform.
---

# AI-First Data Visualization

## Philosophy

Build production-quality interactive data interfaces with modern component libraries — no vendor lock-in, embeddable anywhere. When no tool is specified, build code-first. When the user explicitly names a BI tool, use it — only suggest code-first if they ask for options or hit a technical blocker.

## Technology Stack

Full API patterns & code: `references/component-guide.md`

### Framework Priority

1. **React + Tailwind** — Default when JSX/TSX supported
2. **HTML + CSS + Vanilla JS** — Fallback (use D3 or Chart.js)
3. **Python (Plotly/Dash)** — Python-only environments only

### Library Selection

| Library | Best For |
|---------|----------|
| **shadcn/ui charts** | Default first choice — general dashboards, most chart types |
| **Recharts** | Line, bar, area, composed, radar — fine-grained control |
| **Tremor** | KPI cards, metric displays, full dashboard layouts |
| **Nivo** | Heatmaps, treemaps, choropleth, calendar, Sankey, funnel |
| **visx** | Bespoke custom viz — D3-level control with React |
| **D3.js** | Force-directed graphs, DAGs, maps — maximum flexibility |
| **Victory** | When animation quality matters most |

**Supporting**: Tailwind CSS · Radix UI · Framer Motion · Lucide React · date-fns · Papaparse · lodash

## Building a Visualization

### Step 1: Understand the Data Story

Before code, identify: **What question does the data answer?** Who is the audience (exec → KPIs only, analyst → drill-down, public → narrative)? **What's the ONE key insight?** Design around it.

### Step 2: Choose Chart Type

| Data Relationship | Chart Type | Library |
|---|---|---|
| Trend over time | Line, Area | shadcn/Recharts |
| Category comparison | Bar (horizontal if many) | shadcn/Recharts |
| Part of whole | Donut, Treemap | shadcn/Nivo |
| Distribution | Histogram, Box, Violin | Nivo/visx |
| Correlation | Scatter, Bubble | Recharts/visx |
| Geographic | Choropleth, Dot map | Nivo/D3 |
| Hierarchical | Treemap, Sunburst | Nivo |
| Flow / Process | Sankey, Funnel | Nivo/D3 |
| Single KPI | Metric card, Gauge, Sparkline | Tremor/shadcn |
| Multi-metric overview | Dashboard grid of cards | Tremor + shadcn |
| Ranking | Horizontal bar, Bar list | Tremor |
| Column/model lineage | Force-directed DAG | D3 |
| Pipeline dependencies | Hierarchical tree, DAG | D3/Nivo |
| Multi-dimensional quality | Radar/Spider | Recharts |
| Activity density over time | Calendar heatmap | Nivo |
| Incremental change breakdown | Waterfall | Recharts (custom) |

### Step 3: Build the Interface

Start from this layout — remove what the data doesn't need:

```
┌─────────────────────────────────────────┐
│ Header: Title + Description + Date Range│
├─────────────────────────────────────────┤
│ KPI Row: 3-5 metric cards + sparklines  │
├─────────────────────────────────────────┤
│ Primary Visualization (largest chart)   │
├──────────────────┬──────────────────────┤
│ Secondary Chart  │ Supporting Chart/Tbl │
├──────────────────┴──────────────────────┤
│ Detail Table (sortable, filterable)     │
└─────────────────────────────────────────┘
```

A single insight might just be one chart with a headline and annotation. Scale complexity to audience.

### Step 4: Design Principles

- **Data-ink ratio**: Remove chartjunk — unnecessary gridlines, redundant labels, decorative borders
- **Color with purpose**: Encode meaning (red=bad, green=good, blue=neutral). Max 5-7 colors. Single-hue gradient for sequential data
- **Typography hierarchy**: Title → subtitle (muted) → axis labels (small) → data labels
- **Responsive**: `min-h-[VALUE]` on all charts. Grid stacks on mobile
- **Animation**: Entry transitions only, `duration-300` to `duration-500`. Never continuous
- **Accessibility**: `aria-label` on charts, WCAG AA contrast, don't rely on color alone

### Step 5: Interactivity & Annotations

**Priority**: Tooltips (every chart) → Filtering → Sorting → Drill-down → Cross-filtering → Export → Annotations

**Annotations** turn charts into stories. Mark: inflection points, threshold crossings (amber), external events (indigo/red), anomalies (red), achievements (green). **Limit 3 per chart.** Implementation: `references/component-guide.md` → Annotation Patterns.

### Step 6: Tell the Story

- **Headline states insight**: "Revenue grew 23% QoQ, driven by enterprise" — not "Q3 Revenue Chart"
- **Annotate key moments** directly on chart
- **Contextual comparisons**: vs. prior period, vs. target, vs. benchmark
- **Progressive disclosure**: Overview first — detail on demand

## Environment-Specific Guidance

| Environment | Approach |
|---|---|
| **Claude Artifacts** | React (JSX), single file, default export. Available: `recharts`, `lodash`, `d3`, `lucide-react`, shadcn via `@/components/ui/*`, Tailwind |
| **Claude Code / Terminal** | Vite + React + Tailwind. Add shadcn/ui + Recharts. Structure: `src/components/charts/`, `src/components/cards/`, `src/data/` |
| **Python / Jupyter** | Plotly for charts, Plotly Dash for dashboards |
| **Cursor / Bolt / other IDEs** | Match existing framework. Prefer shadcn/ui if present |

## Anti-Patterns

- Screenshot/static charts — build interactive components
- Defaulting to BI tools unprompted — build code-first when no tool specified
- Default matplotlib — always customize in Python
- Rainbow palettes — use deliberate, meaningful colors
- 3D charts — almost never appropriate
- Pie charts > 5 slices — use horizontal bar
- Unlabeled dual y-axes — use two separate charts
- Truncated bar axes — always start at zero
