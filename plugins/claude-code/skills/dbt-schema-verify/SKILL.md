---
name: dbt-schema-verify
description: >
  REQUIRED after building or modifying any dbt model with columns declared in
  schema.yml / _models.yml. Diffs the model's actual columns against the spec and
  treats any mismatch as "not done". Catches the green-build-failing-tests case
  where the data values are right but the column shape is wrong.
allowed-tools: Bash, Read
---

# dbt schema verify

The most common reason a build is green but the tests still fail: the model produces the
right *values* in the wrong *column shape* — extra columns, missing columns, wrong order,
wrong types. Many dbt equality tests grade the column tuple `(name, type, position)`
exactly.

The failure mode to guard against is adding "helpful" extras (rank breakdowns,
name-resolved variants, lineage metadata) or reordering columns "more logically". Both
break the contract.

## Preflight — resolve the tool

`altimate-dbt` is **not published to npm** and is not part of the `altimate` binary. It
only exists if someone built it from the monorepo:

```bash
command -v altimate-dbt >/dev/null && echo "ok" || \
  echo "build it: cd <altimate-code>/packages/dbt-tools && bun install && bun run build"
```

## Run

```bash
cd <dbt project dir> && altimate-dbt schema-verify --model $ARGUMENTS
```

### Fallback when altimate-dbt is unavailable

The check is a set diff between the spec and the built relation, so it can be done by
hand. Build the model, then compare:

```bash
dbt compile --select $ARGUMENTS            # refresh target/manifest.json
python3 - <<'PY'
import json, sys
m = json.load(open("target/manifest.json"))
node = next(v for v in m["nodes"].values()
            if v["resource_type"] == "model" and v["name"] == "MODEL_NAME")
spec = list(node["columns"])            # declared in schema.yml, in order
print("declared:", spec)
PY
```

Then read the actual columns from the warehouse (`dbt show --select $ARGUMENTS --limit 0`,
or `describe <relation>`) and diff the two lists **as ordered tuples**, not as sets —
order is part of the contract.

## Verdicts

- `match` — done.
- `mismatch` — **not done.** The result names `columns_extra`, `columns_missing`,
  `columns_reordered` and `type_mismatches`. Fix the model (or, only if the spec is the
  thing that is wrong, fix the spec — and say which you chose and why).
- `no-spec` — the model declares no columns. Report that; do not invent a spec.

Re-run until `match` before reporting the work complete. A mismatch you have decided to
accept still gets stated explicitly, with the reason.
