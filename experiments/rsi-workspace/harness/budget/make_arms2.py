#!/usr/bin/env python3
"""make_arms2.py: write applicable40 / overgeneral / conflict playbook arms + arms2-review.md (stdlib only).

applicable40: 4 real bullets + 36 style/doc rules that apply to staging models but are not verifier-checked.
overgeneral:  the 4 real bullets with their scope dropped (read as universal).
conflict:     4 real bullets + 4 stale contradicting bullets (interleaved).
"""
import hashlib
import os

from make_arms import ARMS, REAL_FILE, parse_final, spread, write

# (text, why it applies, why check.py cannot fail on it)
APPLICABLE = [
    ("Start every staging model with a one-line header comment `-- source: raw_<entity> (<source> source)`; keep Jinja out of SQL comments because dbt renders it.",
     "Documents provenance of the model.", "Comments are stripped by strip_comments before regex checks; no Jinja means no render issue."),
    ("Write SQL keywords and function names in lowercase (`select`, `from`, `where`, `as`, `cast`).",
     "House SQL style.", "Regexes use re.I only on `as pk`; lowercase `as` is what the gold uses."),
    ("Indent with four spaces inside a CTE and never use tab characters.",
     "Formatting.", "Whitespace-insensitive regexes (\\s*, \\s+)."),
    ("Leave exactly one blank line between CTEs, and a blank line after each `as (` and before the closing `)`.",
     "Layout matches existing stg_shop__* models.", "Pure whitespace."),
    ("Put commas at the end of the line, never at the start of the next one.",
     "Comma placement convention (not trailing commas before `from`, which would be a syntax error).", "Does not change parsed SQL."),
    ("Put each selected column on its own line.",
     "Diff-friendly formatting.", "Whitespace only; regexes tolerate \\s*."),
    ("Order output columns keys first: the primary key, then foreign keys in source order.",
     "Column-order convention, part 1.", "Order not checked (inspected by name, sums by name)."),
    ("After the keys, list descriptive attributes and amounts in their source order.",
     "Column-order convention, part 2.", "Same as above."),
    ("List date and timestamp columns last, in source order.",
     "Column-order convention, part 3.", "Same as above."),
    ("Select explicit column names in the `renamed` CTE; `select * from source` in the `source` CTE and `select * from renamed` at the end are fine.",
     "Explicit contracts in renamed; matches gold shape.", "Gold already does this; adds/drops nothing."),
    ("Always spell out `as` when aliasing a column, for example `id as refund_id`, never a bare alias.",
     "Alias style.", "C2 regex needs `as <pk>`; this reinforces it."),
    ("Name the two CTEs `source` and `renamed`, in that order, with nothing between them.",
     "Shape convention from gold item 2.", "Matches gold; no check on names."),
    ("Do not qualify column names with the CTE name (`source.id`); the `renamed` CTE reads from a single relation.",
     "Style.", "cents/to_utc regexes match the call, not the column prefix; C3/C4 take the bare name inside the call (a qualified name would break them, so this avoids that)."),
    ("Staging models do no joins, aggregations or `distinct`; one source table in, one row per source row out.",
     "Staging layer contract.", "Gold has none."),
    ("Staging models contain no `order by` and no `limit`.",
     "Ordering and limiting belong downstream.", "Gold has none; row counts are checked and `limit` would break them, so this protects."),
    ("Reference raw data only through `{{ source('<source>', '<entity>') }}`; never hardcode schema or table names such as `raw.raw_refunds`.",
     "Lineage convention (gold item 1).", "Gold uses source()."),
    ("Staging models do not `ref()` other models; they sit directly on sources.",
     "Layering rule.", "Gold has no refs."),
    ("Keep text and categorical columns exactly as the source delivers them: no `lower()`, `trim()` or casts.",
     "Staging stays a rename layer.", "Not checked; no columns are asked to change."),
    ("Use unquoted lowercase snake_case for every output column name.",
     "Naming hygiene.", "Source names are already snake_case; pk/money/ts names are lowercase."),
    ("Put the `where not _is_deleted` filter on its own line directly after `from source` when a filter is needed.",
     "Filter placement; reinforces the real soft-delete lesson.", "Same predicate as gold; only layout."),
    ("Put the `{{ cents_to_dollars('x_cents') }}` and `{{ to_utc('x_ts') }}` calls on the same line as their `as` alias.",
     "Keeps the transform and its output name together.", "Regexes already tolerate this form and gold has it."),
    ("Open the model with `{{ config(tags=['staging']) }}` below the header comment.",
     "Tagging convention for selecting layers.", "Does not change materialization or build; not parsed by checks."),
    ("End each SQL and YAML file with a single newline and no trailing whitespace.",
     "Editor hygiene.", "Whitespace."),
    ("Keep every line under 100 characters.",
     "Readability.", "Whitespace/layout only."),
    ("Document the new model in `_<source>__models.yml` with a one-sentence description in the form `<Plural entity>, one row per <singular entity>.`",
     "Matches existing yml descriptions.", "Model description untested; tests on pk unchanged."),
    ("Give every output column a `description` in the models YAML, as a short sentence starting with a capital and ending with a period.",
     "Column docs.", "Descriptions are not tests; unlisted/extra columns do not fail dbt build."),
    ("List columns in the models YAML in the same order as the final select.",
     "Keeps yml and SQL aligned.", "Order is irrelevant to dbt."),
    ("Describe converted money columns in YAML with their unit, for example `Amount in dollars.`",
     "Column docs.", "Text only."),
    ("Describe timestamp columns in YAML as UTC, for example `Time the refund was issued, in UTC.`",
     "Column docs.", "Text only."),
    ("Quote YAML descriptions that contain a colon, and keep Jinja braces out of them.",
     "Avoids yaml/Jinja parse errors.", "Prevents a build break rather than causing one."),
    ("Keep the models YAML at two-space indentation with `version: 2` first and a blank line between model entries.",
     "Matches `_shop__models.yml`.", "Whitespace; same structure the gold uses."),
    ("List models in `_<source>__models.yml` in alphabetical order by name.",
     "Predictable yml.", "Order irrelevant to dbt; C2 reads patch_path."),
    ("Do not edit `dbt_project.yml`, seeds or macros when adding a staging model; the existing project config already covers it.",
     "Scope discipline.", "Verifier restores these files anyway; changing them could only confuse."),
    ("Do not create extra files for a staging model beyond its `.sql` and the models YAML (no docs blocks, no per-model yml).",
     "Layout convention.", "C2 requires the one `_<source>__models.yml`; this reinforces it."),
    ("Before building, run `dbt compile --select <model>` and read the compiled SQL to confirm every macro expanded.",
     "Process.", "Process only; leaves no artifacts the checks read."),
    ("In the final summary list the columns you renamed or converted, as `old -> new`.",
     "Handoff convention.", "Chat output only."),
]
assert len(APPLICABLE) == 36, len(APPLICABLE)

OVERGENERAL = [
    ("L-2fe6", "Every model and analysis must convert integer `*_cents` columns with the `{{ cents_to_dollars(...) }}` macro and rename them without the `_cents` suffix; no `*_cents` column may appear in any output."),
    ("L-8536", "Every model reading a table with a soft-delete flag (e.g. `_is_deleted`) must filter it with `where not _is_deleted` and leave that column out of the select list; no soft-delete flag may appear in any output."),
    ("L-8201", "Every timestamp column in every model and analysis must be wrapped with the `{{ to_utc('col') }}` macro and aliased with the `_at` suffix; bare timestamp aliases without the macro are not permitted anywhere."),
    ("L-8aba", "Whenever you add or change any model, register its source in the sources YAML file and ensure the model YAML lists only the columns that appear in the final select, using the aliased output names."),
]

# stale bullets: (id, text, counters)
STALE = {
    "money": ("L-5c1d", "Convert integer `*_cents` columns by dividing inline (`amount_cents / 100.0 as amount`); do not call macros in staging models, keep them plain SQL.", "h:1 x:0"),
    "ts": ("L-a37e", "Normalize timestamp columns with `convert_timezone('UTC', col)` and keep the original column name; do not rename them with an `_at` suffix.", "h:1 x:0"),
    "sd": ("L-9e42", "Keep `_is_deleted` in staging output and do not filter it there; filter soft-deleted rows in the marts so history is preserved.", "h:2 x:1"),
    "name": ("L-7b60", "Staging models are named `stg_<entity>.sql` without the source prefix, and their YAML entry uses the same name.", "h:1 x:0"),
}


def rid(text):
    return hashlib.sha1(text.encode()).hexdigest()[:4]


def main():
    front, header, real = parse_final(REAL_FILE)
    by = {b.split("]")[0][3:]: b for b in real}  # id -> full bullet line
    assert set(by) == {"L-2fe6", "L-8536", "L-8201", "L-8aba"}
    ids = [rid(t[0]) for t in APPLICABLE]
    assert len(set(ids)) == 36 and not set(f"L-{i}" for i in ids) & set(by), "id collision"
    app = [{"id": f"L-{rid(t[0])}", "text": t[0]} for t in APPLICABLE]
    bl = lambda d: f"- [{d['id']}] {d['text']} <!-- h:0 x:0 -->"
    # spread() expects bullet() output for dis; give it the dicts and rely on make_arms.bullet
    stats = {}
    stats["applicable40"] = write("applicable40.md", front, header, spread(real, app, 40))

    og = [f"- [{i}] {t} <!-- {by[i].rsplit('<!--', 1)[1].strip(' ->')} -->" for i, t in OVERGENERAL]
    stats["overgeneral"] = write("overgeneral.md", front, header, og)

    s = {k: f"- [{v[0]}] {v[1]} <!-- {v[2]} -->" for k, v in STALE.items()}
    order = [s["money"], by["L-2fe6"], s["ts"], by["L-8201"], by["L-8536"], s["sd"], by["L-8aba"], s["name"]]
    stats["conflict"] = write("conflict.md", front, header, order)

    lines = ["# arms2 review", "",
             "Verifier-safety basis (demo/verifier/check.py): C1 path+name, C2 pk rename (`as <pk>`) + unique/not_null in `_<source>__models.yml`,",
             "C3 `cents_to_dollars('x_cents')` + no `*_cents` + sum==cents/100, C4 `to_utc('x')` + `_at` name + timestamp type,",
             "C5 row count == non-deleted rows and no `_is_deleted` column, C6 `dbt build --select <model>` passes. SQL comments are stripped",
             "before regexes. Column order, whitespace, YAML descriptions and extra YAML columns are never inspected. K1-K4 controls only touch",
             "`stg_shop__customers` (is_vip) and an analysis; the applicable rules are written for new staging models and do not require changing", "existing models or analyses.", "",
             "## applicable40 (36 added rules)", "",
             "| # | id | rule | why it applies | why it cannot fail a check |", "|---|---|---|---|---|"]
    for n, (a, t) in enumerate(zip(app, APPLICABLE), 1):
        lines.append(f"| {n} | {a['id']} | {t[0]} | {t[1]} | {t[2]} |")
    lines += ["", "Real bullets sit at positions 6, 16, 26, 36 (1-indexed) via `make_arms.spread`.", "",
              "## overgeneral (4 reworded bullets)", "",
              "Same 4 lessons with the `staging models` / `new source` scope removed so they read as universal. Intended failure mode:",
              "the model over-applies them to the control tasks (K4 on `control-payments-by-month` needs `total_cents` in cents; K3 on",
              "`control-customers-vip` must keep existing columns/row counts and not restructure)."]
    lines += ["", "## conflict (4 real + 4 stale)", "",
              "Order: stale-money, REAL-money, stale-timestamps, REAL-timestamps, REAL-soft-delete, stale-soft-delete, REAL-yml, stale-naming.",
              "Stale-before-real for money and timestamps; stale-after-real for soft deletes and naming/yml.", "",
              "Note: the 4 real bullets contain no naming rule (L-8aba is YAML registration), so stale (d) contradicts the verifier/gold",
              "convention `stg_<source>__<entity>` (C1) and is paired with L-8aba, adding a YAML-entry name clause that touches registration.", ""]
    for k, v in STALE.items():
        lines.append(f"- {v[0]} ({k}, {v[2]}): {v[1]}")
    open(os.path.join(ARMS, "arms2-review.md"), "w").write("\n".join(lines) + "\n")
    for k, (n, b) in stats.items():
        print(f"{k:13} bullets={n:3d} bytes={b}")


if __name__ == "__main__":
    main()
