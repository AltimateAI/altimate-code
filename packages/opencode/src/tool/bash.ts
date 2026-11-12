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
import { realpathSync } from "fs"

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
// as well: arguments (including `--opt=value`, `key=value` and attached short-option values), a
// command run by path, redirection targets and the words after them, heredoc arguments, assignment
// and array values, `for`/`[[ ]]`/`case` words, the directories commands run in, and literal
// `sh -c`/`eval`/`env -S`/`find -exec` strings. Each is resolved against the directory its command
// runs in, following symlinks before `..` the way the kernel does. Under the default ("ask") and
// "allow" nothing changes. This is a guard rail over literal command text, not an OS sandbox.

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
// Wrapper options whose value is the next word (or attached, or after `=`).
const WRAPPER_VALUE_OPTIONS: Record<string, string[]> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"],
  sudo: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  nice: ["-n", "--adjustment"],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  xargs: ["-I", "-J", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "-R", "-S", "--arg-file", "--delimiter", "--replace"],
  exec: ["-a"],
}
// Wrapper options that run the wrapped program in another directory.
const WRAPPER_CHDIR_OPTIONS: Record<string, string[]> = { env: ["-C", "--chdir"], sudo: ["-D", "--chdir"] }
// Shells whose `-c` string is parsed with the same parser, and their options that take a value.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const SHELL_VALUE_OPTIONS = ["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]
// `find` actions that run the words up to `;` or `+` as a command.
const FIND_EXEC = ["-exec", "-execdir", "-ok", "-okdir"]
// Programs that can create the missing parents of a path they are given.
const PARENT_CREATING = new Set([
  "mkdir",
  "install",
  "cp",
  "mv",
  "ln",
  "rsync",
  "ditto",
  "tar",
  "unzip",
  "cpio",
  "pax",
  "git",
  "curl",
  "wget",
])
// Option tables for programs whose operands or option values are not all paths. A `pattern`
// value (and, without one, the first operand of a pattern program) is a program or regex;
// a `value` is a non-path setting; a `file` value is a path and stays checked.
type OptionKind = "pattern" | "file" | "value"
interface OptionSpec {
  pattern: boolean
  short: Record<string, OptionKind>
  long: Record<string, OptionKind>
}
const GREP_OPTIONS: OptionSpec = {
  pattern: true,
  short: { e: "pattern", f: "file", A: "value", B: "value", C: "value", m: "value", d: "value", D: "value" },
  long: {
    "--regexp": "pattern",
    "--file": "file",
    "--exclude-from": "file",
    "--after-context": "value",
    "--before-context": "value",
    "--context": "value",
    "--max-count": "value",
    "--label": "value",
    "--devices": "value",
    "--directories": "value",
    "--binary-files": "value",
    "--exclude": "value",
    "--include": "value",
    "--exclude-dir": "value",
    "--group-separator": "value",
  },
}
const RG_OPTIONS: OptionSpec = {
  pattern: true,
  short: {
    e: "pattern",
    f: "file",
    A: "value",
    B: "value",
    C: "value",
    m: "value",
    M: "value",
    t: "value",
    T: "value",
    g: "value",
    j: "value",
    r: "value",
    E: "value",
    d: "value",
  },
  long: {
    "--regexp": "pattern",
    "--file": "file",
    "--ignore-file": "file",
    "--glob": "value",
    "--iglob": "value",
    "--type": "value",
    "--type-not": "value",
    "--type-add": "value",
    "--replace": "value",
    "--max-count": "value",
    "--max-depth": "value",
    "--context": "value",
    "--after-context": "value",
    "--before-context": "value",
    "--threads": "value",
    "--encoding": "value",
    "--sort": "value",
    "--sortr": "value",
  },
}
const SED_OPTIONS: OptionSpec = {
  pattern: true,
  short: { e: "pattern", f: "file", l: "value" },
  long: { "--expression": "pattern", "--file": "file", "--line-length": "value" },
}
const AWK_OPTIONS: OptionSpec = {
  pattern: true,
  short: { F: "value", v: "value", f: "file", e: "pattern", E: "file", i: "file", l: "value" },
  long: {
    "--field-separator": "value",
    "--assign": "value",
    "--file": "file",
    "--source": "pattern",
    "--exec": "file",
    "--include": "file",
    "--load": "value",
  },
}
const OPTION_SPECS: Record<string, OptionSpec> = {
  grep: GREP_OPTIONS,
  egrep: GREP_OPTIONS,
  fgrep: GREP_OPTIONS,
  rg: RG_OPTIONS,
  sed: SED_OPTIONS,
  gsed: SED_OPTIONS,
  awk: AWK_OPTIONS,
  gawk: AWK_OPTIONS,
  mawk: AWK_OPTIONS,
  nawk: AWK_OPTIONS,
  cut: {
    pattern: false,
    short: { d: "value", f: "value", c: "value", b: "value" },
    long: { "--delimiter": "value", "--fields": "value", "--output-delimiter": "value" },
  },
  sort: {
    pattern: false,
    short: { t: "value", k: "value", S: "value", T: "file", o: "file" },
    long: {
      "--field-separator": "value",
      "--key": "value",
      "--buffer-size": "value",
      "--temporary-directory": "file",
      "--output": "file",
    },
  },
  paste: { pattern: false, short: { d: "value" }, long: { "--delimiters": "value" } },
  column: { pattern: false, short: { s: "value", o: "value", c: "value" }, long: {} },
}
// Programs whose operands are character sets, never paths.
const NON_PATH_OPERANDS = new Set(["tr"])
const MAX_SHELL_DEPTH = 3
// Bounds the realpath/stat work one command can cause.
const MAX_GUARD_CANDIDATES = 2000
const DIRECTORY_CAP_REFUSAL = `more than ${MAX_TRACKED_DIRECTORIES} working directories to track; split the command`
const LOOP_REFUSAL = "a loop body that changes directory (cd/pushd/popd)"

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

// Joins a target onto a directory the way the kernel walks it: a `..` steps out of the real
// directory, so `lnk/..` is the parent of the symlink's target, not the directory holding `lnk`.
function physicalJoin(base: string, target: string) {
  const segments = target.split(path.sep === "\\" ? /[\\/]+/ : "/")
  if (!segments.includes("..")) return path.resolve(base, target)
  let current = path.isAbsolute(target) ? path.parse(path.resolve(target)).root : path.resolve(base)
  for (const segment of segments) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      current = path.dirname(realpathOrSelf(current))
      continue
    }
    current = path.join(current, segment)
  }
  return current
}

function realpathOrSelf(target: string) {
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

// The directories `cd target` can land in: the shell's logical default and the physical walk.
function directoryTargets(cwds: string[], target: string) {
  const expanded = expandHome(target)
  return [...new Set(cwds.flatMap((cwd) => [path.resolve(cwd, expanded), physicalJoin(cwd, expanded)]))]
}

const GUARD_WORD_TYPES = ["command_name", "word", "string", "raw_string", "concatenation", "number", "ansi_c_string"]

function guardWords(node: Node) {
  return node.namedChildren.filter((child): child is Node => child !== null && GUARD_WORD_TYPES.includes(child.type))
}

type Literal = { text: string } | { refuse: string } | undefined

// A word's literal value, also covering `$'…'` without escapes, `~user`, `~+` and `~-`.
function guardLiteral(node: Node | null): Literal {
  if (!node) return
  if (node.type === "ansi_c_string") return node.text.includes("\\") ? undefined : { text: node.text.slice(2, -1) }
  if (node.type === "concatenation" || node.type === "command_name") {
    const parts = node.namedChildren.map(guardLiteral)
    if (parts.some((part) => part && "refuse" in part)) return { refuse: node.text }
    if (parts.every((part) => part !== undefined))
      return { text: parts.map((part) => (part as { text: string }).text).join("") }
    return
  }
  if (node.type === "word" && /^~[+-](?=\/|$)/.test(node.text)) {
    // `~-` is the previous directory, which may be inherited from outside the project.
    if (node.text[1] === "-") return { refuse: node.text }
    const rest = node.text.slice(2)
    if (/[~$*?{\[]/.test(rest.replace(/\\./gs, ""))) return
    return { text: "." + rest.replace(/\\(.)/gs, "$1") }
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
// or the attached value of a short option (`-oFILE`). A lone `/` given as a value (`-d/`,
// `IFS=/`) is a separator, not the root directory.
function argumentValues(arg: string) {
  const values = (() => {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=")
      return eq > 0 ? [arg.slice(eq + 1)] : []
    }
    if (arg.startsWith("-")) return /^-[A-Za-z]/.test(arg) ? [arg.slice(2)] : []
    const assignment = /^[A-Za-z_][\w.-]*=(.*)$/s.exec(arg)
    return assignment ? [arg, assignment[1]] : [arg]
  })()
  return values.filter((value, i) => value !== "" && !(value === "/" && (i > 0 || arg !== "/")))
}

// Literal pieces of an assignment value; `PATH`-style values are split on `:`; array elements one by one.
function assignmentValues(value: Node | null): string[] {
  if (!value) return []
  if (value.type === "array") return value.namedChildren.flatMap((element) => assignmentValues(element))
  const literal = guardLiteral(value)
  let text = literal && "text" in literal ? literal.text : value.text
  if (!literal && value.type === "string") text = text.slice(1, -1)
  return text
    .split(":")
    .filter((piece) => piece && piece !== "/" && !/[$`*?[]/.test(piece.replace(/\\./gs, "")))
    .map((piece) => expandHome(piece.replace(/\\(.)/gs, "$1")))
}

interface GuardScan {
  candidates: Set<string>
  // Candidates named to a program that can create missing parents (`mkdir -p`, `install -D`).
  strict: Set<string>
  refusals: Set<string>
  // The pushd stack, and every directory a `cd -` could return to.
  stack: string[][]
  left: Set<string>
  // Directory changes in the current shell, so loops and functions that move can be refused.
  moves: number
  depth: number
  parse: (text: string) => Node | undefined
}
interface Cwds {
  // directories after the node when it succeeded, and in any outcome
  ok: string[]
  any: string[]
}

// Every directory a command may run in. Past the cap the guard cannot track them, so it refuses.
function union(scan: GuardScan, ...lists: string[][]) {
  const all = [...new Set(lists.flat())]
  if (all.length > MAX_TRACKED_DIRECTORIES) scan.refusals.add(DIRECTORY_CAP_REFUSAL)
  return all.slice(0, MAX_TRACKED_DIRECTORIES)
}
const same = (cwds: string[]): Cwds => ({ ok: cwds, any: cwds })

function addCandidate(scan: GuardScan, cwds: string[], value: string, strict = false) {
  const target = expandHome(value)
  for (const cwd of cwds) {
    const joined = physicalJoin(cwd, target)
    scan.candidates.add(joined)
    if (strict) scan.strict.add(joined)
  }
}

// A part of the script that runs in another process (subshell, substitution, `sh -c`): its
// directory changes and pushd stack stay there.
function isolated<T>(scan: GuardScan, fn: () => T): T {
  const { moves, stack } = scan
  scan.stack = [...stack]
  try {
    return fn()
  } finally {
    scan.moves = moves
    scan.stack = stack
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
    case "file_redirect": {
      // `destination` holds several words when arguments follow the target (`cat > out /x`):
      // the first is the target, the rest are arguments of the command.
      const words = node.namedChildren.filter((child): child is Node => !!child && child.type !== "file_descriptor")
      words.forEach((child, i) => {
        if (i > 0) return addWord(scan, cwds, child)
        const literal = guardLiteral(child)
        if (literal && "refuse" in literal) scan.refusals.add(literal.refuse)
        else if (literal) addCandidate(scan, cwds, literal.text)
      })
      scanChildren(node, cwds, scan)
      return same(cwds)
    }
    case "heredoc_redirect":
      // `cat <<EOF /x` passes /x to cat; the body is text.
      for (const argument of node.childrenForFieldName("argument")) addWord(scan, cwds, argument)
      return same(scanSequence(node, cwds, scan))
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
      return { ok: or ? union(scan, l.ok, r.ok) : r.ok, any: union(scan, l.any, r.any) }
    }
    case "pipeline":
      return scanPipeline(
        node.namedChildren.filter((child): child is Node => !!child),
        [],
        cwds,
        scan,
      )
    case "subshell":
    case "command_substitution":
    case "process_substitution":
      // These run in another process, so their directory changes stay local.
      isolated(scan, () => scanSequence(node, cwds, scan))
      return same(cwds)
    case "function_definition": {
      // A function runs in the calling shell; one that changes directory is refused rather than
      // tracked at each call. Its own pushd stack starts empty so a `popd` in it is seen too.
      const { moves, stack } = scan
      scan.stack = []
      scanSequence(node, cwds, scan)
      if (scan.moves !== moves)
        scan.refusals.add(`a function body that changes directory (${node.childForFieldName("name")?.text ?? ""})`)
      scan.moves = moves
      scan.stack = stack
      return same(cwds)
    }
    case "for_statement":
    case "c_style_for_statement":
    case "while_statement": {
      // A loop body runs any number of times; one that changes directory is refused.
      const moves = scan.moves
      if (node.type === "for_statement")
        for (const value of node.childrenForFieldName("value")) addWord(scan, cwds, value)
      const after = scanSequence(node, cwds, scan)
      if (scan.moves !== moves) scan.refusals.add(LOOP_REFUSAL)
      return same(after)
    }
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

// Children that cannot change the directory (substitutions inside words).
function scanChildren(node: Node, cwds: string[], scan: GuardScan) {
  for (const child of node.namedChildren) scanNode(child, cwds, scan)
}

// Every stage but the last runs in a subshell. bash runs the last one in a subshell too, zsh in
// the current shell, so a directory change there may or may not carry on.
function scanPipeline(stages: Node[], redirects: Node[], cwds: string[], scan: GuardScan): Cwds {
  for (const stage of stages.slice(0, -1)) isolated(scan, () => scanNode(stage, cwds, scan))
  const last = scanRedirected(stages.at(-1) ?? null, redirects, cwds, scan)
  return { ok: union(scan, cwds, last.ok), any: union(scan, cwds, last.any) }
}

// The parser attaches `a && b > f` and `a | b > f` to the whole list; the shell applies the
// redirection to the last command only, in that command's directory.
function scanRedirected(body: Node | null, redirects: Node[], cwds: string[], scan: GuardScan): Cwds {
  if (body?.type === "list") {
    const [left, right] = body.namedChildren
    const or = body.children.some((child) => child?.type === "||")
    const l = scanNode(left, cwds, scan)
    const r = scanRedirected(right, redirects, or ? l.any : l.ok, scan)
    return { ok: or ? union(scan, l.ok, r.ok) : r.ok, any: union(scan, l.any, r.any) }
  }
  if (body?.type === "pipeline")
    return scanPipeline(
      body.namedChildren.filter((child): child is Node => !!child),
      redirects,
      cwds,
      scan,
    )
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

// A word quoted so the parser reads it back as the same single literal.
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

// A wrapper option that takes a value: its name and the attached or `=` value, if any.
function wrapperOption(arg: string, options: string[]) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=")
    const name = eq > 0 ? arg.slice(0, eq) : arg
    if (options.includes(name)) return { name, value: eq > 0 ? arg.slice(eq + 1) : undefined }
    return
  }
  const name = arg.slice(0, 2)
  if (/^-[A-Za-z]/.test(arg) && options.includes(name))
    return { name, value: arg.length > 2 ? arg.slice(2) : undefined }
}

// Marks option values and pattern operands that are not paths (`skip`), and the attached path
// value of a short option inside a cluster (`values`, `grep -rfFILE`).
function scanOptions(
  spec: OptionSpec,
  start: number,
  end: number,
  text: (i: number) => string | undefined,
  skip: Set<number>,
  values: Map<number, string[]>,
) {
  let explicit = false
  for (let i = start; i < end; i++) {
    const arg = text(i)
    if (arg === undefined) {
      if (spec.pattern) return
      continue
    }
    if (arg === "--") {
      if (spec.pattern && !explicit) skip.add(i + 1)
      return
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=")
      const kind = spec.long[eq > 0 ? arg.slice(0, eq) : arg]
      if (!kind) continue
      if (kind !== "value") explicit = true
      if (eq < 0) i++
      if (kind !== "file") skip.add(i)
      continue
    }
    if (/^-[A-Za-z0-9]/.test(arg)) {
      const word = i
      for (let c = 1; c < arg.length; c++) {
        const kind = spec.short[arg[c]]
        if (!kind) continue
        if (kind !== "value") explicit = true
        const rest = arg.slice(c + 1)
        if (rest) {
          if (kind === "file") values.set(word, [rest])
          else skip.add(word)
        } else {
          i++
          if (kind !== "file") skip.add(i)
        }
        break
      }
      continue
    }
    if (!spec.pattern) continue
    if (!explicit) skip.add(i)
    return
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
  // Words that are not paths, and words whose path values are known exactly.
  const skip = new Set<number>()
  const values = new Map<number, string[]>()

  // Wrappers (`env -u X FOO=1 nohup python …`) are followed, through their options, to the program
  // they run. `env -C dir` runs the rest of the words in dir; `command -v` only looks names up.
  const programs: number[] = []
  const names: number[] = []
  let runCwds = cwds
  let runFrom = words.length
  walk: for (let i = 0; i < words.length; ) {
    const literal = literals[i]
    if (literal && "refuse" in literal) {
      scan.refusals.add(literal.refuse)
      break
    }
    const word = text(i)
    if (word === undefined) break
    programs.push(i)
    const wrapper = path.basename(word)
    if (!WRAPPERS.has(wrapper)) break
    const valueOptions = WRAPPER_VALUE_OPTIONS[wrapper] ?? []
    const chdirOptions = WRAPPER_CHDIR_OPTIONS[wrapper] ?? []
    i++
    while (i < words.length) {
      const arg = text(i)
      if (arg === undefined) break
      if (wrapper === "command" && /^-[pvV]*[vV]/.test(arg)) {
        for (let k = i + 1; k < words.length; k++) names.push(k)
        break walk
      }
      if (arg === "--") {
        i++
        break
      }
      const option = wrapperOption(arg, valueOptions)
      if (option) {
        const width = option.value === undefined ? 2 : 1
        const value = option.value ?? text(i + 1)
        if (chdirOptions.includes(option.name)) {
          if (value === undefined) scan.refusals.add(`a ${wrapper} ${option.name} directory that is not literal`)
          else {
            runCwds = directoryTargets(runCwds, value)
            runFrom = i + width
          }
        }
        if (wrapper === "env" && (option.name === "-S" || option.name === "--split-string")) {
          // `env -S 'prog args'` runs the split string; nothing after it is a program.
          if (value === undefined) scan.refusals.add("an env -S string that is not literal")
          else isolated(scan, () => scanNested(value, runCwds, scan))
          skip.add(i + width - 1)
          break walk
        }
        i += width
        continue
      }
      if (!/^(-|[A-Za-z_]\w*=|\d+(\.\d+)?[smhd]?$)/.test(arg)) break
      i++
    }
  }
  const program = programs.at(-1) ?? 0
  const programCwds = program >= runFrom ? runCwds : cwds
  for (const index of [...programs, ...names]) {
    skip.add(index)
    const name = text(index)
    if (!name?.includes("/")) continue
    for (const cwd of index >= runFrom ? runCwds : cwds) {
      const target = physicalJoin(cwd, expandHome(name))
      if (!SYSTEM_BIN_DIRS.has(path.dirname(target))) scan.candidates.add(target)
    }
  }
  const name = text(program)
  const base = name === undefined ? undefined : path.basename(name)
  const start = program + 1

  if (base === "cd" || base === "pushd" || base === "popd")
    return changeDirectory(base, start, words, literals, cwds, scan)
  if (base && SHELLS.has(base)) {
    // `bash -o pipefail -lc 'script'`: the first operand after the options is the script.
    let i = start
    let command = false
    while (i < words.length) {
      const arg = text(i)
      if (arg === undefined) break
      if (SHELL_VALUE_OPTIONS.includes(arg)) i += 2
      else if (/^[-+][A-Za-z]+$/.test(arg)) {
        if (arg[0] === "-" && arg.includes("c")) command = true
        // `-eo pipefail`: a cluster ending in `o`/`O` takes the next word.
        i += /[oO]$/.test(arg) ? 2 : 1
      } else if (arg.startsWith("--")) i += arg === "--" ? 0 : 1
      else break
      if (arg === "--") {
        i++
        break
      }
    }
    const script = text(i)
    if (command && script !== undefined) {
      isolated(scan, () => scanNested(script, programCwds, scan))
      skip.add(i)
    }
  }
  if (base === "eval" && words.slice(start).every((_, i) => text(start + i) !== undefined)) {
    // `eval` runs in this shell, so its directory changes carry on.
    return scanNested(
      words
        .slice(start)
        .map((_, i) => text(start + i))
        .join(" "),
      cwds,
      scan,
    )
  }
  if (base === "find") {
    // `find … -exec prog args ;` runs prog; its words are scanned as a command of their own.
    for (let i = start; i < words.length; i++) {
      if (!FIND_EXEC.includes(text(i) ?? "")) continue
      let end = i + 1
      while (end < words.length && text(end) !== ";" && text(end) !== "+") end++
      const command = words.slice(i + 1, end).map((_, k) => text(i + 1 + k))
      if (command.length && command.every((word) => word !== undefined)) {
        isolated(scan, () => scanNested(command.map((word) => shellQuote(word!)).join(" "), programCwds, scan))
        for (let k = i + 1; k < end; k++) skip.add(k)
      }
      i = end
    }
  }

  const spec = base ? OPTION_SPECS[base] : undefined
  if (spec) scanOptions(spec, start, words.length, text, skip, values)
  if (base && NON_PATH_OPERANDS.has(base)) for (let i = start; i < words.length; i++) skip.add(i)
  const strict = base !== undefined && PARENT_CREATING.has(base)
  for (let i = 1; i < words.length; i++) {
    if (skip.has(i)) continue
    const literal = literals[i]
    if (!literal) continue
    if ("refuse" in literal) {
      scan.refusals.add(literal.refuse)
      continue
    }
    const dirs = i >= runFrom ? runCwds : cwds
    for (const value of values.get(i) ?? argumentValues(literal.text)) addCandidate(scan, dirs, value, strict)
  }
  return same(cwds)
}

// `cd`, `pushd` and `popd`: where the shell can be afterwards. A `cd` whose target is not literal
// (`cd "$d"`) is not followed. A stack rotation (`pushd +1`) and `~-` are refused.
function changeDirectory(
  base: string,
  start: number,
  words: Node[],
  literals: Literal[],
  cwds: string[],
  scan: GuardScan,
): Cwds {
  scan.moves++
  for (const cwd of cwds) scan.left.add(cwd)
  const text = (i: number) => {
    const literal = literals[i]
    return literal && "text" in literal ? literal.text : undefined
  }
  let i = start
  while (i < words.length && ["-L", "-P", "-e", "-@", "-n"].includes(text(i) ?? "")) i++
  if (text(i) === "--") i++
  const literal = literals[i]
  if (literal && "refuse" in literal) {
    scan.refusals.add(literal.refuse)
    return same(cwds)
  }
  const target = i < words.length ? text(i) : undefined
  if (target !== undefined && /^[+-]\d+$/.test(target)) {
    scan.refusals.add(`a directory stack rotation (${base} ${target})`)
    return same(cwds)
  }
  if (base === "popd") {
    if (i < words.length) {
      scan.refusals.add(`a directory stack edit (popd ${words[i].text})`)
      return same(cwds)
    }
    const previous = scan.stack.pop()
    return previous ? { ok: previous, any: union(scan, cwds, previous) } : same(cwds)
  }
  if (base === "pushd" && i >= words.length) {
    // A bare pushd swaps the top two entries.
    const top = scan.stack.pop()
    if (!top) return same(cwds)
    scan.stack.push(cwds)
    return { ok: top, any: union(scan, cwds, top) }
  }
  if (i < words.length && target === undefined) return same(cwds)
  // `cd -` returns to any directory the script has left (zsh starts with the current one).
  const fresh = target === "-" ? union(scan, [...scan.left]) : union(scan, directoryTargets(cwds, target ?? homedir()))
  if (base === "pushd") scan.stack.push(cwds)
  for (const dir of fresh) scan.candidates.add(dir)
  return { ok: fresh, any: union(scan, cwds, fresh) }
}

// Literal path candidates a command names, resolved against the directory each part runs in.
export function commandPathCandidates(root: Node, cwd: string, parse: (text: string) => Node | undefined) {
  const scan: GuardScan = {
    candidates: new Set(),
    strict: new Set(),
    refusals: new Set(),
    stack: [],
    left: new Set([cwd]),
    moves: 0,
    depth: 0,
    parse,
  }
  scanNode(root, [cwd], scan)
  return {
    candidates: [...scan.candidates].filter((target) => !isDevice(target)),
    strict: scan.strict,
    refusals: [...scan.refusals],
  }
}

// Out-of-project locations a command names, with whether each exists yet.
async function externalCommandPaths(candidates: string[], strict: Set<string>, abort: AbortSignal) {
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
    // no real location. A missing top-level entry itself (`touch /new`) can be created, so it stays
    // a candidate, as does every path given to a program that creates missing parents.
    const first = firstSegmentPath(real)
    if (first && first !== real && !strict.has(target) && !(await fs.stat(first).catch(() => undefined))) continue
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
        const { candidates, strict, refusals } = commandPathCandidates(
          tree.rootNode,
          cwd,
          (text) => p.parse(text)?.rootNode ?? undefined,
        )
        const denied = new Set<string>(refusals)
        for (const item of await externalCommandPaths(candidates, strict, ctx.abort)) {
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
