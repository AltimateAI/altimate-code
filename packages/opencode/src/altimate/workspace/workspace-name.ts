// altimate_change - new file
//
// The one piece of workspace text handling that BOTH realms need: the session
// code renders the name into the system prompt, and the TUI plugin renders it
// into a dialog header. Kept free of imports and module state on purpose —
// `precedence.ts`, where this lived, is server-side only (see its header), and
// a plugin importing it would load a second copy of that module's state into
// the plugin realm.
/** The workspace name as model-visible text: control characters stripped (C0, DEL and
 * the C1 range — NEL U+0085 is a line break that `\s` does not match), the Unicode
 * line and paragraph separators too, whitespace collapsed onto one line, length
 * bounded in code points so a cut never leaves a lone surrogate. Quoting is the
 * caller's choice — the system-prompt section JSON-quotes it as well — but nothing
 * that passes through here can start a new line, and so a new heading or role, in
 * what the model reads. */
export const MAX_WORKSPACE_NAME_CHARS = 80
export function inertWorkspaceName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const points = Array.from(cleaned)
  return points.length > MAX_WORKSPACE_NAME_CHARS ? points.slice(0, MAX_WORKSPACE_NAME_CHARS - 1).join("") + "…" : cleaned
}

/** The rendered label — quoted name plus id — after JSON escaping, budgeted on that
 * ENCODED form. `inertWorkspaceName` bounds the name to 80 code points, but escaping
 * expands a quote or backslash to two units and a lone surrogate to six; without a
 * budget on the encoded form, 80 lone surrogates pushed a fixed-shape section past
 * its cap and clipped the instruction mid-sentence. Lone surrogates are replaced
 * first (U+FFFD), so the worst case is 80 escaped quotes (162 units) plus a 16-digit
 * id — just over the default budget, where the NAME is shortened with an ellipsis and
 * the id is kept whole. One formatter for every model-visible label, so a hardening
 * change here cannot skip a caller. */
export const MAX_LABEL_CHARS = 180
export function workspaceLabel(name: string, id: string | undefined, budget = MAX_LABEL_CHARS): string {
  // A name that sanitises to nothing must not erase the identity: the id is the
  // stable half, and `""` reads as a bug.
  const points = Array.from(inertWorkspaceName(name).toWellFormed())
  const suffix = id ? ` (id ${id})` : ""
  let label = `${JSON.stringify(points.join("") || "(unnamed)")}${suffix}`
  while (label.length > budget && points.length > 0) {
    points.pop()
    label = `${JSON.stringify(points.join("") + "…")}${suffix}`
  }
  // Only an id longer than the budget can get here; the id is the stable half,
  // so it is what survives.
  return label.length > budget ? suffix.trim() : label
}
