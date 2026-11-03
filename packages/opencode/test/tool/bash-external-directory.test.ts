// altimate_change start — the bash tool applies a configured `external_directory: deny` to every path a command names
import { describe, expect, test } from "bun:test"
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
        "echo --out=/etc/hosts",
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
        ])
      })
    })
  }
})
// altimate_change end
