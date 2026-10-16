// Probe worker: runs a deliberately huge query on bun:sqlite or duckdb inside a Worker.
declare var self: Worker
self.onmessage = async (e: MessageEvent) => {
  const { engine } = e.data
  self.postMessage({ started: true })
  if (engine === "sqlite") {
    const { Database } = await import("bun:sqlite")
    const db = new Database(":memory:")
    db.prepare("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 4000000000) SELECT count(*) AS n FROM c").all()
  } else {
    const duckdb: any = (await import("duckdb")).default
    const db = new duckdb.Database(":memory:")
    const con = db.connect()
    con.all("SELECT count(*) FROM range(100000000000) a, range(1000) b", () => {})
  }
  self.postMessage({ done: true })
}
