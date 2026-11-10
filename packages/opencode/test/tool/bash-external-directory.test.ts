// altimate_change start — the bash tool applies a configured `external_directory: deny` to every path a command names
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as BashModule from "../../src/tool/bash"
const { BashTool } = BashModule
import { Instance } from "../../src/project/instance"
import { tmpdir, provideTestInstance } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"
import { PermissionEvaluate } from "../../src/permission/evaluate"
import { Truncate } from "../../src/tool/truncation"
import { SessionID, MessageID } from "../../src/session/schema"
import { initTool } from "../altimate/tool-fixture"

type Request = Omit<PermissionNext.Request, "id" | "sessionID" | "tool">

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

async function provideInstance<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  return provideTestInstance({ directory, fn: (instanceCtx) => Instance.restore(instanceCtx, fn) })
}

// The defaults an agent starts with, followed by the user's `permission` config, as the agent builds them.
function rules(external: Record<string, "allow" | "ask" | "deny"> | undefined): PermissionNext.Ruleset {
  return [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    ...Object.entries(external ?? {}).map(([pattern, action]) => ({
      permission: "external_directory",
      pattern,
      action,
    })),
    { permission: "external_directory", pattern: Truncate.GLOB, action: "allow" },
  ]
}

// Mirrors Permission.ask: a deny rule rejects, an ask rule prompts (recorded), allow passes.
function context(ruleset: PermissionNext.Ruleset | undefined) {
  const requests: Request[] = []
  const prompts: Request[] = []
  return {
    requests,
    prompts,
    ctx: {
      ...baseCtx,
      ...(ruleset && { permissions: ruleset }),
      ask: async (request: Request) => {
        requests.push(request)
        if (!ruleset) return
        for (const { rule } of PermissionEvaluate.evaluateRequestPatterns(request, ruleset)) {
          if (rule.action === "deny") throw new Error("PermissionDeniedError")
          if (rule.action === "ask") prompts.push(request)
        }
      },
    },
  }
}

async function fixture() {
  const outside = await tmpdir({
    init: async (dir) => {
      await fs.mkdir(path.join(dir, "sibling"))
      await Bun.write(path.join(dir, "sibling", "output.md"), "private content")
      await fs.mkdir(path.join(dir, "host", ".venv", "bin"), { recursive: true })
      const python = path.join(dir, "host", ".venv", "bin", "python")
      await Bun.write(python, `#!/bin/sh\necho ran > "${path.join(dir, "host", "ran.txt")}"\necho host-python\n`)
      await fs.chmod(python, 0o755)
    },
  })
  const project = await tmpdir({
    git: true,
    init: (dir) => Bun.write(path.join(dir, "inside.txt"), "inside content"),
  })
  return { outside, project }
}

describe("tool.bash external_directory: deny", () => {
  test.each([
    ["absolute read", (o: string) => `cat /etc/hosts`, /etc\/hosts/],
    [
      "read by a command outside the operand list",
      (o: string) => `head -n 1 ${o}/sibling/output.md`,
      /sibling\/output\.md/,
    ],
    ["home directory listing", () => `ls ~`, undefined],
    ["home-relative read", () => `cat ~/.profile-that-may-not-exist`, undefined],
    ["cd outside the project", (o: string) => `cd ${o}/sibling && echo hi`, /sibling/],
    ["redirection outside the project", (o: string) => `echo x > ${o}/written.txt`, /written\.txt/],
    ["append redirection outside the project", (o: string) => `echo x >> ${o}/written.txt`, /written\.txt/],
    [
      "host checkout virtualenv by path",
      (o: string) => `${o}/host/.venv/bin/python -c 'print(1)'`,
      /host\/\.venv\/bin\/python/,
    ],
    ["host checkout virtualenv after cd", (o: string) => `cd ${o}/host && .venv/bin/python -V`, /host/],
  ])("refuses %s and names the path", async (_name, command, pathPattern) => {
    const { outside, project } = await fixture()
    await using _outside = outside
    await using _project = project
    await provideInstance(project.path, async () => {
      const bash = await initTool(BashTool)
      const { ctx } = context(rules({ "*": "deny" }))
      const run = bash.execute({ command: command(outside.path), description: "Touch an outside path" }, ctx)
      await expect(run).rejects.toThrow(/external_directory is denied/)
      if (pathPattern) await expect(run).rejects.toThrow(pathPattern)
      else await expect(run).rejects.toThrow(os.homedir().split(path.sep).filter(Boolean).at(-1)!)
    })
    // Nothing ran: no write landed outside and the host interpreter never executed.
    expect(await Bun.file(path.join(outside.path, "written.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(outside.path, "host", "ran.txt")).exists()).toBe(false)
  })

  test("refuses an outside workdir and names it", async () => {
    const { outside, project } = await fixture()
    await using _outside = outside
    await using _project = project
    await provideInstance(project.path, async () => {
      const bash = await initTool(BashTool)
      const { ctx } = context(rules({ "*": "deny" }))
      await expect(
        bash.execute({ command: "echo hi", workdir: outside.path, description: "Run outside" }, ctx),
      ).rejects.toThrow(new RegExp(`external_directory is denied.*${path.basename(outside.path)}`))
    })
  })

  test("allows paths inside the project, URLs, option values, programs, devices and heredoc bodies", async () => {
    const { outside, project } = await fixture()
    await using _outside = outside
    await using _project = project
    await provideInstance(project.path, async () => {
      const bash = await initTool(BashTool)
      const { ctx, requests } = context(rules({ "*": "deny" }))
      for (const command of [
        "cat inside.txt",
        `cat ${project.path}/inside.txt`,
        "echo x > ./out.txt && cat out.txt",
        "mkdir -p nested/deeper && ls nested",
        "echo https://example.com/a/b",
        "awk '/inside/ {print}' inside.txt",
        "sed -e 's/inside/x/' inside.txt",
        "echo hi 2>/dev/null",
        "echo hi > /dev/null",
        "/usr/bin/env echo hi",
        `cat <<'EOF'\n/etc/hosts\n${outside.path}/sibling/output.md\nEOF`,
      ]) {
        const result = await bash.execute({ command, description: "Stay inside" }, ctx)
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.external_paths).toBeUndefined()
      }
      expect(requests.filter((request) => request.permission === "external_directory")).toEqual([])
    })
  })

  test("allows a directory the config allows and records it in metadata", async () => {
    const { outside, project } = await fixture()
    await using _outside = outside
    await using _project = project
    await provideInstance(project.path, async () => {
      const bash = await initTool(BashTool)
      const allowed = path.join(outside.path, "sibling")
      const { ctx } = context(rules({ "*": "deny", [path.join(allowed, "*")]: "allow" }))
      const result = await bash.execute(
        { command: `echo x > ${allowed}/scratch.txt && cat ${allowed}/output.md`, description: "Use scratch dir" },
        ctx,
      )
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toBe("private content")
      expect(result.metadata.external_paths).toEqual(
        expect.arrayContaining([path.join(allowed, "scratch.txt"), path.join(allowed, "output.md")]),
      )
      expect(await Bun.file(path.join(allowed, "scratch.txt")).text()).toBe("x\n")
    })
  })

  test("allows the tool-output directory the file tools allow", async () => {
    await using project = await tmpdir({ git: true })
    await fs.mkdir(Truncate.DIR, { recursive: true })
    const target = path.join(Truncate.DIR, `bash-guard-${Math.random().toString(36).slice(2)}.txt`)
    await Bun.write(target, "saved output")
    try {
      await provideInstance(project.path, async () => {
        const bash = await initTool(BashTool)
        const { ctx } = context(rules({ "*": "deny" }))
        const result = await bash.execute({ command: `cat ${target}`, description: "Read saved output" }, ctx)
        expect(result.output).toBe("saved output")
        expect(result.metadata.external_paths).toEqual([await fs.realpath(target)])
      })
    } finally {
      await fs.rm(target, { force: true })
    }
  })

  test("a directory configured as ask goes through the normal permission prompt", async () => {
    const { outside, project } = await fixture()
    await using _outside = outside
    await using _project = project
    await provideInstance(project.path, async () => {
      const bash = await initTool(BashTool)
      const askDir = path.join(outside.path, "sibling")
      const { ctx, prompts } = context(rules({ "*": "deny", [path.join(askDir, "*")]: "ask" }))
      const result = await bash.execute({ command: `head -n 1 ${askDir}/output.md`, description: "Read" }, ctx)
      expect(result.output).toBe("private content")
      expect(prompts.map((request) => request.permission)).toEqual(["external_directory"])
      expect(prompts[0].patterns).toContain(path.join(askDir, "*"))
    })
  })
})

// Review cases: each form ran (or was wrongly refused) under `external_directory: deny` before.
async function v2fixture() {
  const outside = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "s.txt"), "outside secret")
      await fs.mkdir(path.join(dir, "dir with space"))
      await Bun.write(path.join(dir, "dir with space", "s.txt"), "outside secret")
      const py = path.join(dir, "py")
      await Bun.write(py, `#!/bin/sh\necho ran > "${path.join(dir, "ran.txt")}"\necho host-python\n`)
      await fs.chmod(py, 0o755)
    },
  })
  const project = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "inside.txt"), "inside content")
      await Bun.write(path.join(dir, "run.sh"), "#!/bin/sh\necho in-project-script\n")
      await fs.chmod(path.join(dir, "run.sh"), 0o755)
      await fs.mkdir(path.join(dir, "a", "b"), { recursive: true })
    },
  })
  await fs.symlink(outside.path, path.join(project.path, "lnk"))
  return { outside, project }
}

// A top-level name that does not exist, so a missing first path segment is exercised.
const MISSING_TOP = `altimate-guard-missing-${Math.random().toString(36).slice(2)}`

// Files the refused commands would have created outside the project.
async function leaked(outside: string, project: string) {
  const parent = path.dirname(project)
  const base = path.basename(project)
  const files = [
    path.join(outside, "w"),
    path.join(outside, "ran.txt"),
    path.join(parent, `${base}-marker`),
    path.join(parent, `${base}-m`),
  ]
  const present = await Promise.all(files.map((file) => Bun.file(file).exists()))
  return files.filter((_, i) => present[i])
}

describe("tool.bash external_directory: deny (review cases)", () => {
  test.each([
    // redirection targets resolve in the directory of the command that owns them
    ["redirect after cd", (o: string, p: string) => `cd ../.. && echo pwn > ../${path.basename(p)}-marker`, "a/b"],
    // every word of a redirection destination is an argument at run time
    ["word after a redirection", (o: string) => `cat > stolen.txt ${o}/s.txt`, undefined],
    ["word after a /dev/null redirection", (o: string) => `head > /dev/null ${o}/s.txt`, undefined],
    // assignment values
    ["program from an assignment", (o: string) => `PY=${o}/py; $PY`, undefined],
    ["PATH entry from an export", (o: string) => `export PATH=${o}:$PATH; py`, undefined],
    ["file from an export", (o: string) => `export FOO=${o}/s.txt; head "$FOO"`, undefined],
    ["prefix assignment", (o: string) => `OUT=${o}/w sh -c 'echo x > "$OUT"'`, undefined],
    // option values
    ["--opt=value", (o: string) => `sort --output=${o}/w inside.txt`, undefined],
    ["attached short option", (o: string) => `sort -o${o}/w inside.txt`, undefined],
    ["key=value write", (o: string) => `dd if=inside.txt of=${o}/w`, undefined],
    ["key=value read", (o: string) => `dd if=${o}/s.txt`, undefined],
    ["--flag=value on echo", () => `echo --out=/etc/hosts`, undefined],
    // literal nested shell strings
    ["bash -c", (o: string) => `bash -c 'cat ${o}/s.txt'`, undefined],
    ["sh -c", (o: string) => `sh -c "cat ${o}/s.txt"`, undefined],
    ["eval", (o: string) => `eval "cat ${o}/s.txt"`, undefined],
    ["wrapped shell", (o: string) => `env bash -lc 'cat ${o}/s.txt'`, undefined],
    // symlinks inside the project that point outside
    ["read through an in-project symlink", () => `head lnk/s.txt`, undefined],
    ["read through ./symlink", () => `head ./lnk/s.txt`, undefined],
    ["write through an in-project symlink", () => `echo x > lnk/w`, undefined],
    // pushd moves the directory like cd
    ["pushd then a relative write", (o: string, p: string) => `pushd ../.. && cp inside.txt ../${path.basename(p)}-m`, "a/b"],
    // words outside simple commands
    ["for loop values", (o: string) => `for f in ${o}/s.txt; do head "$f"; done`, undefined],
    ["[[ test ]]", (o: string) => `[[ -f ${o}/s.txt ]]`, undefined],
    ["[ test ]", (o: string) => `[ -f ${o}/s.txt ]`, undefined],
    ["case word", (o: string) => `case ${o}/s.txt in *) echo y ;; esac`, undefined],
    // other literal spellings
    ["ANSI-C quoted argument", (o: string) => `head $'${o}/s.txt'`, undefined],
    ["ANSI-C quoted program", (o: string) => `$'${o}/py'`, undefined],
    ["another user's home", () => `head ~root/x`, undefined],
    // redirection operators and quoting
    ["stderr redirection", (o: string) => `cat inside.txt 2> ${o}/w`, undefined],
    ["&> redirection", (o: string) => `echo x &> ${o}/w`, undefined],
    ["input redirection", (o: string) => `cat < ${o}/s.txt`, undefined],
    ["read-write redirection", (o: string) => `cat <> ${o}/s.txt`, undefined],
    ["quoted path with spaces", (o: string) => `cat "${o}/dir with space/s.txt"`, undefined],
    // paths that do not exist yet are still outside the project
    ["touch a missing file", (o: string) => `touch ${o}/w`, undefined],
    ["touch a missing top-level file", () => `touch /${MISSING_TOP}`, undefined],
    ["mkdir a missing top-level directory", () => `mkdir /${MISSING_TOP}`, undefined],
    ["mkdir -p under an existing directory", (o: string) => `mkdir -p ${o}/w/x/y`, undefined],
    ["mkdir -p under a missing top-level directory", () => `mkdir -p /${MISSING_TOP}/x/y`, undefined],
    // after a cd that may fail, `;`, `||` and newline continuations can still run in the old directory
    ["read after a failing cd and ;", (o: string) => `cd missing; head ../${path.basename(o)}/s.txt`, undefined],
    ["read after a failing cd and ||", (o: string) => `cd missing || head ../${path.basename(o)}/s.txt`, undefined],
    ["read after a failing cd and newline", (o: string) => `cd missing\nhead ../${path.basename(o)}/s.txt`, undefined],
    [
      "read after a failing cd and ; in a group",
      (o: string) => `{ cd missing; head ../${path.basename(o)}/s.txt; }`,
      undefined,
    ],
    [
      "read after a failing cd and ; in a subshell",
      (o: string) => `(cd missing; head ../${path.basename(o)}/s.txt)`,
      undefined,
    ],
    [
      "write after a failing cd in an && chain then ;",
      (o: string, p: string) => `true && cd missing; echo x > ../${path.basename(p)}-marker`,
      undefined,
    ],
    ["read after a failing pushd and ;", (o: string) => `pushd missing; head ../${path.basename(o)}/s.txt`, undefined],
  ])("refuses %s", async (_name, command, workdir) => {
    const { outside, project } = await v2fixture()
    await using _outside = outside
    await using _project = project
    await provideInstance(project.path, async () => {
      const bash = await initTool(BashTool)
      const { ctx } = context(rules({ "*": "deny" }))
      await expect(
        bash.execute(
          {
            command: command(outside.path, project.path),
            ...(workdir && { workdir: path.join(project.path, workdir) }),
            description: "Escape attempt",
          },
          ctx,
        ),
      ).rejects.toThrow(/external_directory is denied/)
    })
    expect(await leaked(outside.path, project.path)).toEqual([])
  })

  test("allows in-project commands that reach parents after cd, regex operands, devices and system binaries", async () => {
    const { outside, project } = await v2fixture()
    await using _outside = outside
    await using _project = project
    await provideInstance(project.path, async () => {
      const bash = await initTool(BashTool)
      const { ctx } = context(rules({ "*": "deny" }))
      for (const [command, expected] of [
        ["cd a && head -c 3 ../inside.txt", "ins"],
        ["cd a && sh ../run.sh", "in-project-script"],
        ["(cd a && head -c 3 ../inside.txt)", "ins"],
        ["cd a && ../run.sh", "in-project-script"],
        ["cd a && echo ok > ../r.txt && cat ../r.txt", "ok"],
        ["cd a/b && cd .. && head -c 3 ../inside.txt", "ins"],
        ["pushd a > /dev/null && head -c 3 ../inside.txt", "ins"],
        ["awk '/var/ {print}' inside.txt", ""],
        ["sed -n '/usr/p' inside.txt", ""],
        ["grep -c /etc/ inside.txt || true", "0"],
        ["grep -e /usr/ inside.txt || true", ""],
        ["cat /dev/null", ""],
        ["cat /dev/null > f.txt && cat f.txt", ""],
        ["ls /dev/null", "/dev/null"],
        ["nohup /usr/bin/true 2>/dev/null", ""],
        ["/usr/bin/env /usr/bin/true", ""],
        ["command -v /usr/bin/true", "/usr/bin/true"],
        ["bash -c 'head -c 3 inside.txt'", "ins"],
        [`head -c 3 $'inside.txt'`, "ins"],
        ["for f in inside.txt; do head -c 3 $f; done", "ins"],
        ["git log --format=%H/%s -n 1 || true", undefined],
        ["echo https://example.com/a/b", "https://example.com/a/b"],
        // text whose first segment does not exist names no real location
        ["echo foo/bar", "foo/bar"],
        [`echo /${MISSING_TOP}/sub`, `/${MISSING_TOP}/sub`],
      ] as const) {
        const result = await bash.execute({ command, description: "Stay inside" }, ctx)
        if (expected !== undefined) expect([command, result.output.trim()]).toEqual([command, expected])
        expect([command, result.metadata.external_paths]).toEqual([command, undefined])
      }
    })
  })

  test("a not-yet-created directory that the config allows is not judged by its parent", async () => {
    const { outside, project } = await v2fixture()
    await using _outside = outside
    await using _project = project
    await provideInstance(project.path, async () => {
      const bash = await initTool(BashTool)
      const allowed = path.join(outside.path, "later")
      const { ctx } = context(rules({ "*": "deny", [path.join(allowed, "*")]: "allow" }))
      const result = await bash.execute({ command: `ls ${allowed} || true`, description: "List" }, ctx)
      expect(result.metadata.external_paths).toEqual([path.join(await fs.realpath(outside.path), "later")])
    })
  })

  test("the first segment of a Windows path is taken after the drive root", () => {
    expect(BashModule.firstSegmentPath("C:\\Users\\x\\f", path.win32)).toBe("C:\\Users")
    expect(BashModule.firstSegmentPath("\\\\server\\share\\dir\\f", path.win32)).toBe("\\\\server\\share\\dir")
    expect(BashModule.firstSegmentPath("/etc/hosts", path.posix)).toBe("/etc")
    expect(BashModule.firstSegmentPath("/", path.posix)).toBeUndefined()
  })
})

// Without `external_directory: deny` (unset, the default "ask", or "allow") the tool behaves
// exactly as before: the same permission requests, the same outputs and the same metadata keys.
describe("tool.bash without external_directory: deny", () => {
  for (const [label, ruleset] of [
    ["no ruleset", undefined],
    ["default ask", rules(undefined)],
    ["allow", rules({ "*": "allow" })],
  ] as const) {
    test(`keeps today's behaviour (${label})`, async () => {
      const { outside, project } = await fixture()
      await using _outside = outside
      await using _project = project
      await provideInstance(project.path, async () => {
        const bash = await initTool(BashTool)
        const sibling = path.join(outside.path, "sibling")
        const observed: Array<{ command: string; output: string; keys: string[]; external: string[][] }> = []
        for (const command of [
          `head -n 1 ${sibling}/output.md`,
          `echo x > ${outside.path}/written.txt && cat ${outside.path}/written.txt`,
          `${outside.path}/host/.venv/bin/python`,
          `cat ${sibling}/output.md`,
          "cat inside.txt",
          "cat /dev/null",
          `sort -o${outside.path}/w.txt inside.txt && cat ${outside.path}/w.txt`,
        ]) {
          const { ctx, requests } = context(ruleset)
          const result = await bash.execute({ command, description: "Fixed command" }, ctx)
          observed.push({
            command: command.replaceAll(outside.path, "<outside>"),
            output: result.output.trim(),
            keys: Object.keys(result.metadata).sort(),
            external: requests
              .filter((request) => request.permission === "external_directory")
              .map((request) => request.patterns.map((pattern) => pattern.replaceAll(outside.path, "<outside>"))),
          })
        }
        const keys = ["description", "exit", "exit_code", "output", "truncated"]
        expect(observed).toEqual([
          { command: "head -n 1 <outside>/sibling/output.md", output: "private content", keys, external: [] },
          {
            command: "echo x > <outside>/written.txt && cat <outside>/written.txt",
            output: "x",
            keys,
            external: [["<outside>/*"]],
          },
          { command: "<outside>/host/.venv/bin/python", output: "host-python", keys, external: [] },
          {
            command: "cat <outside>/sibling/output.md",
            output: "private content",
            keys,
            external: [["<outside>/sibling/*"]],
          },
          { command: "cat inside.txt", output: "inside content", keys, external: [] },
          { command: "cat /dev/null", output: "", keys, external: [["/dev/*"]] },
          {
            command: "sort -o<outside>/w.txt inside.txt && cat <outside>/w.txt",
            output: "inside content",
            keys,
            external: [["<outside>/*"]],
          },
        ])
      })
    })
  }
})
// altimate_change end
