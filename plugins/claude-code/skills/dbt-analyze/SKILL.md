---
name: dbt-analyze
description: >
  Blast radius of a dbt model change — column-level lineage plus the dependency
  graph, so you know what breaks before you ship. Use when changing a model's
  columns, grain, or types, or when asked "what depends on this?". Powered by
  altimate-dbt.
allowed-tools: Bash, Read, Glob, Grep
---

# dbt blast radius

Answer "what breaks if I change this?" before editing, not after.

## Preflight — resolve the tool

`altimate-dbt` is **not published to npm** and is not part of the `altimate` binary. It
only exists if someone built it from the monorepo. Resolve it, and fall back to plain
`dbt` when it is absent — the graph queries work either way.

```bash
ls dbt_project.yml >/dev/null 2>&1 || echo "run this from the dbt project directory"
if command -v altimate-dbt >/dev/null; then
  ADBT=altimate-dbt
else
  echo "altimate-dbt unavailable — using plain dbt. To build it:"
  echo "  cd <altimate-code>/packages/dbt-tools && bun install && bun run build"
  ADBT=
fi
```

## 1. Dependency graph

With `altimate-dbt`:

```bash
altimate-dbt children --model $ARGUMENTS   # everything downstream
altimate-dbt parents  --model $ARGUMENTS   # everything it reads
altimate-dbt columns  --model $ARGUMENTS   # the model's output columns
```

Output is JSON by default (`--format text` for prose).

With plain dbt — equivalent for the graph, and it needs no warehouse connection beyond
a parse:

```bash
dbt parse --profiles-dir .
dbt ls --select $ARGUMENTS+ --output name     # children (downstream)
dbt ls --select +$ARGUMENTS --output name     # parents (upstream)
dbt ls --select $ARGUMENTS  --output json     # config + columns from the manifest
```

Also worth running, because it finds references the graph misses (macros, `-- depends_on`
pragmas, docs):

```bash
grep -rn "ref('$ARGUMENTS')" models/ macros/ --include='*.sql' --include='*.yml'
```

## 2. Column-level lineage

Prefer the manifest path — it resolves `ref()` and `source()` to real relations, so it
is more accurate than parsing the SQL alone:

```bash
altimate-dbt compile --model $ARGUMENTS     # or: dbt compile --select $ARGUMENTS
```

Then trace which downstream columns derive from the ones you are touching. Read
`target/manifest.json` — each node carries `depends_on.nodes`, `columns`, and (after
`compile`, not `parse`) `compiled_code`.

## 3. The boundary that dbt does not know about

**dbt's DAG ends at the mart.** In repos where marts are read by external loaders, the
real consumers are outside the graph — look for a loader registry declaring which models
each loader reads (in `altimate-ingestion` that is
`packages/load-snowflake/src/load_snowflake/registry.py`, whose `LoaderEntry.source_tables`
names the dbt models) and check those too. A column with no dbt consumer is not
necessarily unused.

## 4. Classify

For each downstream dependency, say which it is:

- **BREAKING** — a column it reads is removed, renamed, retyped, or made nullable; the
  grain changes; a contract-enforced model loses a column.
- **SAFE** — additive only, or the change does not touch anything it reads.
- **UNKNOWN** — you could not resolve it. Say so; do not guess.

Report the count at each depth and name the tests at risk. Recommend
`altimate-dbt build --model <name> --downstream` to verify.
