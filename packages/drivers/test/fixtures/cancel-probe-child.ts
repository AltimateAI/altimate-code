// Probe child process: same long query as the worker probe, as a standalone process.
const engine = process.argv[2]
if (engine === "sqlite") {
  const { Database } = await import("bun:sqlite")
  const db = new Database(":memory:")
  db.prepare("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 4000000000) SELECT count(*) AS n FROM c").all()
} else {
  const duckdb: any = (await import("duckdb")).default
  const db = new duckdb.Database(process.argv[3] || ":memory:")
  const con = db.connect()
  con.all("SELECT count(*) FROM range(100000000000) a, range(1000) b", () => {})
  setInterval(() => {}, 1000)
}
