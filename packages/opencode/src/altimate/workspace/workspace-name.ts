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
