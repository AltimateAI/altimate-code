/** Serialized result size, not a process heap limit: one row/client chunk can be in flight. */
export const RESULT_BYTE_LIMIT_CODE = "RESULT_BYTE_LIMIT"

export class ResultByteLimitError extends Error {
  readonly code = RESULT_BYTE_LIMIT_CODE

  constructor(readonly maxBytes: number) {
    super(`Source result exceeds the ${maxBytes} byte result limit.`)
    this.name = "ResultByteLimitError"
  }
}

export function isResultByteLimitError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === RESULT_BYTE_LIMIT_CODE
}

/** Match the materialization codec, including UTF-8, bigint, dates and binary data. */
export function rowBytes(row: unknown[]): number {
  const primitive = row.every((value) => value === null || (typeof value !== "object" && typeof value !== "bigint"))
  return Buffer.byteLength(
    primitive
      ? JSON.stringify(row)
      : JSON.stringify(row, (_key, value) =>
          typeof value === "bigint"
            ? value.toString()
            : value instanceof Uint8Array
              ? Buffer.from(value).toString("hex")
              : value,
        ),
    "utf8",
  )
}

/** Call before retaining each row; stop/close the producer when this throws. */
export function createResultByteBudget(maxBytes: number | undefined): (row: unknown[]) => void {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new Error("maxResultBytes must be a positive safe integer")
  }
  let bytes = 0
  return (row) => {
    if (maxBytes === undefined) return
    bytes += rowBytes(row)
    if (bytes > maxBytes) throw new ResultByteLimitError(maxBytes)
  }
}
