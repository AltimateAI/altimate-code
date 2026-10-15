import path from "node:path"
// altimate: ALT-F01
import { existsSync } from "node:fs"

// altimate: ALT-F01
const startupDirectory = process.cwd()
const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined

export function selfCommand() {
  const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
  if (runtime !== "bun" && runtime !== "node" && runtime !== "nodejs") return [process.execPath]
  if (!entrypoint) throw new Error("Failed to resolve CLI entrypoint")
  if (runtime === "node" || runtime === "nodejs") return [process.execPath, ...nodeFlags(), entrypoint]
  // altimate: ALT-F01
  const preloads =
    typeof globalThis.__OPENCODE_IDENTITY__ === "undefined"
      ? []
      : process.execArgv.flatMap((arg, index, args) => {
          const file =
            arg === "--preload"
              ? args[index + 1]
              : arg.startsWith("--preload=")
                ? arg.slice("--preload=".length)
                : undefined
          if (!file) return []
          const resolved = path.resolve(startupDirectory, file)
          return ["--preload", file.startsWith(".") || existsSync(resolved) ? resolved : file]
        })
  return [process.execPath, ...preloads, entrypoint]
}

function nodeFlags() {
  return process.execArgv.flatMap((arg, index, args) => {
    if (index > 0 && args[index - 1] === "--conditions") return []
    if (arg === "--conditions") return args[index + 1] ? [arg, args[index + 1]] : []
    if (arg.startsWith("--conditions=")) return [arg]
    if (
      arg === "--experimental-ffi" ||
      arg === "--use-system-ca" ||
      arg === "--enable-source-maps" ||
      arg === "--no-addons"
    )
      return [arg]
    if (arg === "--no-warnings" || arg.startsWith("--disable-warning=")) return [arg]
    return []
  })
}
