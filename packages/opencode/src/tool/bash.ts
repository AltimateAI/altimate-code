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
import { homedir } from "os"

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

function shellWords(node: Node, includeNumbers = false) {
  const types = ["command_name", "word", "string", "raw_string", "concatenation"]
  // tree-sitter parses a bare numeric argument (`mkdir -m 700`) as `number`.
  if (includeNumbers) types.push("number")
  return node.namedChildren.filter((child): child is Node => child !== null && types.includes(child.type))
}

function literalWord(node: Node | null): string | undefined {
  if (!node) return
  if (node.type === "raw_string") return node.text.slice(1, -1)
  if (node.type === "word" || node.type === "number") {
    let text = node.text
    if (text === "~" || text.startsWith("~/")) text = homedir() + text.slice(1)
    // Backslash-escaped metacharacters are literal; only unescaped ones mean expansion.
    if (/[~$*?{\[]/.test(text.replace(/\\./gs, ""))) return
    return text.replace(/\\(.)/gs, "$1")
  }
  if (node.type === "string" && node.namedChildren.every((child) => child?.type === "string_content")) {
    return node.text
      .slice(1, -1)
      .replace(/\\\n/g, "")
      .replace(/\\([$`"\\])/g, "$1")
  }
  if (node.type === "command_name" || node.type === "concatenation") {
    const parts = node.namedChildren.map(literalWord)
    if (parts.every((part) => part !== undefined)) return parts.join("")
  }
}

// Cap on tracked directories so pathological scripts cannot blow up alias generation.
const MAX_TRACKED_DIRECTORIES = 32
// Operand-spelling combinations are enumerated in full up to this many operands.
const MAX_MIXED_OPERANDS = 4
const MAX_ALIAS_VARIANTS = 4096

// Options that take a separate non-path value; the value must not be read as an operand.
const VALUE_OPTIONS: Record<string, string[]> = {
  mkdir: ["-m", "--mode"],
  cp: ["-S", "--suffix"],
  mv: ["-S", "--suffix"],
  touch: ["-d", "--date", "-t"],
  ls: ["-I", "--ignore", "-w", "--width", "-T", "--tabsize"],
}
// Long options whose `=value` is a path operand.
const PATH_OPTIONS = ["--reference", "--target-directory"]
const CD_FLAGS = ["-L", "-P", "-e", "-@"]

// cwds that a following command may run in after `cd`. `cd` can fail (`cd missing; cat x`)
// or sit behind `||`, a conditional or a background marker, so the previous directories
// stay possible. An unresolvable target (`cd $VAR`, `cd -`) adds nothing: the extra
// directories only ever add aliases, which can tighten a decision but never relax it.
function afterCd(cwds: string[], words: Node[]): string[] {
  const args = words.slice(1).map(literalWord)
  let i = 0
  while (i < args.length && args[i] !== undefined && CD_FLAGS.includes(args[i]!)) i++
  if (args[i] === "--") i++
  const target = i < args.length ? args[i] : homedir()
  if (target === undefined || target === "-") return cwds
  // Newly reachable directories come first so the cap drops the oldest speculative
  // branches, never the directory a straight-line script actually enters.
  const fresh = cwds.map((cwd) => path.resolve(cwd, target))
  return [...new Set([...fresh, ...cwds])].slice(0, MAX_TRACKED_DIRECTORIES)
}

// Walk commands in source order, tracking every directory a command could run in.
// Subshells and substitutions keep their directory changes local.
function* shellCommands(node: Node | null, cwds: string[]): Generator<{ node: Node; cwds: string[] }, string[]> {
  if (!node) return cwds
  if (node.type === "command") {
    yield { node, cwds }
    for (const child of node.namedChildren) yield* shellCommands(child, cwds)
    const words = shellWords(node, true)
    return words[0] && literalWord(words[0]) === "cd" ? afterCd(cwds, words) : cwds
  }
  const local = ["subshell", "command_substitution", "pipeline"].includes(node.type)
  let next = cwds
  for (const child of node.namedChildren) next = yield* shellCommands(child, next)
  return local ? cwds : next
}

interface PathOperand {
  word: Node
  arg: string | undefined
  prefix: string
}

// Collect path operands, honoring `--`, quoted flags, option values and `--reference=`.
function pathOperands(name: string, words: Node[]): PathOperand[] {
  const operands: PathOperand[] = []
  const valueOptions = VALUE_OPTIONS[name] ?? []
  let terminated = false
  let skipNext = false
  let referenced = false
  for (const word of words.slice(1)) {
    const arg = literalWord(word)
    if (skipNext) {
      skipNext = false
      continue
    }
    // chmod symbolic modes such as `-w` or `-rwx` are the mode operand, not options.
    const symbolicMode = name === "chmod" && arg !== undefined && /^-[ugoa]*[rwxXst]+[ugoa,rwxXst=+-]*$/.test(arg)
    if (!terminated && !symbolicMode && arg?.startsWith("-")) {
      if (arg === "--") terminated = true
      else {
        const option = PATH_OPTIONS.find((candidate) => arg.startsWith(candidate + "="))
        if (option) {
          if (option === "--reference") referenced = true
          operands.push({ word, arg: arg.slice(option.length + 1), prefix: option + "=" })
        } else if (valueOptions.includes(arg)) skipNext = true
      }
      continue
    }
    operands.push({ word, arg, prefix: "" })
  }
  // chmod/chown take a mode/owner first unless --reference supplies it.
  if (["chmod", "chown"].includes(name) && !referenced) {
    const first = operands.findIndex((operand) => !operand.prefix)
    if (first >= 0) operands.splice(first, 1)
  }
  return operands
}

// Resolve symlinks in the deepest existing parent so a not-yet-created destination
// behind a symlinked directory still maps to where it will really be written.
async function realpathThroughParents(target: string): Promise<string> {
  const missing: string[] = []
  let current = target
  while (true) {
    const resolved = await fs.realpath(current).catch(() => "")
    if (resolved) return path.join(resolved, ...missing.reverse())
    const parent = path.dirname(current)
    if (parent === current) return ""
    missing.push(path.basename(current))
    current = parent
  }
}

function quoteLike(word: Node, text: string) {
  if (word.type === "string") return `"${text}"`
  if (word.type === "raw_string") return `'${text}'`
  return text
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
export function stripHostMarkers(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
) {
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
    // altimate_change start — upstream_fix: keep tool descriptions stable across working directories.
    description: DESCRIPTION.replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    // altimate_change end
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        // altimate_change start — upstream_fix: resolve the default directory only during execution.
        .describe(
          "The working directory to run the command in. Defaults to the session's working directory. Use this instead of 'cd' commands.",
        )
        // altimate_change end
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

      for (const { node, cwds } of shellCommands(tree.rootNode, [cwd])) {
        // altimate_change end
        // Get full command text including redirects if present
        const original = node.parent?.type === "redirected_statement" ? node.parent.text : node.text

        // altimate_change start — upstream_fix: normalize static path operands, including directory listings
        const words = shellWords(node)
        const operandWords = shellWords(node, true)
        const command = words.map((word) => word.text)
        const name = words[0] && literalWord(words[0])
        const source = node.parent?.type === "redirected_statement" ? node.parent : node
        const variants = new Set<string>([original])

        // not an exhaustive list, but covers most common cases
        if (name && ["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat", "ls"].includes(name)) {
          const operands = name === "cd" ? pathOperands("cat", operandWords) : pathOperands(name, operandWords)
          for (const commandCwd of cwds) {
            const targets = operands.flatMap((operand) => {
              if (operand.arg === undefined || (name === "chmod" && operand.arg.startsWith("+"))) return []
              return [{ operand, target: path.resolve(commandCwd, operand.arg) }]
            })
            const listing = name === "ls" && operands.length === 0
            if (listing) targets.push({ operand: undefined as never, target: commandCwd })
            const reals = await Promise.all(targets.map((item) => realpathThroughParents(item.target)))
            reals.forEach((resolved, index) => {
              log.info("resolved path", { arg: targets[index].target, resolved })
            })
            for (const resolved of reals) {
              if (!resolved) continue
              const normalized =
                process.platform === "win32" ? Filesystem.windowsPath(resolved).replace(/\//g, "\\") : resolved
              if (!Instance.containsPath(normalized)) {
                const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
                directories.add(dir)
              }
            }
            // Each operand can be written as authored, absolute (keeping its quoting), bare
            // absolute or symlink-resolved, and the rule may mix them (`cp a /abs/b`).
            const written = targets.flatMap((item, index) => (item.operand ? [{ item, real: reals[index] }] : []))
            const choices = written.map(({ item, real }) =>
              item.operand
                ? [
                    item.operand.word.text,
                    item.operand.prefix + quoteLike(item.operand.word, item.target),
                    item.operand.prefix + item.target,
                    item.operand.prefix + (real || item.target),
                  ].filter((value, i, all) => all.indexOf(value) === i)
                : [],
            )
            const combos: number[][] = []
            if (written.length <= MAX_MIXED_OPERANDS) {
              const expand = (prefix: number[]) => {
                if (prefix.length === choices.length) return void combos.push(prefix)
                choices[prefix.length].forEach((_, i) => expand([...prefix, i]))
              }
              expand([])
            } else {
              // Too many operands to enumerate: uniform spellings plus each operand spelled
              // differently from the rest.
              for (let i = 0; i < 4; i++) combos.push(choices.map((options) => Math.min(i, options.length - 1)))
              choices.forEach((options, index) => {
                options.forEach((_, i) => combos.push(choices.map((_, j) => (j === index ? i : 0))))
              })
            }
            // `cat -- x` and `cat x` read the same file, so also alias the form without `--`.
            const terminator =
              name === "cd" ? undefined : operandWords.slice(1).find((word) => literalWord(word) === "--")
            for (const combo of combos) {
              for (const dropTerminator of terminator ? [false, true] : [false]) {
                if (variants.size >= MAX_ALIAS_VARIANTS) break
                const replacements = written
                  .map(({ item }, index) => ({
                    start: item.operand?.word.startIndex ?? 0,
                    end: item.operand?.word.endIndex ?? 0,
                    text: choices[index][combo[index]],
                    skip: !item.operand,
                  }))
                  .filter((replacement) => !replacement.skip)
                if (listing)
                  replacements.push({ start: node.endIndex, end: node.endIndex, text: ` ${commandCwd}`, skip: false })
                if (terminator && dropTerminator)
                  replacements.push({
                    start: terminator.startIndex - 1,
                    end: terminator.endIndex,
                    text: "",
                    skip: false,
                  })
                let text = original
                for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
                  const start = replacement.start - source.startIndex
                  const end = replacement.end - source.startIndex
                  text = text.slice(0, start) + replacement.text + text.slice(end)
                }
                variants.add(text)
              }
            }
          }
        }
        // Insignificant shell whitespace must not let an exact rule miss the command.
        for (const variant of [...variants]) if (!/["'\\]/.test(variant)) variants.add(variant.replace(/[ \t]+/g, " "))
        const aliases = permissionAliases.get(original) ?? new Set<string>()
        for (const variant of variants) aliases.add(variant)
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
