# Compilation Errors

Compilation errors happen before SQL hits the database. They're Jinja, YAML, or reference problems.

## Diagnosis

```bash
altimate-dbt compile --model <name>
```

## Common Compilation Errors

### `Compilation Error: Model 'model.project.name' depends on a node named 'missing_model'`

**Cause**: `{{ ref('missing_model') }}` references a model that doesn't exist.

**Fix**:
1. Check the spelling: `glob models/**/*missing_model*`
2. Check if it's in a package: `glob dbt_packages/**/*missing_model*`
3. If it should be a source: use `{{ source('src', 'table') }}` instead

### `Compilation Error: 'source_name' is undefined`

**Cause**: Source not defined in any `sources.yml`.

**Fix**: Create or update `sources.yml` with the source definition.

### `Parsing Error in YAML`

**Cause**: Invalid YAML syntax (bad indentation, missing colons, unquoted special characters).

**Fix**: Check indentation (must be spaces, not tabs). Ensure strings with special characters are quoted.

### `Compilation Error: Jinja template not found`

**Cause**: Missing macro or wrong macro path.

**Fix**:
1. Check `macros/` directory
2. Check `dbt_packages/` for package macros
3. Verify `packages.yml` is installed: `altimate-dbt deps`

### `dbt_utils is undefined`

**Cause**: Package not installed.

**Fix**:
```bash
altimate-dbt deps
```

## General Approach

1. Read the full error message — it usually tells you exactly which file and line
2. Open that file and read the surrounding context
3. Check for typos in `ref()` and `source()` calls
4. Verify all packages are installed with `altimate-dbt deps`
