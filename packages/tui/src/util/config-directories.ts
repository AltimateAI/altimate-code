import path from "node:path"
import { stat } from "node:fs/promises"
// altimate: ALT-F01
import { Identity } from "@opencode/util/identity"

export function configDirectories(config: string, cwd: string) {
  // altimate: ALT-F01
  return [
    ...new Set([
      config,
      ...ancestors(cwd).flatMap((directory) =>
        Identity.configBasenames.map((name) => path.join(directory, `.${name}`)),
      ),
    ]),
  ]
}

export function projectConfigDirectories(project: string, cwd: string) {
  const directories = ancestors(cwd)
  return (
    directories
      .slice(directories.indexOf(path.resolve(project)))
      // altimate: ALT-F01
      .flatMap((directory) => Identity.configBasenames.map((name) => path.join(directory, `.${name}`)))
  )
}

export async function localProjectDirectory(cwd: string) {
  const directories = ancestors(cwd)
  const repositories = await Promise.all(
    directories.map((directory) =>
      Promise.all(
        [".git", ".hg"].map((name) =>
          stat(path.join(directory, name)).then(
            () => true,
            (error) => (isMissingPath(error) ? false : Promise.reject(error)),
          ),
        ),
      ).then((matches) => matches.some(Boolean)),
    ),
  )
  return directories.findLast((_, index) => repositories[index]) ?? path.resolve(cwd)
}

export function isMissingPath(error: unknown) {
  if (!error || typeof error !== "object") return false
  const code = "code" in error ? error.code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

function ancestors(cwd: string) {
  const directories: string[] = []
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    directories.push(current)
    if (path.dirname(current) === current) break
  }
  return directories.reverse()
}
