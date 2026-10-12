# Near distractors (trigger globs that match files in the acme-shop project)

None of these touch what a new staging model must do: name/location, CTE shape, primary-key rename, `_<source>__models.yml` tests, `cents_to_dollars`, `to_utc`/`_at`, `_is_deleted` filtering, sources yml. Verifier checks C1-C6 only read the new staging SQL/YAML and the built model, and dbt_project.yml/macros/seeds are restored from the pristine project before scoring.

- `L-c420` triggers ['models/**', 'dbt_project.yml']: Mart folders set `+materialized: table` once in `dbt_project.yml`, and mart models do not repeat it in their own config blocks, so project-level configuration changes are easy to find and review in isolation.
  - Why it cannot change a staging answer: Scoped to mart folders; staging views are configured by the existing `staging:` block and the verifier restores `dbt_project.yml` anyway.
- `L-1f73` triggers ['models/**']: Dashboard exposures live in `models/marts/_exposures.yml`, each with an owner email and a `maturity` of high, medium or low, so the model layers stay predictable for every analyst who navigates the project.
  - Why it cannot change a staging answer: Concerns `_exposures.yml` under marts; a staging task creates no exposure.
- `L-30c0` triggers ['models/**']: Intermediate models are prefixed `int_`, live in `models/intermediate/`, and are never granted to BI roles, so the model layers stay predictable for every analyst who navigates the project.
  - Why it cannot change a staging answer: Concerns the intermediate layer; staging models are neither `int_` nor BI-facing.
- `L-235d` triggers ['models/**/*.sql']: Joins in mart models are written with explicit `inner` or `left` types, with a comment whenever a fan-out is intended, so the model layers stay predictable for every analyst who navigates the project.
  - Why it cannot change a staging answer: Only about joins in mart models; a staging model has a single `source` CTE and no joins.
- `L-05e0` triggers ['macros/**']: Every macro under `macros/` opens with a Jinja comment block stating its purpose, its arguments and one example call, so a change to shared SQL helpers does not break models in other packages without warning.
  - Why it cannot change a staging answer: Macro documentation; a staging task consumes `cents_to_dollars`/`to_utc` but does not write macros.
- `L-dc0a` triggers ['macros/**']: A new macro is merged only together with a unit test under `tests/generic/` or `unit_tests/` that exercises it, so a change to shared SQL helpers does not break models in other packages without warning.
  - Why it cannot change a staging answer: Applies when a macro is added; the staging answer adds none (and the verifier restores `macros/`).
- `L-423b` triggers ['**/*.yml']: YAML for mart models declares `meta.owner` with a team name, and mart column descriptions state business meaning rather than the SQL, so reviewers can scan project metadata consistently across folders.
  - Why it cannot change a staging answer: Explicitly limited to mart YAML; staging YAML keeps its own `unique`/`not_null` on the renamed key, and `meta.owner` is not checked.
- `L-3f3b` triggers ['**/*.yml']: YAML files use two-space indentation with no tabs and end with a single trailing newline, so reviewers can scan project metadata consistently across folders.
  - Why it cannot change a staging answer: Pure formatting (indent/newline) that the existing YAML already follows; cannot change which tests or names are declared.
- `L-f6db` triggers ['dbt_project.yml']: Bump the project `version` in `dbt_project.yml` only when a release tag is cut, never inside a feature PR, so project-level configuration changes are easy to find and review in isolation.
  - Why it cannot change a staging answer: Release-time versioning of `dbt_project.yml`; no staging model edits that file, and the verifier restores it.
- `L-9c07` triggers ['dbt_project.yml', 'packages.yml']: Pin dbt packages to exact versions in `packages.yml` and upgrade them in their own PR so a bump never hides in a feature change.
  - Why it cannot change a staging answer: About `packages.yml`/`dbt deps`; unrelated to a new staging model.
- `L-c49f` triggers ['seeds/**']: Seed CSVs use lower_snake_case headers and end with a trailing newline, and an existing seed is never reformatted inside a feature PR, because seed changes are reviewed as data changes and are expensive to unwind once deployed.
  - Why it cannot change a staging answer: Seed formatting and a no-reformat rule; the verifier restores seeds from the pristine project and the task adds none.
- `L-6553` triggers ['models/**']: Tag every mart model with its business domain (`finance`, `growth` or `ops`) so the nightly job can select it by tag.
  - Why it cannot change a staging answer: Tagging applies to mart models only; staging models need no tags and none are checked.
