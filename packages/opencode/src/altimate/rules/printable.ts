// altimate_change - new file
//
// Text from the workspace server or a model (a rule, a reviewer's name or reason, an error, a staged rule) shown in the
// terminal: the CLI's output and the TUI's card, menu and toasts. One helper so the two cannot drift.
import { stripBidiControls } from "../workspace/workspace-name"

/** `text` on one line and inert: control characters (C0, DEL, C1) and the line/paragraph separators become spaces, and
 * bidi controls are removed, so it cannot move the cursor, retitle the terminal, plant a hyperlink or reorder itself. */
export function printable(text: string | undefined): string {
  return stripBidiControls((text ?? "").replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " "))
}

/** `value` with every string in it made `printable`, for JSON a client or agent reads (`JSON.stringify` keeps bidi
 * controls as they are). */
export function printableDeep<T>(value: T): T {
  if (typeof value === "string") return printable(value) as T
  if (Array.isArray(value)) return value.map(printableDeep) as T
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, printableDeep(entry)])) as T
  return value
}
