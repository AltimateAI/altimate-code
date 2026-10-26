export * as Wildcard from "./wildcard"

export function match(input: string, pattern: string) {
  return matchNormalized(input.replaceAll("\\", "/"), pattern.replaceAll("\\", "/"))
}

// altimate_change start — preserve POSIX backslashes when matching filesystem paths
export function matchPath(input: string, pattern: string) {
  if (process.platform === "win32") return match(input, pattern)
  return matchNormalized(input, pattern)
}
// altimate_change end

function matchNormalized(input: string, pattern: string) {
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(input)
}
