// altimate_change - new file
//
// The one piece of workspace text handling that BOTH realms need: the session
// code renders the name into the system prompt, and the TUI plugin renders it
// into a dialog header. Kept free of imports and mutable module state on purpose —
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
  const cleaned = oneLine(name)
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

/** A name on one line: control characters (C0, DEL and C1) and the Unicode line and
 * paragraph separators become spaces, runs of whitespace collapse, ends are trimmed.
 * The one normalisation both the rendered and the compared name start from. */
function oneLine(name: string): string {
  return name
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** A name as the link pickers compare it: on one line, and the sharp S spelled out,
 * which collation otherwise keeps apart from "ss". */
function comparableName(name: string): string {
  return oneLine(name).replace(/[ßẞ]/g, "ss")
}

/** The bidi controls (ALM, LRM/RLM, LRE..RLO, LRI..PDI): harmless in a link, but they
 * can visually reverse or reorder a displayed name. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, "")
}

/** A workspace name as a dialog shows it: inert, and with no bidi controls. */
export function displayWorkspaceName(name: string): string {
  return stripBidiControls(inertWorkspaceName(name))
}

/** One collator for every comparison, pinned to `en`: an unpinned one follows the host
 * locale, and under Turkish `I` no longer pairs with `i`, under Danish `aa` equals `å`. */
export const NAME_COLLATOR = new Intl.Collator("en", { sensitivity: "accent", usage: "search" })

export interface Namesakes<T> {
  /** Every listed workspace with the name a quick create would use, in list order. */
  all: T[]
  /** The first of them the caller owns, or undefined. The only one a picker opens on: a plain
   * Enter on a namesake links to it and sends this machine's memory there, which must not
   * happen to a colleague's workspace by accident. */
  own: T | undefined
}

/** The listed workspaces already named what a quick create would call this project.
 *
 * Names compare by Unicode collation, ignoring case but not accents: `Straße` matches
 * `STRASSE`, `ΟΔΟΣ` matches `οδος` (final sigma) and `ﬁnance` matches `FINANCE` (ligature),
 * all through collation, while `ı` and `i` or `café` and `cafe` stay different.
 * Characters collation ignores, such as zero-width and bidi controls, do not make a name
 * different. Ownership counts only when both the owner and the caller are known. */
export function findNamesakes<T extends { name: string; ownerId?: number }>(
  list: readonly T[],
  proposedName: string,
  userId: number | undefined,
): Namesakes<T> {
  const target = comparableName(proposedName)
  if (!target) return { all: [], own: undefined }
  const all = list.filter((workspace) => NAME_COLLATOR.compare(comparableName(workspace.name), target) === 0)
  const own = userId === undefined ? undefined : all.find((workspace) => workspace.ownerId === userId)
  return { all, own }
}

/** The hint a picker shows on a namesake's row, or undefined for any other row. */
export function namesakeHint<T extends { name: string; ownerId?: number }>(
  workspace: T,
  namesakes: Namesakes<T>,
  userId: number | undefined,
): string | undefined {
  if (!namesakes.all.includes(workspace)) return undefined
  const someoneElses = userId !== undefined && workspace.ownerId !== undefined && workspace.ownerId !== userId
  return someoneElses ? "same name, owned by someone else" : "same name as this project"
}

/** Where a link picker opens: the current link, else the caller's own namesake, else create. */
export function linkPickerOpensOn<T extends { id: number; name: string; ownerId?: number }>(
  currentId: number | undefined,
  namesakes: Namesakes<T>,
): number | "create" {
  return currentId ?? namesakes.own?.id ?? "create"
}

/** Whether a choice in a link picker or the setup dialog must confirm first: both create
 * paths start from the project's name, so either one would make a second namesake. */
export function confirmsNamesake(
  choice: "create" | "browser" | "workspace",
  namesakes: Namesakes<unknown>,
): boolean {
  return choice !== "workspace" && namesakes.all.length > 0
}
