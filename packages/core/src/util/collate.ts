// altimate_change — the one comparator for anything whose order reaches a prompt.
//
// Two separate requirements, and `localeCompare` fails both:
//
//   Machine-independence. Without an explicit locale it follows the runtime's LANG/ICU data, so
//   two machines order the same list differently. Exact-prefix caches (Vertex/Gemini, OpenAI)
//   stop at the first differing byte, so that alone can cost the entire shared prefix. Worse, in
//   the skill path the list is sliced to a display limit, so collation decides WHICH skills the
//   model is offered, not merely their order.
//
//   Stability across representations. `<` on strings compares UTF-16 CODE UNITS, not Unicode
//   scalar values. Astral characters are stored as surrogate pairs in 0xD800-0xDFFF, which sit
//   BELOW the private-use area 0xE000-0xF8FF, so `"\u{10000}" < ""` is true by code unit
//   and false by scalar value. Any name containing an emoji or a PUA glyph therefore sorts
//   inconsistently with a code-point ordering, which is the ordering every other tool means when
//   it says "sorted".
//
// `compareCodePoints` iterates code points, so the result matches scalar-value order everywhere.
// It is not a locale-aware ordering and is not meant to be: this is for machine-facing lists
// whose only requirement is that every machine produces the same bytes. Use `localeCompare` for
// anything a human reads in a UI.

/**
 * Compare two strings by Unicode code point. Deterministic across locales and runtimes.
 *
 * Returns a negative number, zero, or a positive number, matching the Array#sort contract.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0
  const ai = a[Symbol.iterator]()
  const bi = b[Symbol.iterator]()
  for (;;) {
    const x = ai.next()
    const y = bi.next()
    if (x.done === true) return y.done === true ? 0 : -1
    if (y.done === true) return 1
    if (x.value === y.value) continue
    // Single code point each, so codePointAt(0) is the whole scalar value.
    return x.value.codePointAt(0)! - y.value.codePointAt(0)!
  }
}

/** `compareCodePoints` lifted to a named field — the shape most call sites want. */
export function byCodePoints<T>(select: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => compareCodePoints(select(a), select(b))
}
