/**
 * JSON codec for values crossing the stdio boundary to a local-engine helper
 * process. Plain JSON cannot carry what DuckDB and SQLite return (BigInt,
 * Date, blobs, NaN/Infinity), so those are wrapped as `{ $t, v }` tags.
 * Dictionaries are rebuilt as plain objects with own data properties so
 * `__proto__` remains an ordinary key and STRUCT values support String().
 * Mirrored in `local-engine-child-source.ts`; the unit tests round-trip both.
 */

export function pack(v: unknown): unknown {
  if (typeof v === "bigint") return { $t: "bigint", v: v.toString() }
  if (typeof v === "number") return Number.isFinite(v) ? v : { $t: "num", v: String(v) }
  if (v === null || typeof v !== "object") return v
  if (v instanceof Date) return { $t: "date", v: Number.isNaN(v.getTime()) ? null : v.toISOString() }
  if (v instanceof Uint8Array) {
    return { $t: "bytes", v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") }
  }
  if (Array.isArray(v)) return v.map(pack)
  const out = Object.fromEntries(Object.keys(v).map((k) => [k, pack((v as Record<string, unknown>)[k])]))
  return Object.prototype.hasOwnProperty.call(out, "$t") ? { $t: "obj", v: out } : out
}

export function unpack(v: any): any {
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map(unpack)
  if (typeof v.$t === "string") {
    if (v.$t === "bigint") return BigInt(v.v)
    if (v.$t === "num") return Number(v.v)
    if (v.$t === "date") return v.v === null ? new Date(NaN) : new Date(v.v)
    if (v.$t === "bytes") return Buffer.from(v.v, "base64")
    if (v.$t === "obj") {
      return Object.fromEntries(Object.keys(v.v).map((k) => [k, unpack(v.v[k])]))
    }
  }
  return Object.fromEntries(Object.keys(v).map((k) => [k, unpack(v[k])]))
}
