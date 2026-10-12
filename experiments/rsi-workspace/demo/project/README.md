# acme-shop

dbt project for Acme's e-commerce analytics (duckdb locally).

## Layout

- `seeds/` - raw extracts loaded into the `raw` schema (stand-ins for the warehouse landing tables)
- `models/staging/<source>/` - one folder per source system (`shop`, `billing`, `support`)
- `macros/` - shared SQL helpers

## Running

```bash
dbt seed --profiles-dir . --project-dir .
dbt build --profiles-dir . --project-dir .
```

Run from the project root; the duckdb file `acme.duckdb` is created here.
`profiles.yml` lives in this directory, so pass `--profiles-dir .`.

## Contributing

Open a PR against `main`. CI runs `dbt build` and the team's review checks.
