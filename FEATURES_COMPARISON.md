# Feature Comparison: origin/main vs restructure/main

## Verdict: No features lost. All custom functionality is present on restructure/main.

---

## Side-by-Side Summary

| Category | origin/main | restructure/main | Status |
|----------|:-----------:|:-----------------:|:------:|
| Custom tools (TS files) | 68 | 68 | MATCH |
| Bridge (client/engine/protocol) | 3 | 3 | MATCH |
| Agent modes | 5 | 5 | MATCH |
| Agent prompts | 5 | 5 | MATCH |
| Telemetry | 1 | 1 | MATCH |
| Anthropic plugin | 1 | 1 | MATCH |
| Engine CLI command | 1 | 1 | MATCH |
| Skills | 11 | 11 | MATCH |
| Python engine (all modules) | 71 files | 71 files | MATCH (byte-identical) |
| Experiments | 2 benchmarks | 2 benchmarks | MATCH |
| CI/CD workflows | 4 | 4 | MATCH |
| Docs site | full | full | MATCH |
| ACP protocol | yes | yes | MATCH |
| Dockerfile | yes | yes | MATCH |
| Theme (altimate-code.json) | yes | yes | MATCH |
| PAID_CONTEXT_FEATURES.md | yes | yes | MATCH |
| Tests (bridge, ACP, telemetry, engine) | all | all | MATCH |
| Upstream merge tooling | n/a | yes | NEW (intentional) |

---

## Detailed Feature-by-Feature Comparison

### Tools — ALL 68 PRESENT

| Tool Group | Files (main) | Files (restructure) | Status |
|-----------|:---:|:---:|:---:|
| SQL (10) | `src/tool/sql-*.ts` | `src/altimate/tools/sql-*.ts` | MOVED |
| Schema (7) | `src/tool/schema-*.ts` | `src/altimate/tools/schema-*.ts` | MOVED |
| Warehouse (5) | `src/tool/warehouse-*.ts` | `src/altimate/tools/warehouse-*.ts` | MOVED |
| dbt (4) | `src/tool/dbt-*.ts` | `src/altimate/tools/dbt-*.ts` | MOVED |
| FinOps (7) | `src/tool/finops-*.ts` | `src/altimate/tools/finops-*.ts` | MOVED |
| altimate-core (33) | `src/tool/altimate-core-*.ts` | `src/altimate/tools/altimate-core-*.ts` | MOVED |
| lineage-check (1) | `src/tool/lineage-check.ts` | `src/altimate/tools/lineage-check.ts` | MOVED |
| project-scan (1) | `src/tool/project-scan.ts` | `src/altimate/tools/project-scan.ts` | MOVED |

### Bridge — ALL 3 PRESENT

| File | main path | restructure path | Status |
|------|-----------|-------------------|--------|
| client.ts | `src/bridge/client.ts` | `src/altimate/bridge/client.ts` | MOVED |
| engine.ts | `src/bridge/engine.ts` | `src/altimate/bridge/engine.ts` | MOVED |
| protocol.ts | `src/bridge/protocol.ts` | `src/altimate/bridge/protocol.ts` | MOVED |

### Agent Modes — ALL 5 PRESENT

| Agent | main prompt | restructure prompt | Status |
|-------|-------------|-------------------|--------|
| builder | `src/agent/prompt/builder.txt` | `src/altimate/prompts/builder.txt` | MOVED |
| analyst | `src/agent/prompt/analyst.txt` | `src/altimate/prompts/analyst.txt` | MOVED |
| executive | `src/agent/prompt/executive.txt` | `src/altimate/prompts/executive.txt` | MOVED |
| migrator | `src/agent/prompt/migrator.txt` | `src/altimate/prompts/migrator.txt` | MOVED |
| validator | `src/agent/prompt/validator.txt` | `src/altimate/prompts/validator.txt` | MOVED |

Agent registration in `agent.ts` — verified via `altimate_change` markers (3 blocks, all closed).

### Telemetry — PRESENT
- main: `src/telemetry/index.ts` (full implementation inline)
- restructure: `src/altimate/telemetry/index.ts` (implementation) + `src/telemetry/index.ts` (re-export via marker)

### Plugin — PRESENT
- main: `src/plugin/anthropic.ts`
- restructure: `src/altimate/plugin/anthropic.ts`

### CLI — PRESENT
- main: `src/cli/cmd/engine.ts`
- restructure: `src/altimate/cli/engine.ts`

### Skills — ALL 11 PRESENT
cost-report, dbt-docs, generate-tests, impact-analysis, incremental-logic, lineage-diff, medallion-patterns, model-scaffold, query-optimize, sql-translate, yaml-config

### Python Engine — 71/71 BYTE-IDENTICAL
All Python files verified as exact copies.

### Config Modifications (altimate_change markers) — ALL 9 FILES VERIFIED
21 marker blocks across 9 files, all properly closed:
- `src/tool/registry.ts` (2 blocks)
- `src/agent/agent.ts` (3 blocks)
- `src/config/config.ts` (1 block)
- `src/config/paths.ts` (1 block)
- `src/flag/flag.ts` (3 blocks)
- `src/global/index.ts` (1 block)
- `src/index.ts` (7 blocks)
- `src/installation/index.ts` (2 blocks)
- `src/telemetry/index.ts` (1 block)

---

## Intentional Differences

| Item | origin/main | restructure/main | Reason |
|------|-------------|-------------------|--------|
| Package directory | `packages/altimate-code/` | `packages/opencode/` | Upstream naming restored for mergability |
| `bin/altimate-code` | Separate file | Points to `bin/altimate` | Consolidated; both names work via package.json |
| `PROGRESS.md` | Present | Absent | Progress tracking doc, not a feature |
| `opencode` binary | Absent | Present | Upstream compatibility retained |
| `script/upstream/` merge tooling | Absent | Present | NEW: automated merge infrastructure |
| `src/altimate/index.ts` barrel | Absent | Present | NEW: clean import entry point |
| `src/altimate/command/discover.txt` | Absent | Present | NEW: command file |

---

## New on restructure/main (Intentional Additions)

These are infrastructure improvements added during the restructure:

1. **`script/upstream/`** — Automated merge tooling (analyze.ts, merge.ts, transforms/, utils/)
2. **`src/altimate/index.ts`** — Barrel export for all custom modules
3. **`src/altimate/command/discover.txt`** — Custom command file
4. **`bin/altimate`** — Unified binary (replaces separate `altimate` + `altimate-code` files)

---

## Conclusion

**Every custom feature from origin/main exists on restructure/main.** The differences are:
- **Path changes** (tools/bridge/prompts moved into `src/altimate/`)
- **Package naming** (`altimate-code` → `opencode` for upstream compatibility)
- **Binary consolidation** (two files → one file, both names still work)
- **One file intentionally dropped** (`PROGRESS.md` — not a feature)
- **New infrastructure added** (merge tooling, barrel export)
