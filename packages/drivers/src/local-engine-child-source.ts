/**
 * Source of the helper process that owns one local database handle
 * (`bun:sqlite` or the legacy `duckdb` binding).
 *
 * It is a string, not a separate entrypoint, on purpose: the compiled
 * `altimate` binary can only run files that exist on disk, and a string needs
 * no change to the build's entrypoint list. `local-engine.ts` writes it to a
 * content-addressed file and runs it with Bun.
 *
 * Why a process and not a Worker: measured on Bun 1.3.14, `Worker.terminate()`
 * does not stop a blocking `bun:sqlite` call (the thread kept using 100% CPU
 * after terminate), and loading the `duckdb` addon in a Worker aborts Bun with
 * a NAPI panic. Killing a process is the only cancellation that is certain to
 * stop the work and release file locks. See
 * `test/fixtures/cancel-probe.ts`.
 *
 * Protocol: one JSON object per line on stdin (`{id, op, ...}`), one per line
 * on stdout (`{id, ok, result | error}`). Requests run strictly in order.
 *
 * Constraints on this text: plain JavaScript, no backticks, no `${`.
 */
export const LOCAL_ENGINE_CHILD_SOURCE = String.raw`
"use strict";
// ---- value codec (mirrors local-engine-codec.ts) ----
function pack(v) {
  if (typeof v === "bigint") return { $t: "bigint", v: v.toString() };
  if (typeof v === "number") return Number.isFinite(v) ? v : { $t: "num", v: String(v) };
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return { $t: "date", v: Number.isNaN(v.getTime()) ? null : v.toISOString() };
  if (v instanceof Uint8Array) return { $t: "bytes", v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
  if (Array.isArray(v)) return v.map(pack);
  const out = Object.fromEntries(Object.keys(v).map((k) => [k, pack(v[k])]));
  return Object.prototype.hasOwnProperty.call(out, "$t") ? { $t: "obj", v: out } : out;
}
function unpack(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(unpack);
  if (typeof v.$t === "string") {
    if (v.$t === "bigint") return BigInt(v.v);
    if (v.$t === "num") return Number(v.v);
    if (v.$t === "date") return v.v === null ? new Date(NaN) : new Date(v.v);
    if (v.$t === "bytes") return Buffer.from(v.v, "base64");
    if (v.$t === "obj") return Object.fromEntries(Object.keys(v.v).map((k) => [k, unpack(v.v[k])]));
  }
  return Object.fromEntries(Object.keys(v).map((k) => [k, unpack(v[k])]));
}

// ---- orphan watchdog ----
// A blocking native call stops this thread from noticing that the parent died,
// so a separate thread polls the parent pid and ends the process.
const parentPid = Number(process.argv[2]);
if (parentPid > 0) {
  const watchdog = [
    "const ppid = " + parentPid + ";",
    "setInterval(() => {",
    "  let alive = true;",
    "  try { process.kill(ppid, 0); } catch (e) { alive = e && e.code === 'EPERM'; }",
    "  if (!alive) process.kill(process.pid, 'SIGKILL');",
    "}, 1000);",
  ].join("\n");
  try {
    new Worker(URL.createObjectURL(new Blob([watchdog], { type: "text/javascript" })));
  } catch (e) { /* best effort; stdin EOF below still ends an idle child */ }
}

// ---- engine state ----
let engine = null;
let sqliteDb = null;
let duckDb = null;
let duckCon = null;
const duckConnections = new Map();

function closeDuckConnections() {
  for (const connection of [...duckConnections.values(), duckCon]) {
    try { if (connection && typeof connection.close === "function") connection.close(() => {}); } catch (e) {}
  }
  duckConnections.clear();
  duckCon = null;
}

function closeQuietly() {
  try { if (sqliteDb) sqliteDb.close(); } catch (e) {}
  closeDuckConnections();
  try { if (duckDb && typeof duckDb.close === "function") duckDb.close(); } catch (e) {}
  sqliteDb = null; duckDb = null; duckCon = null;
}

async function open(p) {
  closeQuietly();
  engine = p.engine;
  if (engine === "sqlite") {
    const { Database } = await import("bun:sqlite");
    sqliteDb = new Database(p.path, { readonly: p.readonly, readwrite: p.readwrite, create: p.create });
    if (p.wal) sqliteDb.exec("PRAGMA journal_mode = WAL");
    return null;
  }
  const mod = await import(p.modulePath);
  const duckdb = mod.default || mod;
  const opts = {
    // Keep spill files out of the caller's cwd and separate across helpers.
    temp_directory: process.env.TMPDIR + "/duckdb-" + process.pid,
    ...(p.accessMode ? { access_mode: p.accessMode } : {}),
    ...(p.extensionDirectory ? { extension_directory: p.extensionDirectory } : {}),
  };
  let instance;
  await new Promise((resolve, reject) => {
    const cb = (err) => (err ? reject(err) : resolve());
    instance = opts ? new duckdb.Database(p.path, opts, cb) : new duckdb.Database(p.path, cb);
  }).catch((err) => { try { if (instance && instance.close) instance.close(); } catch (e) {} throw err; });
  duckDb = instance;
  duckCon = duckDb.connect();
  // altimate_change start — restrictions are replayed when a timed-out helper reopens
  if (typeof p.sandboxDirectory === "string") {
    const directory = "'" + p.sandboxDirectory.replace(/'/g, "''") + "'";
    for (const sql of [
      "SET allowed_directories = [" + directory + "]",
      "SET enable_external_access = false",
      "SET autoinstall_known_extensions = false",
      "SET autoload_known_extensions = false",
      "SET lock_configuration = true",
    ]) await all({ sql });
  }
  // altimate_change end
  return null;
}

// altimate_change start — cap serialized rows before either helper or parent buffers the full result
async function boundedRows(source, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxResultBytes must be a positive safe integer");
  const rows = [];
  let bytes = 0;
  for await (const row of source) {
    const values = Object.values(row);
    const primitive = values.every((v) => v === null || (typeof v !== "object" && typeof v !== "bigint"));
    const text = primitive ? JSON.stringify(values) : JSON.stringify(values, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v);
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      const error = new Error("Source result exceeds the " + maxBytes + " byte result limit.");
      error.code = "RESULT_BYTE_LIMIT";
      throw error;
    }
    rows.push(row);
  }
  return rows;
}

async function* duckRows(connection, sql, params) {
  const statement = connection.prepare(sql);
  try {
    const result = await statement.stream(...params);
    for await (const row of result) yield row;
  } finally {
    await new Promise((resolve, reject) => statement.finalize((err) => err ? reject(err) : resolve()));
  }
}
// altimate_change end

function all(p) {
  const params = (p.params || []).map(unpack);
  // altimate_change start — SQLite's iterator steps one row at a time
  if (engine === "sqlite") {
    const statement = sqliteDb.prepare(p.sql);
    return p.maxResultBytes === undefined
      ? Promise.resolve(statement.all(...params))
      : boundedRows(statement.iterate(...params), p.maxResultBytes).finally(() => statement.finalize());
  }
  // altimate_change end
  let connection = duckCon;
  if (p.connectionId !== undefined) {
    connection = duckConnections.get(p.connectionId);
    if (!connection) {
      connection = duckDb.connect();
      duckConnections.set(p.connectionId, connection);
    }
  }
  // altimate_change start — DuckDB exposes a chunked async iterator; stop it on overflow
  if (p.maxResultBytes !== undefined) return boundedRows(duckRows(connection, p.sql, params), p.maxResultBytes);
  // altimate_change end
  return new Promise((resolve, reject) => {
    connection.all(p.sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function disconnect(p) {
  const connection = duckConnections.get(p.connectionId);
  if (!connection) return null;
  duckConnections.delete(p.connectionId);
  await new Promise((resolve, reject) => {
    connection.close((err) => (err ? reject(err) : resolve()));
  });
  return null;
}

function run(p) {
  const info = sqliteDb.prepare(p.sql).run(...(p.params || []).map(unpack));
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

async function close() {
  if (duckDb) {
    const d = duckDb;
    // Native connection closes queue before the database close below, so open
    // transactions roll back and all connection handles are released first.
    closeDuckConnections();
    // The supervisor bounds a polite close; let DuckDB finish its checkpoint.
    await new Promise((resolve) => { try { d.close(() => resolve()); } catch (e) { resolve(); } });
    duckDb = null; duckCon = null;
  }
  closeQuietly();
  return null;
}

async function handle(req) {
  if (req.op === "open") return open(req.payload);
  if (req.op === "all") return all(req.payload);
  if (req.op === "run") return run(req.payload);
  if (req.op === "disconnect") return disconnect(req.payload);
  if (req.op === "close") return close();
  throw new Error("unknown op " + req.op);
}

function reply(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

(async () => {
  const decoder = new TextDecoder();
  // altimate_change start — scan each chunk once, joining a line only at its terminator
  let parts = [];
  for await (const chunk of Bun.stdin.stream()) {
    const text = decoder.decode(chunk, { stream: true });
    let start = 0;
    let nl;
    while ((nl = text.indexOf("\n", start)) >= 0) {
      parts.push(text.slice(start, nl));
      const line = parts.join("");
      parts = [];
      start = nl + 1;
      // altimate_change end
      if (!line.trim()) continue;
      const req = JSON.parse(line);
      try {
        const result = await handle(req);
        reply({ id: req.id, ok: true, result: pack(result) });
      } catch (err) {
        reply({ id: req.id, ok: false, error: { message: String((err && err.message) || err), code: err && err.code, errno: err && err.errno } });
      }
      if (req.op === "close") { setTimeout(() => process.exit(0), 25); }
    }
    // altimate_change start — retain only the unfinished suffix
    if (start < text.length) parts.push(text.slice(start));
    // altimate_change end
  }
  closeQuietly();
  process.exit(0);
})();
`
