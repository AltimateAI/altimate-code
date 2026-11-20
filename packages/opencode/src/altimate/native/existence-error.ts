/**
 * The engine's existence findings, which mean nothing without a schema.
 * Dependency-free so callers can use it without loading the native core binding.
 */
const EXISTENCE_CODES = new Set(["E001", "E002"])
const EXISTENCE_KINDS = new Set(["TableNotFound", "ColumnNotFound"])
export function isExistenceError(err: unknown): boolean {
  const e = err as { code?: unknown; kind?: { type?: unknown } } | null
  return EXISTENCE_CODES.has(String(e?.code)) || EXISTENCE_KINDS.has(String(e?.kind?.type))
}
