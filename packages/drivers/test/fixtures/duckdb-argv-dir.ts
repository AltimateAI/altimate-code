// Regression fixture: open a DuckDB store through the driver while this process's
// argv carries an unrelated `--dir <path>` flag — the shape `altimate-code run --dir`
// has. `@mapbox/node-pre-gyp` parses the host argv and abbreviation-matches `--dir`
// to its `--directory`, joining it onto the absolute addon manifest path, so loading
// the binding in a process with that argv fails with ENOENT. The parent must therefore
// never load the binding; only the helper (clean argv) may.
// usage: bun run duckdb-argv-dir.ts --dir /some/unrelated/dir <store.duckdb>
const store = process.argv[process.argv.length - 1]
const { connect } = await import("../../src/duckdb")
const c = await connect({ type: "duckdb", path: store, create: true } as any)
await c.connect()
const r = await c.execute("SELECT md5('argv-probe') AS digest")
console.log(JSON.stringify({ argv: process.argv.slice(2, -1), rows: r.rows }))
await c.close()
