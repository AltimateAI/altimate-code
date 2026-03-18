# E2E Tests

End-to-end tests that require real dbt installations. These are **not** run by the
default `bun run test` command — they must be run explicitly.

## Quick start

```bash
cd packages/dbt-tools

# 1. Set up dbt versions (creates venvs in test/.dbt-venvs/)
./test/e2e/setup-versions.sh          # all versions: 1.7, 1.8, 1.9, 1.10, 1.11
./test/e2e/setup-versions.sh 1.8 1.10 # specific versions only

# 2. Set up Python env scenarios (creates envs in test/.dbt-resolve-envs/)
./test/e2e/setup-resolve.sh           # all: venv, uv, pipx, conda, poetry, pyenv, system

# 3. Run
bun run test:e2e
```

## What's tested

### `dbt-versions.test.ts` (~138s, 60 tests)

Tests `execDbtShow`, `execDbtCompile`, `execDbtCompileInline`, and `execDbtLs` against
real dbt commands across **5 dbt versions** (1.7, 1.8, 1.9, 1.10, 1.11). Each version:

- Seeds and builds a DuckDB-based fixture project
- Executes inline SQL and ref queries
- Compiles models and inline Jinja
- Lists children/parents via `dbt ls`
- Logs which JSON field paths each version uses (diagnostic)

### `resolve.test.ts` (~30s, 43 tests)

Tests `resolveDbt`, `validateDbt`, and `buildDbtEnv` against **10 real Python
environment scenarios**:

| Scenario | Package manager | What's tested |
|----------|----------------|---------------|
| venv | `python -m venv` | sibling-of-pythonPath resolution |
| uv | `uv venv` + `uv pip` | project-local .venv discovery |
| pipx | `pipx install` | PATH-based resolution |
| conda | `conda create` | CONDA_PREFIX resolution |
| poetry | `poetry` (in-project) | .venv discovery |
| pyenv-venv | `pyenv` + venv | pyenv shim resolution |
| system | whatever's on PATH | PATH fallback |
| VIRTUAL_ENV | env var only | activated-venv resolution |
| ALTIMATE_DBT_PATH | explicit override | highest-priority override |
| project-root-only | no pythonPath | auto-discovery from project root |

## Environment variables

| Variable | Effect |
|----------|--------|
| `DBT_E2E_VERSIONS` | Comma-separated dbt versions to test (e.g., `1.8,1.10`) |
| `DBT_E2E_SKIP=1` | Skip dbt-versions tests entirely |
| `DBT_RESOLVE_SCENARIOS` | Comma-separated scenarios to test (e.g., `venv,uv`) |
| `DBT_RESOLVE_E2E_SKIP=1` | Skip resolver e2e tests entirely |

## CI integration

Add as a separate job that runs on merge to main (not on every PR push):

```yaml
e2e-dbt:
  name: "E2E: dbt multi-version"
  runs-on: ubuntu-latest
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with: { bun-version: "1.3.10" }
    - run: bun install
    - run: cd packages/dbt-tools && ./test/e2e/setup-versions.sh 1.8 1.10 1.11
    - run: cd packages/dbt-tools && ./test/e2e/setup-resolve.sh venv uv system
    - run: cd packages/dbt-tools && bun run test:e2e
      timeout-minutes: 10
```
