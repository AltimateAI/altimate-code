/**
 * JSON codec for values crossing the stdio boundary to a local-engine helper
 * process. Plain JSON cannot carry what DuckDB and SQLite return (BigInt,
 * Date, blobs, NaN/Infinity), so those are wrapped as `{ $t, v }` tags.
 * Dictionaries are rebuilt with a null prototype so a column named `__proto__`
 * stays an ordinary key instead of invoking the inherited setter.
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
  const out: Record<string, unknown> = Object.create(null)
  for (const k of Object.keys(v)) out[k] = pack((v as Record<string, unknown>)[k])
  return Object.prototype.hasOwnProperty.call(out, "$t") ? { $t: "obj", v: out } : out
}

export function unpack(v: any): any {
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map(unpack)
  if (typeof v.$t === "string") {
    if (v.$t === "bigint") return BigInt(v.v)
    if (v.$t === "num") return Number(v.v)
    if (v.$t === "date") return v.v === null ? new Date(NaN) : new Date(v.v)
    if (v.$t === "bytes") return new Uint8Array(Buffer.from(v.v, "base64"))
    if (v.$t === "obj") {
      const o: Record<string, unknown> = Object.create(null)
      for (const k of Object.keys(v.v)) o[k] = unpack(v.v[k])
      return o
    }
  }
  const out: Record<string, unknown> = Object.create(null)
  for (const k of Object.keys(v)) out[k] = unpack(v[k])
  return out
}
