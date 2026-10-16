/** Preserve integer precision at JSON boundaries without changing BigInt.prototype. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

/** Copy JSON-shaped data, preserving SDK media; storage can opt into safe integer numbers. */
export function normalizeBigInts<T>(value: T, mode: "string" | "safe-number" = "string"): T {
  const seen = new WeakMap<object, unknown>()
  const visit = (child: unknown): unknown => {
    if (typeof child === "bigint") {
      const number = Number(child)
      return mode === "safe-number" && Number.isSafeInteger(number) ? number : child.toString()
    }
    if (child === null || typeof child !== "object") return child
    const proto = Object.getPrototypeOf(child)
    if (!Array.isArray(child) && proto !== Object.prototype && proto !== null) return child
    if (seen.has(child)) return seen.get(child)
    const copy: Record<string, unknown> | unknown[] = Array.isArray(child)
      ? new Array(child.length)
      : Object.create(proto)
    seen.set(child, copy)
    for (const [key, item] of Object.entries(child)) {
      Object.defineProperty(copy, key, { value: visit(item), enumerable: true, configurable: true, writable: true })
    }
    return copy
  }
  return visit(value) as T
}
