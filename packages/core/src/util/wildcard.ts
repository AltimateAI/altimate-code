export * as Wildcard from "./wildcard"

// altimate_change start — preserve POSIX backslashes when matching filesystem paths
export function match(input: string, pattern: string) {
  return matchNormalized(input.replaceAll("\\", "/"), pattern.replaceAll("\\", "/"))
}

export function matchPath(input: string, pattern: string) {
  if (process.platform === "win32") return match(input, pattern)
  return matchNormalized(input, pattern)
}

function matchNormalized(input: string, pattern: string) {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(input)
}
// altimate_change end
