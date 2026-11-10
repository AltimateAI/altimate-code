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
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PermissionEvaluate } from "@/permission/evaluate"
import { userInfo } from "os"

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
// The literal directory `cd` moves to: home without an operand, undefined when not literal.
function cdTarget(words: Node[]): string | undefined {
  const args = words.slice(1).map(literalWord)
  let i = 0
  while (i < args.length && args[i] !== undefined && CD_FLAGS.includes(args[i]!)) i++
  if (args[i] === "--") i++
  return i < args.length ? args[i] : homedir()
}

function afterCd(cwds: string[], words: Node[]): string[] {
  const target = cdTarget(words)
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

// altimate_change start — apply a configured `external_directory: deny` to every path a command names
// The operand check above only covers a fixed list of file commands. When the effective
// external_directory rule for "*" is deny, every literal path the command text names is checked
// as well: arguments (including `--opt=value`, `key=value` and `-oVALUE` values), a command run by
// path, redirection targets, assignment values, `for`/`[[ ]]`/`case` words, the directories commands
// run in, and literal `sh -c`/`eval` strings. Each is resolved against the directory its command
// runs in and through symlinks. Under the default ("ask") and "allow" nothing changes.
// This is a guard rail over literal command text, not an OS sandbox.

// Character devices that are not files in any directory.
const DEVICE_PATHS = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
])
// Running a system binary by its full path (`/usr/bin/env python`) is not a project escape.
const SYSTEM_BIN_DIRS = new Set([
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/homebrew/bin",
])
// Programs that run the program named in their arguments.
const WRAPPERS = new Set(["env", "nohup", "command", "time", "xargs", "exec", "nice", "stdbuf", "timeout", "sudo"])
// Shells whose `-c` string is parsed with the same parser.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
// Programs whose first operand (or `-e` value) is a program or pattern, not a path.
const PATTERN_PROGRAMS = new Set(["awk", "gawk", "mawk", "nawk", "sed", "gsed", "grep", "egrep", "fgrep", "rg"])
const PATTERN_OPTIONS = ["-e", "--expression", "--regexp", "-f", "--file"]
const PATTERN_VALUE_OPTIONS = ["-F", "-v", "-A", "-B", "-C", "-m", "--max-count", "-l", "-s"]
const MAX_SHELL_DEPTH = 3
// Bounds the realpath/stat work one command can cause.
const MAX_GUARD_CANDIDATES = 2000

export function externalDirectoryDenied(rules: PermissionV1.Ruleset | undefined) {
  const rule = rules?.findLast((item) => Wildcard.match("external_directory", item.permission) && item.pattern === "*")
  return rule?.action === "deny"
}

function isDevice(target: string) {
  return DEVICE_PATHS.has(target) || /^\/dev\/fd\/\d+$/.test(target)
}

// The top-level entry a path starts with (`/etc` for `/etc/hosts`, `C:\Users` for `C:\Users\x`).
export function firstSegmentPath(real: string, p: path.PlatformPath = path) {
  const root = p.parse(real).root
  const first = real.slice(root.length).split(p.sep).filter(Boolean)[0]
  return first ? p.join(root, first) : undefined
}

const GUARD_WORD_TYPES = ["command_name", "word", "string", "raw_string", "concatenation", "number", "ansi_c_string"]

function guardWords(node: Node) {
  return node.namedChildren.filter((child): child is Node => child !== null && GUARD_WORD_TYPES.includes(child.type))
}

type Literal = { text: string } | { refuse: string } | undefined

// A word's literal value, also covering `$'…'` without escapes and `~user`.
function guardLiteral(node: Node | null): Literal {
  if (!node) return
  if (node.type === "ansi_c_string") return node.text.includes("\\") ? undefined : { text: node.text.slice(2, -1) }
  if (node.type === "concatenation" || node.type === "command_name") {
    const parts = node.namedChildren.map(guardLiteral)
    if (parts.some((part) => part && "refuse" in part)) return { refuse: node.text }
    if (parts.every((part) => part !== undefined)) return { text: parts.map((part) => (part as { text: string }).text).join("") }
    return
  }
  const user = node.type === "word" ? /^~([A-Za-z_][\w.-]*)(?=\/|$)/.exec(node.text) : null
  if (user) {
    // `~name` is another user's home unless it names the current user.
    if (user[1] !== currentUser()) return { refuse: node.text }
    const rest = node.text.slice(user[0].length)
    if (/[~$*?{\[]/.test(rest.replace(/\\./gs, ""))) return
    return { text: homedir() + rest.replace(/\\(.)/gs, "$1") }
  }
  const text = literalWord(node)
  return text === undefined ? undefined : { text }
}

function currentUser() {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

function expandHome(text: string) {
  return text === "~" || text.startsWith("~/") ? homedir() + text.slice(1) : text
}

// The path-like values one argument carries: the word itself, the value of `--x=v` / `key=v`,
// or the attached value of a short option (`-o/path`).
function argumentValues(arg: string) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=")
    return eq > 0 ? [arg.slice(eq + 1)] : []
  }
  if (arg.startsWith("-")) {
    const attached = arg.slice(2)
    return /^-[A-Za-z]/.test(arg) && /^(~|\.\.|.*\/)/.test(attached) ? [attached] : []
  }
  const assignment = /^[A-Za-z_][\w.-]*=(.*)$/s.exec(arg)
  return assignment ? [arg, assignment[1]] : [arg]
}

// Literal pieces of an assignment value; `PATH`-style values are split on `:`.
function assignmentValues(value: Node | null): string[] {
  if (!value) return []
  const literal = guardLiteral(value)
  let text = literal && "text" in literal ? literal.text : value.text
  if (!literal && value.type === "string") text = text.slice(1, -1)
  return text
    .split(":")
    .filter((piece) => piece && !/[$`*?[]/.test(piece.replace(/\\./gs, "")))
    .map((piece) => expandHome(piece.replace(/\\(.)/gs, "$1")))
}

interface GuardScan {
  candidates: Set<string>
  // Operands of `mkdir`, which creates missing parents with `-p`.
  creates: Set<string>
  refusals: Set<string>
  stack: string[][]
  depth: number
  parse: (text: string) => Node | undefined
}
interface Cwds {
  // directories after the node when it succeeded, and in any outcome
  ok: string[]
  any: string[]
}

const union = (...lists: string[][]) => [...new Set(lists.flat())].slice(0, MAX_TRACKED_DIRECTORIES)
const same = (cwds: string[]): Cwds => ({ ok: cwds, any: cwds })

function addCandidate(scan: GuardScan, cwds: string[], value: string, created = false) {
  const target = expandHome(value)
  for (const cwd of cwds) {
    scan.candidates.add(path.resolve(cwd, target))
    if (created) scan.creates.add(path.resolve(cwd, target))
  }
}

// Walk the script in execution order, tracking the directories each command can run in.
// `cd x && y` runs y only in x; `cd x; y` and `cd x || y` keep the earlier directory possible.
function scanNode(node: Node | null, cwds: string[], scan: GuardScan): Cwds {
  if (!node) return same(cwds)
  switch (node.type) {
    case "command":
      return scanCommand(node, cwds, scan)
    case "variable_assignment":
      for (const value of assignmentValues(node.childForFieldName("value"))) addCandidate(scan, cwds, value)
      scanChildren(node, cwds, scan)
      return same(cwds)
    case "file_redirect":
      // `destination` holds several words when arguments follow the target (`cat > out /x`).
      for (const child of node.namedChildren) {
        if (!child || child.type === "file_descriptor") continue
        const literal = guardLiteral(child)
        if (literal && "refuse" in literal) scan.refusals.add(literal.refuse)
        else if (literal) addCandidate(scan, cwds, literal.text)
      }
      scanChildren(node, cwds, scan)
      return same(cwds)
    case "redirected_statement": {
      const body = node.childForFieldName("body")
      const redirects = node.namedChildren.filter((child): child is Node => !!child && child.id !== body?.id)
      return scanRedirected(body, redirects, cwds, scan)
    }
    case "list": {
      // The parser builds `list` only for `&&` and `||`; `;`, `&` and newline-separated
      // commands are siblings scanned by scanSequence, which keeps every directory possible.
      const [left, right] = node.namedChildren
      const or = node.children.some((child) => child?.type === "||")
      const l = scanNode(left, cwds, scan)
      const r = scanNode(right, or ? l.any : l.ok, scan)
      return { ok: or ? union(l.ok, r.ok) : r.ok, any: union(l.any, r.any) }
    }
    case "pipeline":
    case "subshell":
    case "command_substitution":
    case "process_substitution":
    case "function_definition": {
      // Pipeline stages, subshells and function bodies keep their directory changes local.
      if (node.type === "pipeline") scanChildren(node, cwds, scan)
      else scanSequence(node, cwds, scan)
      return same(cwds)
    }
    case "for_statement":
      for (const value of node.childrenForFieldName("value")) addWord(scan, cwds, value)
      return same(scanSequence(node, cwds, scan))
    case "case_statement":
      addWord(scan, cwds, node.childForFieldName("value"))
      return same(scanSequence(node, cwds, scan))
    case "test_command": {
      const stack = [...node.namedChildren]
      while (stack.length) {
        const child = stack.pop()
        if (!child) continue
        if (GUARD_WORD_TYPES.includes(child.type)) addWord(scan, cwds, child)
        else stack.push(...child.namedChildren)
      }
      scanChildren(node, cwds, scan)
      return same(cwds)
    }
    default:
      return same(scanSequence(node, cwds, scan))
  }
}

// Children in order, each starting where the previous may have left off.
function scanSequence(node: Node, cwds: string[], scan: GuardScan) {
  let next = cwds
  for (const child of node.namedChildren) next = scanNode(child, next, scan).any
  return next
}

// Children that cannot change the directory (substitutions inside words, pipeline stages).
function scanChildren(node: Node, cwds: string[], scan: GuardScan) {
  for (const child of node.namedChildren) scanNode(child, cwds, scan)
}

// The parser attaches `a && b > f` and `a | b > f` to the whole list; the shell applies the
// redirection to the last command only, in that command's directory.
function scanRedirected(body: Node | null, redirects: Node[], cwds: string[], scan: GuardScan): Cwds {
  if (body?.type === "list") {
    const [left, right] = body.namedChildren
    const or = body.children.some((child) => child?.type === "||")
    const l = scanNode(left, cwds, scan)
    const r = scanRedirected(right, redirects, or ? l.any : l.ok, scan)
    return { ok: or ? union(l.ok, r.ok) : r.ok, any: union(l.any, r.any) }
  }
  if (body?.type === "pipeline") {
    const stages = body.namedChildren.filter((child): child is Node => !!child)
    for (const stage of stages.slice(0, -1)) scanNode(stage, cwds, scan)
    scanRedirected(stages.at(-1) ?? null, redirects, cwds, scan)
    return same(cwds)
  }
  for (const redirect of redirects) scanNode(redirect, cwds, scan)
  return scanNode(body, cwds, scan)
}

function addWord(scan: GuardScan, cwds: string[], word: Node | null) {
  const literal = guardLiteral(word)
  if (!literal) return
  if ("refuse" in literal) return void scan.refusals.add(literal.refuse)
  for (const value of argumentValues(literal.text)) addCandidate(scan, cwds, value)
}

function scanNested(script: string, cwds: string[], scan: GuardScan): Cwds {
  if (scan.depth >= MAX_SHELL_DEPTH) {
    scan.refusals.add(`shell commands nested more than ${MAX_SHELL_DEPTH} levels deep`)
    return same(cwds)
  }
  const root = scan.parse(script)
  if (!root) return same(cwds)
  scan.depth++
  try {
    return scanNode(root, cwds, scan)
  } finally {
    scan.depth--
  }
}

function scanCommand(node: Node, cwds: string[], scan: GuardScan): Cwds {
  // Every directory a command may run in; substitutions and assignments inside it.
  for (const cwd of cwds) scan.candidates.add(cwd)
  scanChildren(node, cwds, scan)
  const words = guardWords(node)
  const literals = words.map(guardLiteral)
  const text = (i: number) => {
    const literal = literals[i]
    return literal && "text" in literal ? literal.text : undefined
  }
  // Wrappers (`env FOO=1 nohup python …`) are followed, through their options, to the program they run.
  const programs: number[] = []
  for (let i = 0; i < words.length && text(i) !== undefined; ) {
    programs.push(i)
    if (!WRAPPERS.has(path.basename(text(i)!))) break
    i++
    while (i < words.length && /^(-|[A-Za-z_]\w*=|\d+[smhd]?$)/.test(text(i) ?? "")) i++
  }
  const program = programs.at(-1) ?? 0
  for (const index of programs) {
    const name = text(index)!
    if (!name.includes("/")) continue
    for (const cwd of cwds) {
      const target = path.resolve(cwd, expandHome(name))
      if (!SYSTEM_BIN_DIRS.has(path.dirname(target))) scan.candidates.add(target)
    }
  }
  const name = text(program)
  const base = name === undefined ? undefined : path.basename(name)
  const start = program + 1

  if (base === "cd" || base === "pushd") {
    const target = base === "pushd" && start >= words.length ? undefined : cdTarget(words.slice(program))
    if (target === undefined || target === "-" || /^[+-]\d+$/.test(target)) return same(cwds)
    const fresh = [...new Set(cwds.map((cwd) => path.resolve(cwd, target)))]
    if (base === "pushd") scan.stack.push(cwds)
    for (const dir of fresh) scan.candidates.add(dir)
    return { ok: fresh, any: union(fresh, cwds) }
  }
  if (base === "popd") {
    const previous = scan.stack.pop()
    return previous ? { ok: previous, any: union(previous, cwds) } : same(cwds)
  }
  const literalArgs = words.slice(start).map((_, i) => text(start + i))
  if (base && SHELLS.has(base)) {
    // `bash -c 'script'` / `bash -lc 'script'`: the first operand after the options is the script.
    let i = 0
    let command = false
    while (i < literalArgs.length && literalArgs[i]?.startsWith("-")) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(literalArgs[i]!)) command = true
      i++
    }
    const script = literalArgs[i]
    if (command && script !== undefined) scanNested(script, cwds, scan)
  }
  if (base === "eval" && literalArgs.every((arg) => arg !== undefined)) {
    // `eval` runs in this shell, so its directory changes carry on.
    return scanNested(literalArgs.join(" "), cwds, scan)
  }

  // The program or pattern operand of awk/sed/grep is not a path.
  const skip = new Set<number>(programs)
  if (base && PATTERN_PROGRAMS.has(base)) {
    let explicit = false
    for (let i = start; i < words.length; i++) {
      const arg = text(i)
      if (arg === undefined) break
      if (arg === "--") {
        if (!explicit) skip.add(i + 1)
        break
      }
      if (PATTERN_OPTIONS.includes(arg)) {
        explicit = true
        // `-e PROGRAM` holds a program; `-f FILE` names a file and stays checked.
        if (arg !== "-f" && arg !== "--file") skip.add(i + 1)
        i++
        continue
      }
      if (PATTERN_VALUE_OPTIONS.includes(arg)) {
        i++
        continue
      }
      if (arg.startsWith("-")) continue
      if (!explicit) skip.add(i)
      break
    }
  }
  const wrapped = programs.length > 1 || (base !== undefined && WRAPPERS.has(base))
  for (let i = 1; i < words.length; i++) {
    if (skip.has(i)) continue
    const literal = literals[i]
    if (!literal) continue
    if ("refuse" in literal) {
      scan.refusals.add(literal.refuse)
      continue
    }
    for (const value of argumentValues(literal.text)) {
      // A wrapper's system-binary argument (`nohup /usr/bin/true`) is not an escape.
      if (wrapped && path.isAbsolute(value) && SYSTEM_BIN_DIRS.has(path.dirname(value))) continue
      addCandidate(scan, cwds, value, base === "mkdir")
    }
  }
  return same(cwds)
}

// Literal path candidates a command names, resolved against the directory each part runs in.
export function commandPathCandidates(root: Node, cwd: string, parse: (text: string) => Node | undefined) {
  const scan: GuardScan = { candidates: new Set(), creates: new Set(), refusals: new Set(), stack: [], depth: 0, parse }
  scanNode(root, [cwd], scan)
  return {
    candidates: [...scan.candidates].filter((target) => !isDevice(target)),
    creates: scan.creates,
    refusals: [...scan.refusals],
  }
}

// Out-of-project locations a command names, with whether each exists yet.
async function externalCommandPaths(candidates: string[], creates: Set<string>, abort: AbortSignal) {
  if (candidates.length > MAX_GUARD_CANDIDATES)
    throw new Error(
      `external_directory is denied: this command names more than ${MAX_GUARD_CANDIDATES} paths to check. Split it into smaller commands.`,
    )
  const found: { path: string; dir: string; exists: boolean }[] = []
  for (const target of candidates) {
    abort.throwIfAborted()
    const real = await realpathThroughParents(target)
    if (!real || isDevice(real)) continue
    // Text below a top-level entry that does not exist (`/api/v1`, a regex such as `/x/y/`) names
    // no real location: nothing but `mkdir -p` can create it. A missing top-level entry itself
    // (`touch /new`) can be created, so it stays a candidate, as does every `mkdir` operand.
    const first = firstSegmentPath(real)
    if (first && first !== real && !creates.has(target) && !(await fs.stat(first).catch(() => undefined))) continue
    if (Instance.containsPath(real)) continue
    const stat = await fs.stat(real).catch(() => undefined)
    found.push({ path: real, dir: stat?.isDirectory() ? real : path.dirname(real), exists: !!stat })
  }
  return found
}

function directoryGlob(dir: string) {
  // Preserve POSIX-looking paths with /s, even on Windows
  if (dir.startsWith("/")) return `${dir.replace(/[\\/]+$/, "")}/*`
  return path.join(dir, "*")
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

      // altimate_change start — apply a configured `external_directory: deny` to every path a command names
      const guarded = externalDirectoryDenied(ctx.permissions)
      const externalPaths = new Set<string>()
      if (guarded) {
        // The guard judges every path itself, each in the directory its command runs in, so the
        // operand check's directories (which keep pre-`cd` directories as aliases) are replaced.
        directories.clear()
        const p = await parser()
        const { candidates, creates, refusals } = commandPathCandidates(
          tree.rootNode,
          cwd,
          (text) => p.parse(text)?.rootNode ?? undefined,
        )
        const denied = new Set<string>(refusals)
        for (const item of await externalCommandPaths(candidates, creates, ctx.abort)) {
          externalPaths.add(item.path)
          // Paths here are symlink-resolved, so rules are matched with their resolved spelling too.
          // A directory that does not exist yet is also matched as itself (`ls <allowed-dir>`).
          const dirs = item.exists ? [item.dir] : [item.dir, item.path]
          const allowed = dirs.find(
            (dir) =>
              PermissionEvaluate.evaluateResolved("external_directory", directoryGlob(dir), ctx.permissions!).action !==
              "deny",
          )
          if (allowed === undefined) denied.add(item.path)
          else directories.add(allowed)
        }
        if (denied.size > 0) {
          throw new Error(
            `external_directory is denied: this command touches ${denied.size === 1 ? "a path" : "paths"} outside the project (${Instance.worktree === "/" ? Instance.directory : Instance.worktree}): ${[...denied].join(", ")}. ` +
              "Use paths inside the project instead.",
          )
        }
      }
      // altimate_change end

      if (directories.size > 0) {
        // altimate_change start — one directory-to-glob rule for the guard and the request
        const globs = Array.from(directories).map(directoryGlob)
        // altimate_change end
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          // altimate_change start — under `external_directory: deny` the globs are symlink-resolved paths
          metadata: guarded ? { resolvedPatterns: globs } : {},
          // altimate_change end
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
      // altimate_change start — keep stderr's tail separate from later successful stdout
      let stderrTail = ""
      let hasStdout = false
      // altimate_change end

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

      // altimate_change start — distinguish stderr failures from tracebacks printed as stdout data
      proc.stdout?.on("data", (chunk: Buffer) => {
        hasStdout ||= chunk.length > 0
        append(chunk)
      })
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-MAX_METADATA_LENGTH)
        append(chunk)
      })
      // altimate_change end

      let timedOut = false
      let aborted = false
      let exited = false

      // altimate_change start — a shell may exit while descendants still hold its pipes open
      const kill = async () => {
        try {
          await Shell.killTree(proc, { exited: () => exited })
        } finally {
          proc.stdout?.destroy()
          proc.stderr?.destroy()
        }
      }
      // altimate_change end

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
        // altimate_change start — background descendants may keep pipes open after shell exit
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          clearTimeout(drainTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        const finish = () => {
          cleanup()
          proc.removeListener("close", finish)
          proc.stdout?.destroy()
          proc.stderr?.destroy()
          resolve()
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          // Exit ends the command timeout. Give buffered output a bounded drain;
          // a background child retaining a pipe is not a failed command.
          drainTimer = setTimeout(finish, 250)
        })
        proc.once("close", finish)
        // altimate_change end

        proc.once("error", (error) => {
          exited = true
          cleanup()
          // altimate_change start — stop reading when spawning fails too
          proc.removeListener("close", finish)
          proc.stdout?.destroy()
          proc.stderr?.destroy()
          // altimate_change end
          reject(error)
        })
        // altimate_change start — install listeners before killing an already-aborted command
        if (ctx.abort.aborted) abortHandler()
        // altimate_change end
      })

      const resultMetadata: string[] = []
      // altimate_change start — shell outcomes are telemetry, not SDK errors
      const traceback =
        /(?:^|\r?\n)Traceback \(most recent call last\):\r?\n(?:[ \t].*\r?\n)+([A-Za-z_][\w.]*(?::[^\r\n]*)?)\s*$/
      // A zero-exit traceback is only a failure when it ends stderr and stdout
      // is empty. Tracebacks printed on stdout are ordinary command output.
      const pythonError = (proc.exitCode !== 0 || !hasStdout) && traceback.test(stderrTail)
      const failureKind = timedOut
        ? "timeout"
        : aborted
          ? "abort"
          : proc.signalCode
            ? "signal"
            : pythonError
              ? "stderr_traceback"
              : undefined
      const failed = failureKind !== undefined || proc.exitCode !== 0
      // altimate_change end

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
          // altimate_change start — retain the legacy exit field and record telemetry without metadata.error
          exit_code: proc.exitCode,
          ...(failed && { success: false }),
          // Ordinary non-zero exits (for example, grep no-match) retain their
          // exit status without declaring an execution failure to the wrapper.
          ...(failureKind && { failure_kind: failureKind }),
          // altimate_change end
          // altimate_change start — out-of-project paths permitted under `external_directory: deny`
          ...(externalPaths.size > 0 && { external_paths: [...externalPaths] }),
          // altimate_change end
        },
        output,
      }
    },
  }
})
