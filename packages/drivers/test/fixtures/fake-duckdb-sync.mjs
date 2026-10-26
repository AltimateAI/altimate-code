// Stand-in for the duckdb binding whose open callback fires synchronously, before
// the Database constructor returns (the case a naive wrapper would hang on).
export default {
  Database: class {
    constructor(path, optsOrCb, cb) {
      const done = typeof optsOrCb === "function" ? optsOrCb : cb
      this.path = path
      if (path.includes("corrupt")) done(new Error("catalog is corrupt"))
      else done()
    }
    connect() {
      return { all: (sql, ...rest) => rest[rest.length - 1](null, [{ ok: 1, sql }]) }
    }
    close(cb) { cb && cb(null) }
  },
}
