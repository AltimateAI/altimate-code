// String-aware JSONC comment stripper, shared by census.ts's exemptions
// loader and unclosed-marker allowlist loader.
//
// The previous approach (`text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")`)
// only avoided stripping `//` when it was immediately preceded by `:` — a
// heuristic aimed at protecting `http://`/`https://` URLs. Any OTHER `//`
// occurrence inside a JSON string value (a path, a regex-like description, a
// URL not preceded by `:` due to line wrapping, etc.) was silently truncated
// as if it were a line comment, corrupting the parsed value without any
// error. This version tracks whether the scanner is inside a double-quoted
// JSON string (honoring `\"` escapes) and only treats `//` / `/* */` as
// comment syntax when outside of a string.

export function stripJsonComments(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  let inString = false

  while (i < n) {
    const ch = text[i]

    if (inString) {
      out += ch
      if (ch === "\\" && i + 1 < n) {
        // Preserve the escaped character verbatim so `\"` doesn't end the
        // string early and `\\` doesn't desync the escape tracking.
        out += text[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
      continue
    }

    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2 // skip the closing */ (or run past EOF harmlessly if unterminated)
      continue
    }

    out += ch
    i++
  }

  return out
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text))
}
