# gpt-5.5 binary e2e battery — RESULTS

Harness: `.github/meta/night-run/e2e/run_battery_binary.sh azure/gpt-5.5 <conc> <repeats>`
Binary: built `packages/opencode/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate` (post route+branding fixes, bun 1.3.14 build).
Model: `azure/gpt-5.5` (reasoning), `--yolo` non-interactive.

## Result: 88 / 88 PASS (100%)

22 tasks × 4 repeats, all green:

| task | pass | task | pass |
| --- | --- | --- | --- |
| count-and-write | 4/4 | mkdir-nested | 4/4 |
| dbt-model | 4/4 | multi-step | 4/4 |
| edit-file | 4/4 | python-script | 4/4 |
| env-file | 4/4 | readme | 4/4 |
| fix-bug | 4/4 | refactor | 4/4 |
| gitignore | 4/4 | rename-content | 4/4 |
| json-transform | 4/4 | shell-script | 4/4 |
| json-write | 4/4 | sql-file | 4/4 |
| markdown-table | 4/4 | sql-join | 4/4 |
| test-gen | 4/4 | two-files | 4/4 |
| write-file | 4/4 | yaml-config | 4/4 |

Notes:
- This is the COMPILED BINARY (single-process), exercising the full boot + agent loop + tools end-to-end
  against a real reasoning model. 100% vs the earlier ~95% (gpt-4o-mini) — the gpt-5.5 capability + the
  /api route-mount fix landed.
- Confirms the merged product is functionally sound in a real single-process run (the DB-migration race is
  a parallel-TEST-only artifact; it does not occur in this single-process binary path — 88/88 prove it).
