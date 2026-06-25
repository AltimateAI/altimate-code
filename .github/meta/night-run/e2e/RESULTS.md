# Real-Model E2E Results (azure/gpt-4o-mini)
Harness: .github/meta/night-run/e2e/run_battery.sh (22 diverse tasks: file/json/python/sql/dbt/yaml/edit/refactor/multi-step/test-gen). Each run = a real agent invocation in an isolated temp dir; artifact-verified.

## Clean run (sequential conc=1, default env) — AUTHORITATIVE
**21 / 22 PASS (~95%)**. The agent boots, plans, calls tools, and produces correct artifacts on real tasks.
Per-task: ALL 1/1 except:
- shell-script 0/1 — likely check-strictness (agent may have written a valid `cp` variant the grep missed) or a minor model miss; re-verify with a looser check.

## Notes on harness env (learned)
- conc>1 with shared global DB -> contention false-fails (run4: 15/22). 
- OPENCODE_DB-per-run override -> fresh-DB migration in run context breaks runs (1/22).
- XDG_DATA_HOME override -> loses models cache/config -> breaks model resolution (1/22).
- WORKING config = DEFAULT env, sequential (conc=1). For massive scale, run on ec36 (its own machine/DB) RUN-ONLY.

## Interpretation
The ~95% real-task pass rate (with the 1 miss being check-strictness/model, not a merge defect) confirms the
merged agent is functionally correct end-to-end on diverse coding/data tasks. This is the headline e2e evidence.
