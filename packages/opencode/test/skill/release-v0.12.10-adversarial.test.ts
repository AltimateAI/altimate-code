/**
 * Adversarial coverage for the v0.12.10 patch payload (v0.12.9..HEAD, 4 commits), on top of the
 * suites each PR shipped with:
 *
 *   1. #1669 "workspace rules state lives outside the project": the state file moves to the person's
 *      state directory, keyed by the project's real path (`altimate/rules/state-path.ts`,
 *      `altimate/rules/store.ts`). `test/altimate/rules/*.test.ts` and `test/altimate/learn/*.test.ts`
 *      cover pull, vouching and delivery.
 *   2. #1670 "a project linked by path can gain its git remote": `addsRemoteToLink` and the
 *      `learn status` rules line (`altimate/workspace/api-client.ts`, `cli/cmd/learn.ts`).
 *      `test/cli/workspace-command.test.ts` and `test/altimate/plugin/workspace.test.ts` cover the flows.
 *   3. #1687 "`tool` commands no longer lose a big answer on a pipe" (`cli/cmd/tool.ts`, `writeAll`).
 *      `test/altimate/tool-cli/cli.test.ts` covers the delayed reader and the exit codes.
 *   4. #1688 "retry a failed session title on later turns and report why it failed"
 *      (`session/prompt.ts`, `altimate/telemetry/index.ts`). `test/session/title-retry.test.ts` covers
 *      the retry, the cap, the unlisted small model and the in-flight guard through the prompt loop.
 *
 * This file adds the boundary classes those suites do not reach:
 *
 *   - The state path with hostile project roots: traversal segments, separators, unicode, very long
 *     paths and a path that differs only in case or in a trailing slash must all land as one hashed file
 *     name directly under the state directory, never anywhere else. A symlinked root resolves to the real
 *     root's file. The prompt path's "may this project have rules" check keys on that file.
 *   - `addsRemoteToLink` as a truth table, including empty-string remotes, and the `learn status` line
 *     for every gate outcome with a reason that carries terminal control sequences.
 *   - Source guards that pin the shapes the fixes depend on, so a later edit cannot quietly undo them:
 *     no `console.log` answer path left in `tool.ts`, EPIPE and EAGAIN handled in `writeAll`; the title
 *     attempt cap, the in-flight set, the placeholder re-check before `setTitle`, the identifier-only
 *     `error_type`, and the telemetry event in the catalogue and the docs.
 */
import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { addsRemoteToLink, ADDING_REMOTE_MESSAGE } from "../../src/altimate/workspace/api-client"
import { rulesNotSyncedLine } from "../../src/cli/cmd/learn"

// The state directory is redirected before any module that reads `Global.Path.state` loads, so this
// file never touches the developer's real state directory.
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "release-v0.12.10-state-"))
const previousStateHome = process.env.OPENCODE_TEST_STATE_HOME
process.env.OPENCODE_TEST_STATE_HOME = stateHome
afterAll(() => {
  if (previousStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
  else process.env.OPENCODE_TEST_STATE_HOME = previousStateHome
  fs.rmSync(stateHome, { recursive: true, force: true })
})

const { stateFileOf } = await import("../../src/altimate/rules/state-path")
const { Global } = await import("../../src/global")

const src = (rel: string) => fs.readFileSync(path.join(import.meta.dir, "../../", rel), "utf8")
const HEX64 = /^[0-9a-f]{64}\.json$/

// ---------------------------------------------------------------------------------------------
// #1669 — the state file lives under the state directory whatever the project root looks like
// ---------------------------------------------------------------------------------------------
describe("workspace rules state path (#1669)", () => {
  const stateDir = () => path.join(Global.Path.state, "workspace-rules")

  test("every root hashes to one 64-hex file directly under <state>/workspace-rules", () => {
    const roots = [
      "/tmp/project",
      "/tmp/project/../other",
      "/tmp/pro ject with spaces",
      "/tmp/ünïcödé/项目",
      "/tmp/" + "x".repeat(4000),
      "C:\\Users\\someone\\project",
      "/tmp/project;rm -rf ~",
      "/tmp/project\n/etc/passwd",
      "",
    ]
    for (const root of roots) {
      const file = stateFileOf(root)
      expect(path.dirname(file)).toBe(stateDir())
      expect(path.basename(file)).toMatch(HEX64)
    }
  })

  test("the hash is deterministic and distinct for roots that differ only slightly", () => {
    const a = stateFileOf("/tmp/project")
    expect(stateFileOf("/tmp/project")).toBe(a)
    expect(stateFileOf("/tmp/project/")).not.toBe(a)
    expect(stateFileOf("/tmp/Project")).not.toBe(a)
    expect(stateFileOf("/tmp/project2")).not.toBe(a)
  })

  test("the state directory follows OPENCODE_TEST_STATE_HOME at call time, not import time", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "release-v0.12.10-state2-"))
    try {
      process.env.OPENCODE_TEST_STATE_HOME = other
      expect(path.dirname(stateFileOf("/tmp/project"))).toBe(path.join(other, "workspace-rules"))
    } finally {
      process.env.OPENCODE_TEST_STATE_HOME = stateHome
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")(
    "RulesStore.stateFile resolves a symlinked root to the real root's file",
    async () => {
      const { RulesStore } = await import("../../src/altimate/rules/store")
      const real = fs.mkdtempSync(path.join(os.tmpdir(), "release-v0.12.10-root-"))
      const link = real + "-link"
      fs.symlinkSync(real, link)
      try {
        const viaReal = await RulesStore.stateFile(real)
        const viaLink = await RulesStore.stateFile(link)
        expect(viaLink).toBe(viaReal)
        expect(viaReal).toBe(stateFileOf(fs.realpathSync(real)))
      } finally {
        fs.rmSync(link, { force: true })
        fs.rmSync(real, { recursive: true, force: true })
      }
    },
  )

  test("a root that no longer exists still gets a file name instead of throwing", async () => {
    const { RulesStore } = await import("../../src/altimate/rules/store")
    const gone = path.join(os.tmpdir(), "release-v0.12.10-does-not-exist-" + process.pid)
    const file = await RulesStore.stateFile(gone)
    expect(path.dirname(file)).toBe(stateDir())
    expect(path.basename(file)).toMatch(HEX64)
  })

  test("the prompt path's rules check keys on the state file, not on anything inside the project", async () => {
    const { mayHaveWorkspaceRules } = await import("../../src/session/prompt")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-v0.12.10-proj-"))
    try {
      // A planted in-project rules.json (the 0.12.9 location) no longer counts.
      const planted = path.join(root, ".altimate-code", "learn", "workspace-rules")
      fs.mkdirSync(planted, { recursive: true })
      fs.writeFileSync(path.join(planted, "rules.json"), JSON.stringify({ version: 1, outbox: [{ text: "planted" }] }))
      expect(mayHaveWorkspaceRules(root, root)).toBe(false)
      // The person's own state file does.
      const file = stateFileOf(fs.realpathSync(root))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, "{}")
      expect(mayHaveWorkspaceRules(root, root)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("source guard: the old in-project rules.json path is not read anywhere in the rules code", () => {
    for (const rel of [
      "src/altimate/rules/store.ts",
      "src/altimate/rules/sync.ts",
      "src/altimate/learn/delivery.ts",
      "src/session/prompt.ts",
    ]) {
      const text = src(rel)
      expect(text).not.toMatch(/["'`]rules\.json["'`]/)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// #1670 — adding a remote to a path link, and the `learn status` rules line
// ---------------------------------------------------------------------------------------------
describe("addsRemoteToLink and the learn status line (#1670)", () => {
  const lookup = (matchedBy: "path" | "remote", repo_remote: string | null | undefined) =>
    ({
      matchedBy,
      binding: { repo_remote } as any,
      datamate: { id: 1, name: "ws" } as any,
    }) as any

  test("true only for a path match, a project remote, and a link without one", () => {
    expect(addsRemoteToLink({ repoRemote: "https://x/y.git" }, lookup("path", null))).toBe(true)
    expect(addsRemoteToLink({ repoRemote: "https://x/y.git" }, lookup("path", undefined))).toBe(true)
    expect(addsRemoteToLink({ repoRemote: "https://x/y.git" }, lookup("remote", null))).toBe(false)
    expect(addsRemoteToLink({ repoRemote: "https://x/y.git" }, lookup("path", "https://x/y.git"))).toBe(false)
    expect(addsRemoteToLink({ repoRemote: "https://x/y.git" }, lookup("path", "https://x/other.git"))).toBe(false)
    expect(addsRemoteToLink({}, lookup("path", null))).toBe(false)
    expect(addsRemoteToLink({ repoRemote: "" }, lookup("path", null))).toBe(false)
    expect(addsRemoteToLink({ repoRemote: "" }, lookup("path", ""))).toBe(false)
  })

  test("the message shown when a remote is added is one printable line", () => {
    expect(ADDING_REMOTE_MESSAGE).not.toMatch(/[\u0000-\u001F\u007F]/)
    expect(ADDING_REMOTE_MESSAGE).toContain("git remote")
  })

  test("learn status explains every gate outcome and never prints control sequences", () => {
    expect(rulesNotSyncedLine(undefined)).toContain("learn sync")
    expect(rulesNotSyncedLine({ status: "ready" } as any)).toContain("not synced yet")
    expect(rulesNotSyncedLine({ status: "skipped", code: "not_linked", reason: "x" } as any)).toContain(
      "altimate-code link",
    )
    const hostile = {
      status: "skipped",
      code: "no_remote",
      reason: "needs a remote\u001b]0;pwned\u0007\n\rrun rm -rf \u202e/",
    } as any
    const line = rulesNotSyncedLine(hostile)
    expect(line.startsWith("Workspace rules: off")).toBe(true)
    expect(line).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202e]/)
    expect(line.split("\n")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------
// #1687 — `tool` answers go through writeAll
// ---------------------------------------------------------------------------------------------
describe("tool command output (#1687)", () => {
  const tool = src("src/cli/cmd/tool.ts")

  test("no answer is written with console.log any more", () => {
    // Answers (JSON documents, tool output, instructions) go through writeAll; console.log remains only
    // for the one-line-per-tool listing and the daemon's status lines.
    expect(tool).not.toMatch(/console\.log\(JSON\.stringify\(/)
    expect(tool).not.toMatch(/console\.log\(result\.output\)/)
    expect(tool).not.toMatch(/console\.log\(instructions\)/)
    expect(tool).toMatch(/function writeAll\(/)
    // Every command's answer goes through it: list, context (both modes), schema, run (both modes).
    expect(tool.match(/writeAll\(/g)!.length).toBeGreaterThanOrEqual(7)
  })

  test("writeAll handles a departed reader and a full pipe, and lets other write errors propagate", () => {
    const body = tool.slice(tool.indexOf("function writeAll("))
    expect(body).toMatch(/code === "EPIPE"\) return/)
    expect(body).toMatch(/code !== "EAGAIN"\) throw error/)
    expect(body).toMatch(/writeSync\(1, bytes, at\)/)
    // A reader that stops draining the pipe no longer hangs the command forever.
    expect(body).toMatch(/performance\.now\(\) - progressAt > WRITE_STALL_MS/)
    // A zero-byte write counts as no progress, not as success.
    expect(body).toMatch(/if \(wrote > 0\)/)
    expect(tool).toMatch(/const WRITE_STALL_MS = 60_000/)
  })

  test("the docs tell callers to read stdout while the command runs", () => {
    expect(src("../../docs/docs/usage/tool.md")).toMatch(/read stdout while/i)
  })
})

// ---------------------------------------------------------------------------------------------
// #1688 — title retry: the shapes the behaviour depends on
// ---------------------------------------------------------------------------------------------
describe("session title retry (#1688)", () => {
  const prompt = src("src/session/prompt.ts")
  const title = prompt.slice(
    prompt.indexOf("const TITLE_MAX_ATTEMPTS"),
    prompt.indexOf("return Session.setTitle({ sessionID: input.session.id, title })"),
  )

  test("the retry is bounded, one request per session is in flight, and the lookup is inside the try", () => {
    expect(title).toMatch(/const TITLE_MAX_ATTEMPTS = 5/)
    expect(title).toMatch(/if \(attempt > TITLE_MAX_ATTEMPTS\) return/)
    expect(title).toMatch(/if \(titleInFlight\.has\(input\.session\.id\)\) return/)
    expect(title).toMatch(/finally \{\s*titleInFlight\.delete\(input\.session\.id\)/)
    // The model lookup happens after `try {`, so a small_model the provider does not list is reported.
    expect(title.indexOf("try {")).toBeLessThan(title.indexOf("Provider.getSmallModel(input.providerID)"))
  })

  test("a generated title only replaces the placeholder, and is left for a retry when the session cannot be read", () => {
    expect(title).toMatch(/const current = await Session\.get\(input\.session\.id\)\.catch\(\(\) => undefined\)/)
    expect(title).toMatch(/if \(!current \|\| !Session\.isDefaultTitle\(current\.title\)\) return/)
  })

  test("the failure report never carries the raw error object, and error_type is identifier-shaped", () => {
    expect(title).not.toMatch(/log\.error\("failed to generate title", \{\s*error:/)
    expect(prompt).toMatch(/\^\[A-Za-z0-9_\.:-\]\{1,64\}\$/)
    expect(title).toMatch(/error_type: described\.name/)
    expect(title).toMatch(/error_class: Telemetry\.classifyError\(described\.message\)/)
    expect(title).not.toMatch(/error_message/)
  })

  test("the telemetry event is in the union, the completeness list and the public catalogue", () => {
    const telemetry = src("src/altimate/telemetry/index.ts")
    const event = telemetry.slice(telemetry.indexOf('type: "title_generation_failed"'))
    expect(event).toMatch(/attempt: number/)
    expect(event).toMatch(/error_type: string/)
    expect(event).toMatch(/error_class: string/)
    expect(event).toMatch(/http_status\?: number/)
    expect(src("test/telemetry/telemetry.test.ts")).toContain('"title_generation_failed"')
    const docs = src("../../docs/docs/reference/telemetry.md")
    expect(docs).toMatch(/\| `title_generation_failed` \|.*No message text/)
    expect(docs).toMatch(/retries stop after the fifth user message/)
  })

  test("the models page says what small_model drives and that compaction is not among them", () => {
    const models = src("../../docs/docs/configure/models.md")
    const paragraph = models.split("\n").find((line) => line.startsWith("`small_model` handles"))!
    expect(paragraph).toContain("session title")
    expect(paragraph).not.toContain("compaction")
    expect(paragraph).toContain("first five messages")
  })
})
