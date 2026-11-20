// altimate_change start — executing reproductions for the bash `external_directory: deny` guard
// Every row runs the real tool against a real outside directory. A refusal row passes only when
// the error names the exact outside path (or the exact refusal reason) and nothing outside was read
// or written; an allowed row passes only when the command ran and printed what it should.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { tmpdir, provideTestInstance } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"
import { PermissionEvaluate } from "../../src/permission/evaluate"
import { Truncate } from "../../src/tool/truncation"
import { SessionID, MessageID } from "../../src/session/schema"
import { initTool } from "../altimate/tool-fixture"

const SECRET = "SECRET-OUTSIDE-CONTENT"
// A top-level name that does not exist; a write below it needs a parent-creating command.
const MISSING_TOP = `altimate-guard-missing-${Math.random().toString(36).slice(2)}`
const USER = os.userInfo().username

afterAll(async () => {
  await fs.rm(`/${MISSING_TOP}`, { recursive: true, force: true }).catch(() => {})
})

const ruleset: PermissionNext.Ruleset = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "external_directory", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: Truncate.GLOB, action: "allow" },
]

function context(abort: AbortSignal = AbortSignal.any([])) {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort,
    messages: [],
    metadata: () => {},
    permissions: ruleset,
    ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
      for (const { rule } of PermissionEvaluate.evaluateRequestPatterns(request, ruleset)) {
        if (rule.action === "deny") throw new Error("PermissionDeniedError")
      }
    },
  }
}

// O: an outside directory with s.txt (known content) and d/. P: the project, with a/b, f ("a/b"),
// lnk -> O/d and flnk -> O/s.txt.
async function fixture() {
  const outside = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "s.txt"), `${SECRET}\n`)
      await fs.mkdir(path.join(dir, "d"))
    },
  })
  const project = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "inside.txt"), "inside content")
      await Bun.write(path.join(dir, "f"), "a/b\n")
      await fs.mkdir(path.join(dir, "a", "b"), { recursive: true })
    },
  })
  await fs.symlink(path.join(outside.path, "d"), path.join(project.path, "lnk"))
  await fs.symlink(path.join(outside.path, "s.txt"), path.join(project.path, "flnk"))
  return { outside, project }
}

// The entries a refusal names: the list between "): " and ". Use paths".
function named(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const list = /outside the project \(.*?\): (.*)\. Use paths inside the project instead\./s.exec(message)
  return { message, list: list ? list[1].split(", ") : [] }
}

type Expect = { path: string } | { reason: string } | { message: RegExp }
type Row = [
  name: string,
  command: (o: string, p: string) => string,
  expect: (o: string, p: string) => Expect,
  workdir?: string,
]

const sq = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
const ob = (o: string) => path.basename(o)

const REFUSED: Row[] = [
  // thread bash.ts:326 — a symlink followed by `..`
  ["symlink then .. read", () => `head lnk/../s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["symlink then .. write", () => `echo x > lnk/../w`, (o) => ({ path: `${o}/w` })],
  ["cd through symlink then ..", () => `cd -P lnk/.. && head s.txt`, (o) => ({ path: o })],
  // thread bash.ts:500 — `-c` behind value-taking options, wrappers with options, find -exec
  ["bash -o pipefail -c", (o) => `bash -o pipefail -c 'head ${o}/s.txt'`, (o) => ({ path: `${o}/s.txt` })],
  ["env -u FOO bash -c", (o) => `env -u FOO bash -c 'head ${o}/s.txt'`, (o) => ({ path: `${o}/s.txt` })],
  ["find -exec sh -c", (o) => `find . -maxdepth 0 -exec sh -c 'head ${o}/s.txt' ';'`, (o) => ({ path: `${o}/s.txt` })],
  [
    "find -execdir sh -c",
    (o) => `find . -maxdepth 0 -execdir sh -c 'head ${o}/s.txt' ';'`,
    (o) => ({ path: `${o}/s.txt` }),
  ],
  // thread bash.ts:294 — array assignments
  ["array assignment", (o) => `A=(${o}/s.txt); head "\${A[@]}"`, (o) => ({ path: `${o}/s.txt` })],
  ["array append assignment", (o) => `A=(); A+=(${o}/s.txt); head "\${A[@]}"`, (o) => ({ path: `${o}/s.txt` })],
  // thread bash.ts:287 — attached short-option value without a slash
  ["attached -o through a file symlink", () => `sort -oflnk inside.txt`, (o) => ({ path: `${o}/s.txt` })],
  // thread bash.ts:485 — cd/pushd targets and program words through the full literal decoder
  ["cd $'…'", (o) => `cd $'${o}' && head s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["pushd $'…'", (o) => `pushd $'${o}' && head s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["cd ~current-user", () => `cd ~${USER} && pwd`, () => ({ path: HOME })],
  ["cd ~root", () => `cd ~root && pwd`, () => ({ path: "~root" })],
  ["~root program", () => `~root/x`, () => ({ path: "~root/x" })],
  // thread bash.ts:530 — grep option spellings
  ["grep -F", (o) => `grep -F SECRET ${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["grep -v", (o) => `grep -v NOPE ${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["grep -l", (o) => `grep -l SECRET ${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["grep -s", (o) => `grep -s SECRET ${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["grep -ePAT", (o) => `grep -eSECRET ${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["grep --regexp=PAT", (o) => `grep --regexp=SECRET ${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["grep -ie PAT", (o) => `grep -ie secret ${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["grep -f FILE", (o) => `grep -f ${o}/s.txt inside.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["awk -F, program, file", (o) => `awk -F: '{print}' ${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  // thread bash.ts:348 — words after a redirection target, heredoc arguments
  ["key=value after a redirection", (o) => `dd 2>/dev/null if=${o}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  ["--opt=value after a redirection", (o) => `sort > log --output=${o}/w inside.txt`, (o) => ({ path: `${o}/w` })],
  ["heredoc argument", (o) => `cat <<EOF ${o}/s.txt\nbody\nEOF`, (o) => ({ path: `${o}/s.txt` })],
  // thread bash.ts:550 — the wrapper system-bin exemption covers only the wrapped program
  ["wrapper data operand in a system bin", () => `env cat /usr/bin/true`, () => ({ path: "/usr/bin/true" })],
  ["nohup data operand in a system bin", () => `nohup cat /usr/bin/true`, () => ({ path: "/usr/bin/true" })],
  // thread bash.ts:320 — the directory cap fails closed and keeps the real working directory
  [
    "directory cap",
    (o) => `cd m1; cd m2; cd m3; cd m4; cd m5; cd m6; head ../${ob(o)}/s.txt`,
    () => ({ reason: "more than 32 working directories" }),
  ],
  [
    "directory cap keeps the real directory",
    (o) => `cd m1; cd m2; cd m3; cd m4; cd m5; cd m6; head ../${ob(o)}/s.txt`,
    (o) => ({ path: `${o}/s.txt` }),
  ],
  // thread bash.ts:370 — directory changes inside a function
  [
    "cd in a function",
    (o) => `f() { cd ../..; }; f && head ../${ob(o)}/s.txt`,
    () => ({ reason: "a function body that changes directory (f)" }),
    "a/b",
  ],
  [
    "pushd in a function",
    (o) => `f() { pushd ../..; }; f && head ../${ob(o)}/s.txt`,
    () => ({ reason: "a function body that changes directory (f)" }),
    "a/b",
  ],
  // thread bash.ts:378 — directory changes inside a loop
  [
    "cd in a for loop",
    (o) => `for n in 1 2; do cd ..; done; head ../${ob(o)}/s.txt`,
    () => ({ reason: "a loop body that changes directory" }),
    "a/b",
  ],
  [
    "cd in a while loop",
    (o) => `i=0; while [ $i -lt 2 ]; do cd ..; i=$((i+1)); done; head ../${ob(o)}/s.txt`,
    () => ({ reason: "a loop body that changes directory" }),
    "a/b",
  ],
  [
    "cd in an until loop",
    (o) => `i=0; until [ $i -ge 2 ]; do cd ..; i=$((i+1)); done; head ../${ob(o)}/s.txt`,
    () => ({ reason: "a loop body that changes directory" }),
    "a/b",
  ],
  [
    "cd in a c-style for loop",
    (o) => `for ((i=0;i<2;i++)); do cd ..; done; head ../${ob(o)}/s.txt`,
    () => ({ reason: "a loop body that changes directory" }),
    "a/b",
  ],
  // thread bash.ts:468 — wrapper options that change directory
  ["env -C", (o) => `env -C ../.. head ../${ob(o)}/s.txt`, (o) => ({ path: `${o}/s.txt` }), "a/b"],
  ["env --chdir=", (o) => `env --chdir=../.. head ../${ob(o)}/s.txt`, (o) => ({ path: `${o}/s.txt` }), "a/b"],
  // thread bash.ts:583 — parent-creating commands below a missing top-level entry
  [
    "install -D below a missing top level",
    () => `install -D inside.txt /${MISSING_TOP}/a/file`,
    () => ({ path: `/${MISSING_TOP}/a/file` }),
  ],
  [
    "cp --parents below a missing top level",
    () => `cp --parents inside.txt /${MISSING_TOP}/a/`,
    () => ({ path: `/${MISSING_TOP}/a` }),
  ],
  // thread bash.ts:484 — bare pushd swaps, a subshell's pushd stays local
  ["bare pushd swaps back", (o) => `pushd a && pushd && head ../${ob(o)}/s.txt`, (o) => ({ path: `${o}/s.txt` })],
  [
    "pushd in a subshell is local",
    (o) => `pushd a/b && (pushd ..) && popd && head ../${ob(o)}/s.txt`,
    (o) => ({ path: `${o}/s.txt` }),
  ],
  // extra guard limits
  [
    "nesting overflow",
    (o) => {
      let script = `head ${o}/s.txt`
      for (let i = 0; i < 4; i++) script = `bash -c ${sq(script)}`
      return script
    },
    () => ({ reason: "shell commands nested more than 3 levels deep" }),
  ],
  [
    "candidate overflow",
    () => `echo ${Array.from({ length: 2001 }, (_, i) => `x${i}`).join(" ")}`,
    () => ({ message: /more than 2000 paths to check/ }),
  ],
]

let HOME = ""

describe("bash external_directory: deny — executing reproductions", () => {
  // Fixed-length rows: bun passes a done callback in place of a missing trailing argument.
  test.each(REFUSED.map(([n, c, e, w]) => [n, c, e, w ?? ""] as const))(
    "refuses: %s",
    async (_name, command, expected, workdir) => {
      HOME = await fs.realpath(os.homedir())
      const { outside, project } = await fixture()
      await using _o = outside
      await using _p = project
      const o = outside.path
      const p = project.path
      const want = expected(o, p)
      let output: string | undefined
      let error: unknown
      await provideTestInstance({
        directory: p,
        fn: (instanceCtx) =>
          Instance.restore(instanceCtx, async () => {
            const bash = await initTool(BashTool)
            try {
              const result = await bash.execute(
                { command: command(o, p), ...(workdir && { workdir: path.join(p, workdir) }), description: "repro" },
                context(),
              )
              output = result.output
            } catch (e) {
              error = e
            }
          }),
      })
      // Nothing outside was read or written.
      expect(output ?? "").not.toContain(SECRET)
      expect(await Bun.file(path.join(o, "s.txt")).text()).toBe(`${SECRET}\n`)
      expect(await Bun.file(path.join(o, "w")).exists()).toBe(false)
      expect(await fs.stat(`/${MISSING_TOP}`).catch(() => undefined)).toBeUndefined()
      // It was refused, naming exactly what it should.
      expect({ ran: output !== undefined }).toEqual({ ran: false })
      const { message, list } = named(error)
      if ("path" in want) expect(list).toContain(want.path)
      else if ("reason" in want) expect(list.find((entry) => entry.startsWith(want.reason))).toBeDefined()
      else expect(message).toMatch(want.message)
    },
  )

  test("an aborted call is refused before anything runs", async () => {
    const { outside, project } = await fixture()
    await using _o = outside
    await using _p = project
    const controller = new AbortController()
    controller.abort()
    await provideTestInstance({
      directory: project.path,
      fn: (instanceCtx) =>
        Instance.restore(instanceCtx, async () => {
          const bash = await initTool(BashTool)
          await expect(
            bash.execute({ command: `echo x > ${outside.path}/w`, description: "repro" }, context(controller.signal)),
          ).rejects.toThrow(/abort/i)
        }),
    })
    expect(await Bun.file(path.join(outside.path, "w")).exists()).toBe(false)
  })

  const ALLOWED: [command: string, expected: string, workdir?: string][] = [
    // thread bash.ts:523 — pattern spellings that read only inside.txt
    ["grep -e/etc/ inside.txt || true", ""],
    ["grep --regexp=/etc/ inside.txt || true", ""],
    ["grep -F /etc/ inside.txt || true", ""],
    ["grep -e inside inside.txt", "inside content"],
    ["grep -ie INSIDE inside.txt", "inside content"],
    ["grep -A 1 -m 1 inside inside.txt", "inside content"],
    ["grep -c -- /etc/ inside.txt || true", "0"],
    // thread bash.ts:582 — a bare `/` is a separator, not a path
    ["cut -d/ -f1 f", "a"],
    ["awk -F/ '{print $1}' f", "a"],
    ["tr / _ < f", "a_b"],
    ["IFS=/ read a b < f && echo $a", "a"],
    ["sort -t/ -k2 f", "a/b"],
    // thread bash.ts:505 — a parsed `-c` script is not also a path
    ["bash -c '/usr/bin/true'", ""],
    ["bash -o pipefail -c 'head -c 3 inside.txt'", "ins"],
    // thread bash.ts:483 — `command -v` names, it does not run
    ["command -v cd", "cd"],
    ["command -v /usr/bin/true", "/usr/bin/true"],
    // forms the fixes must keep working
    ["sort -oout.txt inside.txt && cat out.txt", "inside content"],
    ["env -C a head -c 3 ../inside.txt", "ins"],
    ["env -u FOO head -c 3 inside.txt", "ins"],
    ["find . -maxdepth 0 -exec sh -c 'head -c 3 inside.txt' ';'", "ins"],
    ['A=(inside.txt); head -c 3 "${A[@]}"', "ins"],
    ["f() { head -c 3 inside.txt; }; f", "ins"],
    ["for d in a; do (cd a && head -c 3 ../inside.txt); done", "ins"],
    ["pushd a > /dev/null && pushd > /dev/null && head -c 3 inside.txt", "ins"],
    ["cd a/b && head -c 3 ../../inside.txt", "ins"],
    ["cd a/.. && head -c 3 inside.txt", "ins"],
    ["dd 2>/dev/null if=inside.txt bs=3 count=1", "ins"],
    ["cat <<EOF inside.txt\nbody\nEOF", "inside content"],
    ["nohup /usr/bin/true 2>/dev/null", ""],
    ["cut -d / -f2 f", "b"],
  ]

  test.each(ALLOWED.map(([c, e, w]) => [c, e, w ?? ""] as const))("allows: %s", async (command, expected, workdir) => {
    const { outside, project } = await fixture()
    await using _o = outside
    await using _p = project
    await provideTestInstance({
      directory: project.path,
      fn: (instanceCtx) =>
        Instance.restore(instanceCtx, async () => {
          const bash = await initTool(BashTool)
          const result = await bash.execute(
            { command, ...(workdir && { workdir: path.join(project.path, workdir) }), description: "repro" },
            context(),
          )
          expect(result.output.trim()).toBe(expected)
          expect(result.metadata.external_paths).toBeUndefined()
        }),
    })
  })
})
// altimate_change end
