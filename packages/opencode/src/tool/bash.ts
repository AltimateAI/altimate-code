import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"
import fs from "fs/promises"

import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"
import { Global } from "@/global"
// altimate_change start — upstream_fix: resolve literal shell paths for permission matching
import type { Node } from "web-tree-sitter"

function shellWords(node: Node) {
  return node.namedChildren.filter(
    (child): child is Node =>
      child !== null && ["command_name", "word", "string", "raw_string", "concatenation"].includes(child.type),
  )
}

function literalWord(node: Node | null): string | undefined {
  if (!node) return
  if (node.type === "raw_string") return node.text.slice(1, -1)
  if (node.type === "word") {
    if (/[~$*?{\[]/.test(node.text)) return
    return node.text.replace(/\\(.)/gs, "$1")
  }
  if (node.type === "string" && node.namedChildren.every((child) => child?.type === "string_content")) {
    return node.text.slice(1, -1).replace(/\\\n/g, "").replace(/\\([$`"\\])/g, "$1")
  }
  if (node.type === "command_name" || node.type === "concatenation") {
    const parts = node.namedChildren.map(literalWord)
    if (parts.every((part) => part !== undefined)) return parts.join("")
  }
}

// Track literal directory changes in straight-line sequences. Analyze branches
// independently and keep subshell, substitution, and pipeline changes local.
function* shellCommands(node: Node | null, cwd: string): Generator<{ node: Node; cwd: string }, string> {
  if (!node) return cwd
  if (node.type === "command") {
    yield { node, cwd }
    for (const child of node.namedChildren) yield* shellCommands(child, cwd)
    const [name, arg] = shellWords(node).map(literalWord)
    return name === "cd" && arg && !arg.startsWith("-") ? path.resolve(cwd, arg) : cwd
  }
  const sequential =
    ["program", "list", "subshell", "command_substitution", "compound_statement", "redirected_statement"].includes(node.type) &&
    !node.children.some((child) => child?.type === "||" || child?.type === "&")
  let next = cwd
  for (const child of node.namedChildren) {
    const result = yield* shellCommands(child, sequential ? next : cwd)
    if (sequential) next = result
  }
  return ["program", "list", "compound_statement", "redirected_statement"].includes(node.type) ? next : cwd
}
// altimate_change end

// altimate_change start — run-mode markers must not reach bash child processes.
// `run` sets ALTIMATE_RUN_MODE on its own process to arm run-mode-only
// mechanisms (DONE-termination gate, starvation directives, doom-loop
// escalation ladder). A nested `serve`/TUI launched through the bash tool
// inherited it and armed those mechanisms in an interactive session,
// contradicting the invariant documented in session/processor.ts. A nested
// `run` re-applies the default itself (cli/cmd/run/run-mode.ts), so nothing
// that should be in run mode loses it.
//
// Only an ACTIVE marker is stripped: an explicit opt-out
// (ALTIMATE_RUN_MODE=0/false) must SURVIVE into the child, because deleting it
// would let a nested `run` re-apply the default and turn run mode back on —
// the opposite of what the operator asked for.
//
// Exported so the contract is tested behaviourally rather than by reading this
// file's source text.
export function stripRunModeMarkers(env: Record<string, string | undefined>) {
  const active = env["ALTIMATE_RUN_MODE"]?.trim().toLowerCase()
  if (active === "1" || active === "true") delete env["ALTIMATE_RUN_MODE"]
  delete env["ALTIMATE_RUN_RESUMED"]
  return env
}

/** Markers that describe THIS process's host and must not reach a child.
 *
 * `ALTIMATE_NON_INTERACTIVE`: `run` sets it so the question tool short-circuits, but a
 * child may be a server-mode entrypoint (`altimate-code serve`) that needs its HTTP
 * question-reply path live. `ALTIMATE_CODE_HEADLESS`: the headless marker, for the same
 * reason — a nested entrypoint may well have a TUI. `ALTIMATE_CODE_SERVE`: names the
 * extension's host process, where workspace mode is off; a terminal `altimate-code`
 * started from here is not the host. The `ALTIMATE_PINNED_WORKSPACE_*` trio: the IDE
 * extension's workspace pin. Inert while the serve marker is stripped (`readPin` checks
 * it first), but a child that starts its own nested `serve` would set that marker itself
 * and then inherit a pin the session it came from was never given. The pin should only
 * ever come from the process the extension launched.
 *
 * Shared by every tool that spawns a shell (`bash`, `shell`) so the two cannot drift. */
const HOST_MARKERS = new Set([
  "ALTIMATE_NON_INTERACTIVE",
  "ALTIMATE_CODE_HEADLESS",
  "ALTIMATE_CODE_SERVE",
  "ALTIMATE_PINNED_WORKSPACE_ID",
  "ALTIMATE_PINNED_WORKSPACE_NAME",
  "ALTIMATE_PINNED_WORKSPACE_ROOT",
])
export function stripHostMarkers(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform) {
  // Windows environment names are case-insensitive: a child reads `altimate_code_serve`
  // as the marker, so every spelling goes there. POSIX keeps exact matching.
  for (const key of Object.keys(env)) {
    if (HOST_MARKERS.has(platform === "win32" ? key.toUpperCase() : key)) delete env[key]
  }
  return env
}
// altimate_change end

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      // altimate_change start — upstream_fix: resolve workdir relative to the active instance
      const cwd = path.resolve(Instance.directory, params.workdir || ".")
      // altimate_change end
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()
      // altimate_change start — upstream_fix: retain raw command rules alongside absolute path rules
      const permissionAliases = new Map<string, Set<string>>()

      for (const { node, cwd: commandCwd } of shellCommands(tree.rootNode, cwd)) {
        // altimate_change end
        if (!node) continue

        // Get full command text including redirects if present
        let commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text

        // altimate_change start — upstream_fix: normalize static path operands, including directory listings
        const words = shellWords(node)
        const command = words.map((word) => word.text)
        const name = words[0] && literalWord(words[0])
        const source = node.parent?.type === "redirected_statement" ? node.parent : node
        const replacements: { start: number; end: number; text: string }[] = []

        // not an exhaustive list, but covers most common cases
        if (name && ["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat", "ls"].includes(name)) {
          const operands = words.slice(1).filter((word) => !word.text.startsWith("-"))
          const targets = operands.flatMap((word) => {
            const arg = literalWord(word)
            if (arg === undefined || (name === "chmod" && arg.startsWith("+"))) return []
            const target = path.resolve(commandCwd, arg)
            if (!["chmod", "chown"].includes(name) || word !== operands[0]) {
              replacements.push({ start: word.startIndex, end: word.endIndex, text: target })
            }
            return [target]
          })
          if (name === "ls" && operands.length === 0) {
            targets.push(commandCwd)
            replacements.push({ start: node.endIndex, end: node.endIndex, text: ` ${commandCwd}` })
          }
          for (const arg of targets) {
            const resolved = await fs.realpath(arg).catch(() => "")
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              const normalized =
                process.platform === "win32" ? Filesystem.windowsPath(resolved).replace(/\//g, "\\") : resolved
              if (!Instance.containsPath(normalized)) {
                const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
                directories.add(dir)
              }
            }
          }
        }
        const original = commandText
        for (const replacement of replacements.reverse()) {
          const start = replacement.start - source.startIndex
          const end = replacement.end - source.startIndex
          commandText = commandText.slice(0, start) + replacement.text + commandText.slice(end)
        }
        const aliases = permissionAliases.get(original) ?? new Set<string>()
        aliases.add(commandText)
        permissionAliases.set(original, aliases)
        // altimate_change end

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          // altimate_change start — upstream_fix: rules match the authored command text
          patterns.add(original)
          // altimate_change end
          always.add(BashArity.prefix(command).join(" ") + " *")
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => {
          // Preserve POSIX-looking paths with /s, even on Windows
          if (dir.startsWith("/")) return `${dir.replace(/[\\/]+$/, "")}/*`
          return path.join(dir, "*")
        })
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          // altimate_change start — upstream_fix: evaluate raw and normalized commands as equivalent spellings
          metadata: {
            permissionAliases: Object.fromEntries(
              Array.from(permissionAliases, ([key, values]) => [key, [...values].map((value) => [value])]),
            ),
          },
          // altimate_change end
        })
      }

      const shellEnv = await Plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )

      // altimate_change start — prepend bundled tools dir (ALTIMATE_BIN_DIR) and user tools dirs to PATH
      const mergedEnv: Record<string, string | undefined> = { ...process.env, ...shellEnv.env }
      // Strip the markers that describe this host, not the child. See `stripHostMarkers`
      // for what each one is and why (PR #937 review, Issue #3, for the first of them).
      stripHostMarkers(mergedEnv)
      // altimate_change start — strip the run-mode markers for the same reason.
      stripRunModeMarkers(mergedEnv)
      // altimate_change end
      const sep = process.platform === "win32" ? ";" : ":"
      const basePath = mergedEnv.PATH ?? mergedEnv.Path ?? ""
      const pathEntries = new Set(basePath.split(sep).filter(Boolean))

      // Collect directories to prepend (highest priority first)
      const prependDirs: string[] = []

      // 1. Bundled tools (altimate-dbt, etc.) — highest priority
      const binDir = process.env.ALTIMATE_BIN_DIR
      if (binDir && !pathEntries.has(binDir)) {
        prependDirs.push(binDir)
      }

      // 2. Project-level user tools (.altimate-code/tools/ primary, .opencode/tools/ fallback) — user extensions
      // Anchored to Instance.directory (not cwd) so external_directory workdirs
      // can't shadow project tools. Also check worktree root for monorepos.
      // altimate_change start — prefer .altimate-code/tools, keep .opencode/tools for back-compat
      for (const variant of [".altimate-code", ".opencode"]) {
        const projectToolsDir = path.join(Instance.directory, variant, "tools")
        if (!pathEntries.has(projectToolsDir)) {
          prependDirs.push(projectToolsDir)
        }
      }
      if (Instance.worktree !== "/" && Instance.worktree !== Instance.directory) {
        for (const variant of [".altimate-code", ".opencode"]) {
          const worktreeToolsDir = path.join(Instance.worktree, variant, "tools")
          if (!pathEntries.has(worktreeToolsDir)) {
            prependDirs.push(worktreeToolsDir)
          }
        }
      }
      // altimate_change end

      // 3. Global user tools (~/.config/altimate-code/tools/) — shared across projects
      const globalToolsDir = path.join(Global.Path.config, "tools")
      if (!pathEntries.has(globalToolsDir)) {
        prependDirs.push(globalToolsDir)
      }

      if (prependDirs.length > 0) {
        const prefix = prependDirs.join(sep)
        mergedEnv.PATH = basePath ? `${prefix}${sep}${basePath}` : prefix
      }
      // altimate_change end

      const proc = spawn(params.command, {
        shell,
        cwd,
        env: mergedEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
      })

      let output = ""

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})
