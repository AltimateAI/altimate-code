/**
 * Adversarial coverage for the v0.12.8 release payload (v0.12.7..HEAD): the `run` stdin wait, quoted `run`
 * prompt arguments, the uninstall removal command, the telemetry error template, the plan-skip fail-closed
 * guards, permission aliases, the answer_commit conjunction check, the unsent-memory exit notice and the
 * schema value profile.
 *
 * Targets the exported pure helpers with hostile inputs: empty/null/undefined, boundary numbers, type
 * confusion, shell metacharacters, prototype-pollution keys and error propagation. No timers beyond a
 * never-settling promise raced against a 1ms timeout, no network, no module mocks.
 */
import { describe, expect, test } from "bun:test"
import { readRunStdin, stdinWaitMs, STDIN_WAIT_MS, type StdinSource } from "../../src/altimate/cli/run-stdin"
import { joinRunMessage } from "../../src/cli/cmd/run"
import { removeFileCommand } from "../../src/cli/cmd/uninstall"
import { templateErrorMessage, describeToolError } from "../../src/altimate/telemetry/error-detail"
import {
  applyPolicySkipGuard,
  applySemanticsSkipGuard,
  POLICY_NOT_EVALUATED_MESSAGE,
  SEMANTICS_SKIPPED_MESSAGE,
} from "../../src/altimate/native/altimate-core"
import { evaluate, evaluateRequest, evaluateRequestPatterns } from "../../src/permission/evaluate"
import {
  requestedItems,
  conjunctionRejection,
  CONJUNCTION_REJECTION_MARKER,
} from "../../src/altimate/tools/answer-commit-conjunction"
import {
  unsentMemoryNotice,
  unsentMemoryNoticeAfterRun,
  type UnsentMemoryDeps,
} from "../../src/altimate/cli/unsent-memory"
import { valueShape, profileDocuments } from "../../src/altimate/tools/schema-values"

const enc = new TextEncoder()

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]))
      else controller.close()
    },
  })
}

function source(opts: {
  file?: boolean
  socket?: boolean
  all?: string | Error
  stream?: () => ReadableStream<Uint8Array>
}): StdinSource & { readAllCalls: number; streamCalls: number } {
  const s = {
    readAllCalls: 0,
    streamCalls: 0,
    isFile: () => opts.file ?? false,
    isSocket: () => opts.socket ?? false,
    readAll: async () => {
      s.readAllCalls++
      if (opts.all instanceof Error) throw opts.all
      return opts.all ?? ""
    },
    stream: () => {
      s.streamCalls++
      return opts.stream!()
    },
  }
  return s
}

describe("v0.12.8 adversarial: stdinWaitMs", () => {
  const wait = (v: string | undefined) => stdinWaitMs({ ALTIMATE_RUN_STDIN_WAIT_MS: v })

  test("unset, empty and whitespace fall back to the default", () => {
    expect(stdinWaitMs({})).toBe(STDIN_WAIT_MS)
    expect(wait(undefined)).toBe(STDIN_WAIT_MS)
    expect(wait("")).toBe(STDIN_WAIT_MS)
    expect(wait("   \t\n")).toBe(STDIN_WAIT_MS)
  })

  test("negative, NaN, Infinity and non-numeric text fall back to the default", () => {
    for (const v of ["-1", "-0.0001", "NaN", "Infinity", "-Infinity", "abc", "12abc", "1e999", "0x", "--5"]) {
      expect(wait(v)).toBe(STDIN_WAIT_MS)
    }
  })

  test("zero means wait for EOF and is returned as 0", () => {
    expect(wait("0")).toBe(0)
    expect(wait(" 0 ")).toBe(0)
  })

  test("valid values pass through, trimmed", () => {
    expect(wait("1")).toBe(1)
    expect(wait("  250 ")).toBe(250)
    expect(wait("1.5")).toBe(1.5)
  })

  test("values above the timer limit are clamped, not wrapped", () => {
    expect(wait("2147483647")).toBe(2147483647)
    expect(wait("2147483648")).toBe(2147483647)
    expect(wait("99999999999999")).toBe(2147483647)
  })

  test("hex and exponent spellings parse as numbers, never as code", () => {
    expect(wait("0x10")).toBe(16)
    expect(wait("1e3")).toBe(1000)
    expect(wait("1;process.exit(1)")).toBe(STDIN_WAIT_MS)
  })
})

describe("v0.12.8 adversarial: readRunStdin", () => {
  test("unbounded socket is read to EOF without touching the stream", async () => {
    const s = source({ socket: true, all: "whole prompt" })
    expect(await readRunStdin(s, 5, false)).toEqual({ text: "whole prompt", timedOut: false })
    expect(s.streamCalls).toBe(0)
  })

  test("waitMs 0 and negative read to EOF", async () => {
    for (const ms of [0, -1, -Infinity]) {
      const s = source({ socket: true, all: "x" })
      expect(await readRunStdin(s, ms)).toEqual({ text: "x", timedOut: false })
      expect(s.streamCalls).toBe(0)
    }
  })

  test("a file is read to EOF even when it also claims to be a socket", async () => {
    const s = source({ file: true, socket: true, all: "from file" })
    expect(await readRunStdin(s, 5)).toEqual({ text: "from file", timedOut: false })
    expect(s.streamCalls).toBe(0)
  })

  test("a FIFO (neither file nor socket) is read to EOF", async () => {
    const s = source({ all: "piped" })
    expect(await readRunStdin(s, 5)).toEqual({ text: "piped", timedOut: false })
    expect(s.streamCalls).toBe(0)
  })

  test("empty file returns empty text, not a timeout", async () => {
    expect(await readRunStdin(source({ file: true, all: "" }), 5)).toEqual({ text: "", timedOut: false })
  })

  test("readAll errors propagate", async () => {
    const s = source({ file: true, all: new Error("EIO") })
    await expect(readRunStdin(s, 5)).rejects.toThrow("EIO")
  })

  test("a socket that sends data returns all chunks, including split multibyte characters", async () => {
    const bytes = enc.encode("héllo 世界")
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          // split inside the two-byte "é" and inside a three-byte character
          c.enqueue(bytes.slice(0, 2))
          c.enqueue(bytes.slice(2, 9))
          c.enqueue(bytes.slice(9))
          c.close()
        },
      })
    const result = await readRunStdin(source({ socket: true, stream }), 60_000)
    expect(result).toEqual({ text: "héllo 世界", timedOut: false })
  })

  test("a socket that closes without writing is empty, not timed out", async () => {
    const result = await readRunStdin(source({ socket: true, stream: () => streamOf([]) }), 60_000)
    expect(result).toEqual({ text: "", timedOut: false })
  })

  test("a socket that never writes times out with empty text and releases the stream", async () => {
    let cancelled = false
    const stream = () =>
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel() {
          cancelled = true
        },
      })
    const result = await readRunStdin(source({ socket: true, stream }), 1)
    expect(result).toEqual({ text: "", timedOut: true })
    expect(cancelled).toBe(true)
  })

  test("a stream read error propagates", async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error("socket reset"))
        },
      })
    await expect(readRunStdin(source({ socket: true, stream }), 60_000)).rejects.toThrow("socket reset")
  })

  test("an error after the first chunk propagates instead of returning partial text", async () => {
    let n = 0
    const stream = () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ === 0) c.enqueue(enc.encode("partial"))
          else c.error(new Error("mid-stream failure"))
        },
      })
    await expect(readRunStdin(source({ socket: true, stream }), 60_000)).rejects.toThrow("mid-stream failure")
  })
})

describe("v0.12.8 adversarial: joinRunMessage", () => {
  test("plain mode joins verbatim, with no quoting", () => {
    expect(joinRunMessage(["a b", 'c"d'], false)).toBe('a b c"d')
    expect(joinRunMessage([], false)).toBe("")
    expect(joinRunMessage([""], false)).toBe("")
    expect(joinRunMessage(["", ""], false)).toBe(" ")
  })

  test("command mode quotes only arguments containing a space", () => {
    expect(joinRunMessage(["plain", "two words"], true)).toBe('plain "two words"')
  })

  test("command mode escapes embedded double quotes inside a quoted argument", () => {
    expect(joinRunMessage(['say "hi" now'], true)).toBe('"say \\"hi\\" now"')
  })

  test("command mode leaves a quote-bearing argument without spaces untouched", () => {
    expect(joinRunMessage(['a"b'], true)).toBe('a"b')
  })

  test("command mode keeps $1, backticks and single quotes literal", () => {
    expect(joinRunMessage(["$1", "`id`", "it's here"], true)).toBe("$1 `id` \"it's here\"")
  })

  test("command mode on empty input and empty strings", () => {
    expect(joinRunMessage([], true)).toBe("")
    expect(joinRunMessage([""], true)).toBe("")
    expect(joinRunMessage(["", "a b"], true)).toBe(' "a b"')
    expect(joinRunMessage([" "], true)).toBe('" "')
  })

  test("a lone backslash before a quote is not unescaped (documented limitation of the escaper)", () => {
    expect(joinRunMessage(['a \\" b'], true)).toBe('"a \\\\" b"')
  })

  test("newline and tab alone do not trigger quoting", () => {
    expect(joinRunMessage(["a\nb", "c\td"], true)).toBe("a\nb c\td")
  })

  test("prototype keys are plain text", () => {
    expect(joinRunMessage(["__proto__", "constructor"], true)).toBe("__proto__ constructor")
  })
})

describe("v0.12.8 adversarial: removeFileCommand", () => {
  test("linux wraps the path in single quotes, with -f only when forced", () => {
    expect(removeFileCommand("/usr/local/bin/altimate-code", "linux")).toBe("rm '/usr/local/bin/altimate-code'")
    expect(removeFileCommand("/a/b", "linux", true)).toBe("rm -f '/a/b'")
    expect(removeFileCommand("/a/b", "darwin", false)).toBe("rm '/a/b'")
  })

  test("a single quote in the path closes, escapes and reopens the quoting", () => {
    expect(removeFileCommand("/home/o'brien/x", "linux")).toBe("rm '/home/o'\\''brien/x'")
    expect(removeFileCommand("'", "linux")).toBe("rm ''\\'''")
  })

  test("injection attempts stay inside one quoted word", () => {
    const hostile = ["/a; rm -rf ~", "/a $(whoami)", "/a `whoami`", "/a$HOME", "/a && curl x | sh", "/a\nrm -rf ~", "/a | b"]
    for (const p of hostile) {
      const cmd = removeFileCommand(p, "linux")
      expect(cmd).toBe(`rm '${p}'`)
    }
  })

  test("the only way out of the quotes is a quote, and every quote is neutralised", () => {
    const cmd = removeFileCommand("/a'; touch /tmp/pwn; echo '", "linux", true)
    expect(cmd).toBe("rm -f '/a'\\''; touch /tmp/pwn; echo '\\'''")
    // stripping the escaped-quote sequences must leave balanced quotes
    expect((cmd.replaceAll("'\\''", "").match(/'/g) ?? []).length % 2).toBe(0)
  })

  test("spaces and empty path", () => {
    expect(removeFileCommand("/Program Files/x y", "linux")).toBe("rm '/Program Files/x y'")
    expect(removeFileCommand("", "linux")).toBe("rm ''")
  })

  test("win32 uses PowerShell Remove-Item with a literal path and doubles single quotes", () => {
    expect(removeFileCommand("C:\\Users\\me\\altimate-code.exe", "win32")).toBe(
      "Remove-Item -LiteralPath 'C:\\Users\\me\\altimate-code.exe' -Force",
    )
    expect(removeFileCommand("C:\\Users\\o'brien\\x", "win32")).toBe(
      "Remove-Item -LiteralPath 'C:\\Users\\o''brien\\x' -Force",
    )
  })

  test("win32 does not treat $, backtick or semicolon specially and ignores the force flag", () => {
    expect(removeFileCommand("C:\\a$env:X`b;c", "win32")).toBe("Remove-Item -LiteralPath 'C:\\a$env:X`b;c' -Force")
    expect(removeFileCommand("C:\\a", "win32", true)).toBe(removeFileCommand("C:\\a", "win32", false))
    expect(removeFileCommand("C:\\a", "win32")).not.toContain("rm ")
  })

  test("a non-linux, non-win32 platform behaves like POSIX", () => {
    expect(removeFileCommand("/a", "freebsd")).toBe("rm '/a'")
  })
})

describe("v0.12.8 adversarial: templateErrorMessage", () => {
  const SECRETS = [
    "Zq9xKjwPLm4",
    "hunter2ZZtop",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-123456789012-abcdefQQQ",
    "Qwxyz.Rtuvw@zork-corp.example",
    "/Users/zorblax/qvx.csv",
    "frobnitz_ledger",
    "9876543210",
  ]

  function assertClean(out: string) {
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).toMatch(/^[a-z<> ]*$/)
    for (const s of SECRETS) {
      expect(out.toLowerCase()).not.toContain(s.toLowerCase())
      for (const part of s.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 5)) {
        expect(out.toLowerCase()).not.toContain(part.toLowerCase())
      }
    }
  }

  test("empty string yields empty template", () => {
    expect(templateErrorMessage("")).toBe("")
    expect(templateErrorMessage("   ")).toBe("")
    expect(templateErrorMessage("12345 !!! ???")).toBe("")
  })

  test("credentials, emails, paths and identifiers never survive", () => {
    for (const s of SECRETS) {
      assertClean(templateErrorMessage(`Failed to connect with token ${s}: connection refused`))
    }
    assertClean(templateErrorMessage(`password=${SECRETS[1]} user=${SECRETS[4]} host=${SECRETS[5]}`))
  })

  test("SQL text and quoted values are replaced", () => {
    const out = templateErrorMessage(`syntax error near "SELECT frobnitz_ledger FROM zorblax WHERE ssn = '123-45-6789'"`)
    expect(out).not.toContain("frobnitz")
    expect(out).not.toContain("zorblax")
    expect(out).not.toContain("123")
    expect(out).toMatch(/^[a-z<> ]*$/)
  })

  test("numbers and symbols leave a visible gap rather than disappearing", () => {
    expect(templateErrorMessage("timeout after 30000 ms")).toBe(templateErrorMessage("timeout after 30000 ms"))
    expect(templateErrorMessage("zzqq9876543210zzqq")).toBe("<x>")
    expect(templateErrorMessage("zzqq 9876543210 zzqq")).toBe("<x>")
  })

  test("only the first line is used, including with CR, LS and PS separators", () => {
    const secret = "frobnitz_ledger"
    for (const sep of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      const out = templateErrorMessage(`connection refused${sep}stack: ${secret} at /Users/zorblax/x.ts:12`)
      expect(out).not.toContain("frobnitz")
      expect(out).not.toContain("zorblax")
      expect(out).toBe(templateErrorMessage("connection refused"))
    }
  })

  test("a secret hidden on a later line is dropped, even when the first line is empty", () => {
    expect(templateErrorMessage(`\nAKIAIOSFODNN7EXAMPLE`)).toBe("")
  })

  test("unicode letters outside ASCII become placeholders, never pass through", () => {
    const out = templateErrorMessage("Fehler: Größe überschritten 日本語のエラー 🔥")
    expect(out).toMatch(/^[a-z<> ]*$/)
    expect(out).not.toContain("gr")
    expect(out).not.toMatch(/[^\x00-\x7f]/)
  })

  test("case is normalised so vocabulary words in any case template identically", () => {
    expect(templateErrorMessage("CONNECTION REFUSED")).toBe(templateErrorMessage("connection refused"))
  })

  test("a 10k-character single line is capped at 200 chars", () => {
    const line = "error ".repeat(2000) + "frobnitz_ledger"
    const out = templateErrorMessage(line)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).not.toContain("frobnitz")
  })

  test("a 10k-character unbroken secret collapses to one placeholder", () => {
    expect(templateErrorMessage("Zq".repeat(5000))).toBe("<x>")
  })

  test("adjacent unknown words collapse into one placeholder", () => {
    expect(templateErrorMessage("zzqq yyww xxvv")).toBe("<x>")
  })

  test("prototype-key words are not mistaken for vocabulary", () => {
    for (const w of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(templateErrorMessage(w)).toBe("<x>")
    }
  })

  test("describeToolError returns a template and a stable hash that differs from the template", () => {
    const raw = "connection refused for AKIAIOSFODNN7EXAMPLE"
    const d = describeToolError(raw)
    expect(d.errorMessage).toBe(templateErrorMessage(raw))
    expect(d.errorMessage).not.toContain("akia")
    expect(typeof d.errorHash).toBe("string")
    expect(d.errorHash.length).toBeGreaterThan(0)
    expect(describeToolError(raw).errorHash).toBe(d.errorHash)
  })
})

describe("v0.12.8 adversarial: plan-skip fail-closed guards", () => {
  const clean = () => ({ allowed: true, violations: [] as unknown[], warnings: [] as unknown[] })

  test("a clean result is returned unchanged", () => {
    const data = clean()
    const out = applyPolicySkipGuard(data)
    expect(out).toBe(data)
    expect(out.allowed).toBe(true)
    expect(out.violations).toEqual([])
    expect(out.policy_skipped).toBeUndefined()
  })

  test("plan_unavailable and POLICY_SKIPPED warnings, by rule or code, flip allowed to false", () => {
    for (const w of [
      { rule: "plan_unavailable" },
      { rule: "POLICY_SKIPPED" },
      { code: "plan_unavailable" },
      { code: "POLICY_SKIPPED" },
    ]) {
      const out = applyPolicySkipGuard({ allowed: true, violations: [], warnings: [w] })
      expect(out.allowed).toBe(false)
      expect(out.policy_skipped).toBe(true)
      expect(out.violations).toEqual([
        { rule: "policy_not_evaluated", severity: "error", message: POLICY_NOT_EVALUATED_MESSAGE },
      ])
    }
  })

  test("existing violations are preserved and the guard violation is appended", () => {
    const existing = { rule: "no_select_star", severity: "error" }
    const out = applyPolicySkipGuard({ allowed: true, violations: [existing], warnings: [{ rule: "POLICY_SKIPPED" }] })
    expect((out.violations as unknown[])[0]).toBe(existing)
    expect(out.violations as unknown[]).toHaveLength(2)
  })

  test("audit.allowed is flipped too, a non-object audit is left alone", () => {
    const audit = { allowed: true }
    applyPolicySkipGuard({ allowed: true, warnings: [{ rule: "POLICY_SKIPPED" }], audit })
    expect(audit.allowed).toBe(false)
    expect(() => applyPolicySkipGuard({ warnings: [{ rule: "POLICY_SKIPPED" }], audit: "x" })).not.toThrow()
    expect(() => applyPolicySkipGuard({ warnings: [{ rule: "POLICY_SKIPPED" }], audit: null })).not.toThrow()
  })

  test("unrelated warnings, lookalike rule names and wrong-case names do not flip a clean result", () => {
    for (const w of [
      { rule: "unrelated" },
      { rule: "plan_unavailable_x" },
      { rule: "PLAN_UNAVAILABLE" },
      { rule: "policy_skipped" },
      { rule: " POLICY_SKIPPED" },
      { message: "plan_unavailable" },
      {},
    ]) {
      const out = applyPolicySkipGuard({ allowed: true, violations: [], warnings: [w] })
      expect(out.allowed).toBe(true)
      expect(out.policy_skipped).toBeUndefined()
    }
  })

  test("malformed warnings containers and entries do not throw and do not flip the result", () => {
    for (const warnings of [undefined, null, "POLICY_SKIPPED", 5, {}, { rule: "POLICY_SKIPPED" }, [null], [undefined], [1], ["POLICY_SKIPPED"]]) {
      const out = applyPolicySkipGuard({ allowed: true, warnings })
      expect(out.allowed).toBe(true)
      expect(out.policy_skipped).toBeUndefined()
    }
  })

  test("a skip with a malformed violations field still blocks and yields an array", () => {
    for (const violations of [undefined, null, "bad", 7, {}]) {
      const out = applyPolicySkipGuard({ allowed: true, violations, warnings: [{ rule: "POLICY_SKIPPED" }] })
      expect(out.allowed).toBe(false)
      expect(Array.isArray(out.violations)).toBe(true)
      expect(out.violations as unknown[]).toHaveLength(1)
    }
  })

  test("an unrelated warning next to a skip warning still blocks", () => {
    const out = applyPolicySkipGuard({ allowed: true, warnings: [{ rule: "x" }, null, { code: "plan_unavailable" }] })
    expect(out.allowed).toBe(false)
  })

  test("an already-disallowed result stays disallowed", () => {
    const out = applyPolicySkipGuard({ allowed: false, violations: [], warnings: [{ rule: "POLICY_SKIPPED" }] })
    expect(out.allowed).toBe(false)
  })

  test("a __proto__ key in the data does not pollute Object.prototype", () => {
    const data = JSON.parse('{"allowed":true,"warnings":[{"rule":"POLICY_SKIPPED"}],"__proto__":{"polluted":true}}')
    applyPolicySkipGuard(data)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(data.allowed).toBe(false)
  })

  test("semantics: a plan-skipped note marks the result skipped", () => {
    for (const note of ["plan-based analysis was skipped", "Logical plan unavailable for this statement", "LOGICAL PLAN UNAVAILABLE"]) {
      const out = applySemanticsSkipGuard({ valid: true, notes: [note] })
      expect(out.skipped).toBe(true)
      expect(out.skip_reason).toBe(SEMANTICS_SKIPPED_MESSAGE)
    }
  })

  test("semantics: unrelated, empty or malformed notes do not mark skipped", () => {
    for (const notes of [undefined, null, [], ["all good"], "plan-based analysis was skipped", 5, {}, [null], [undefined], [{}]]) {
      const data = { valid: true, notes }
      const out = applySemanticsSkipGuard(data)
      expect(out).toBe(data)
      expect(out.skipped).toBeUndefined()
      expect(out.skip_reason).toBeUndefined()
    }
  })

  test("semantics: a skip note is found among unrelated and malformed notes", () => {
    const out = applySemanticsSkipGuard({ notes: [null, 3, "ok", "plan-based analysis was skipped"] })
    expect(out.skipped).toBe(true)
  })
})

describe("v0.12.8 adversarial: permission aliases only tighten", () => {
  const rule = (action: "allow" | "ask" | "deny", pattern: string, permission = "bash") => ({
    action,
    permission,
    pattern,
  })
  const req = (aliases: unknown, permission = "bash") =>
    ({ permission, metadata: { permissionAliases: aliases } }) as Parameters<typeof evaluateRequest>[0]

  test("no matching rule defaults to ask", () => {
    expect(evaluate("bash", "ls", []).action).toBe("ask")
    expect(evaluate("bash", "ls").action).toBe("ask")
  })

  test("an allow rule never matches through an alias", () => {
    const r = evaluateRequest(req({ "rm -rf /": [["ls"]] }), "rm -rf /", [rule("allow", "ls")])
    expect(r.action).toBe("ask")
  })

  test("a deny rule matches through an alias and beats the authored allow", () => {
    const r = evaluateRequest(req({ safe: [["rm -rf /"]] }), "safe", [rule("allow", "*"), rule("deny", "rm -rf /")])
    expect(r.action).toBe("deny")
  })

  test("rule order still decides: a later authored allow shadows an earlier alias deny", () => {
    const r = evaluateRequest(req({ safe: [["rm"]] }), "safe", [rule("deny", "rm"), rule("allow", "safe")])
    expect(r.action).toBe("allow")
  })

  test("a type-confused rule field that stringifies to a skip rule fails closed", () => {
    const out = applyPolicySkipGuard({ allowed: true, warnings: [{ rule: ["POLICY_SKIPPED"] }] })
    expect(out.allowed).toBe(false)
  })

  test("an ask via alias tightens an authored allow but not an authored deny", () => {
    expect(evaluateRequest(req({ a: [["b"]] }), "a", [rule("allow", "a"), rule("ask", "b")]).action).toBe("ask")
    expect(evaluateRequest(req({ a: [["b"]] }), "a", [rule("deny", "a"), rule("ask", "b")]).action).toBe("deny")
  })

  test("an alias-matched allow can not relax an authored ask", () => {
    const r = evaluateRequest(req({ a: [["b"]] }), "a", [rule("ask", "a"), rule("allow", "b")])
    expect(r.action).toBe("ask")
  })

  test("empty alias groups and empty alias lists fall back to plain evaluation", () => {
    const rules = [rule("allow", "a")]
    expect(evaluateRequest(req({ a: [] }), "a", rules).action).toBe("allow")
    expect(evaluateRequest(req({ a: [[]] }), "a", rules).action).toBe("allow")
    expect(evaluateRequest(req({}), "a", rules).action).toBe("allow")
    expect(evaluateRequest(req(undefined), "a", rules).action).toBe("allow")
  })

  test("type-confused aliases are ignored", () => {
    const rules = [rule("allow", "a"), rule("deny", "b")]
    for (const aliases of [null, "b", 5, true, [["b"]], { a: "b" }, { a: [["b", 1]] }, { a: [null] }, { a: [{}] }, { a: 5 }]) {
      expect(evaluateRequest(req(aliases), "a", rules).action).toBe("allow")
    }
  })

  test("a malformed group is skipped while a valid group still applies", () => {
    const r = evaluateRequest(req({ a: [[1], ["b"]] }), "a", [rule("allow", "a"), rule("deny", "b")])
    expect(r.action).toBe("deny")
  })

  test("multiple alias groups: any deny wins, then any ask", () => {
    const rules = [rule("allow", "a"), rule("ask", "x"), rule("deny", "y")]
    expect(evaluateRequest(req({ a: [["x"], ["y"]] }), "a", rules).action).toBe("deny")
    expect(evaluateRequest(req({ a: [["x"], ["z"]] }), "a", rules).action).toBe("ask")
    expect(evaluateRequest(req({ a: [["z"], ["w"]] }), "a", rules).action).toBe("allow")
  })

  test("aliases are looked up for the exact pattern only", () => {
    const rules = [rule("allow", "a"), rule("deny", "b")]
    expect(evaluateRequest(req({ other: [["b"]] }), "a", rules).action).toBe("allow")
  })

  test("a __proto__ or constructor pattern does not read inherited properties", () => {
    const rules = [rule("allow", "*")]
    for (const p of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(evaluateRequest(req({}), p, rules).action).toBe("allow")
    }
    const polluted = JSON.parse('{"__proto__":[["x"]]}')
    expect(evaluateRequest(req(polluted), "anything", [rule("allow", "anything"), rule("deny", "x")]).action).toBe("allow")
  })

  test("a rule whose pattern is __proto__ matches only that literal pattern", () => {
    const rules = [rule("deny", "__proto__")]
    expect(evaluate("bash", "__proto__", rules).action).toBe("deny")
    expect(evaluate("bash", "toString", rules).action).toBe("ask")
  })

  test("rules for other permissions are ignored even when the alias would match", () => {
    const r = evaluateRequest(req({ a: [["b"]] }, "read"), "a", [rule("deny", "b", "edit"), rule("allow", "a", "read")])
    expect(r.action).toBe("allow")
  })

  test("last matching rule wins across rulesets", () => {
    expect(evaluate("bash", "a", [rule("deny", "a")], [rule("allow", "a")]).action).toBe("allow")
    expect(evaluate("bash", "a", [rule("allow", "a")], [rule("deny", "a")]).action).toBe("deny")
  })

  test("evaluateRequestPatterns sorts denied patterns first and keeps others in order", () => {
    const request = {
      permission: "bash",
      metadata: { permissionAliases: { c: [["bad"]] } },
      patterns: ["a", "c", "b"],
    } as Parameters<typeof evaluateRequestPatterns>[0]
    const out = evaluateRequestPatterns(request, [rule("allow", "*"), rule("deny", "bad")])
    expect(out.map((o) => o.pattern)).toEqual(["c", "a", "b"])
    expect(out[0]!.rule.action).toBe("deny")
    expect(evaluateRequestPatterns({ ...request, patterns: [] }, [])).toEqual([])
  })
})

describe("v0.12.8 adversarial: answer_commit conjunction", () => {
  test("empty and whitespace requests ask for one item", () => {
    expect(requestedItems("")).toEqual({ count: 1, joins: [] })
    expect(requestedItems("   \n\n  ")).toEqual({ count: 1, joins: [] })
  })

  test("a request with no conjunction asks for one item", () => {
    expect(requestedItems("What is the total revenue for 2024?")).toEqual({ count: 1, joins: [] })
  })

  test("narrow connectives are counted and quoted", () => {
    const r = requestedItems("Find the top customer and report their lifetime value.")
    expect(r.count).toBe(2)
    expect(r.joins).toHaveLength(1)
    expect(r.joins[0]).toMatch(/^and report/)
  })

  test("ranges and constraint clauses do not count", () => {
    expect(requestedItems("Sum sales between 2020 and 2022.").count).toBe(1)
    expect(requestedItems("List orders and only those shipped.").count).toBe(1)
    expect(requestedItems("List orders and excluding refunds.").count).toBe(1)
  })

  test("only the first paragraph is considered", () => {
    expect(requestedItems("Total revenue.\n\nAlso list the top customer as well as the worst one.").count).toBe(1)
  })

  test("the join quote is bounded to eight words", () => {
    const r = requestedItems("Compute the total and report one two three four five six seven eight nine ten eleven.")
    expect(r.joins[0]!.split(" ").length).toBeLessThanOrEqual(8)
  })

  test("a very large input finishes and returns a bounded join list", () => {
    const sentence = "Find x and report y. "
    const r = requestedItems(sentence.repeat(20000))
    expect(r.count).toBe(2)
    expect(requestedItems("a ".repeat(200_000)).count).toBe(1)
    expect(requestedItems("and ".repeat(50_000)).count).toBeGreaterThanOrEqual(1)
  })

  test("unicode, RTL and emoji text does not throw", () => {
    expect(requestedItems("总收入是多少 and report 利润 🔥").count).toBe(2)
    expect(requestedItems("\u202e\u0000 and the \ud83d").count).toBeGreaterThanOrEqual(1)
  })

  test("prototype keys are ordinary text", () => {
    expect(requestedItems("__proto__ and report constructor").count).toBe(2)
  })

  const userMsg = (text: string, synthetic = false) =>
    ({ info: { role: "user" }, parts: [{ type: "text", text, synthetic }] }) as never
  let sid = 0
  const session = () => `adv-v0128-${++sid}-${Math.random()}`

  test("no fields argument is never rejected", () => {
    expect(conjunctionRejection({}, [userMsg("Find x and report y.")], session())).toBeUndefined()
  })

  test("empty messages and enough fields are not rejected", () => {
    expect(conjunctionRejection({ fields: [{ name: "a" }] }, [], session())).toBeUndefined()
    expect(
      conjunctionRejection({ fields: [{ name: "a" }, { name: "b" }] }, [userMsg("Find x and report y.")], session()),
    ).toBeUndefined()
  })

  test("too few fields is rejected once per session and request, names are JSON-escaped", () => {
    const s = session()
    const messages = [userMsg("Find x and report y.")]
    const first = conjunctionRejection({ fields: [{ name: 'a"b' }] }, messages, s)
    expect(first).toContain(CONJUNCTION_REJECTION_MARKER)
    expect(first).toContain('["a\\"b"]')
    expect(first).toContain("1 field ")
    expect(conjunctionRejection({ fields: [{ name: "a" }] }, messages, s)).toBeUndefined()
    // a different session is advised independently
    expect(conjunctionRejection({ fields: [{ name: "a" }] }, messages, session())).toContain(CONJUNCTION_REJECTION_MARKER)
  })

  test("synthetic parts are ignored when reading the request", () => {
    const messages = [userMsg("Find x and report y."), userMsg("budget reminder and report more", true)]
    // latest user message has only a synthetic part -> empty request -> no rejection
    expect(conjunctionRejection({ fields: [{ name: "a" }] }, messages, session())).toBeUndefined()
  })

  test("a prior marker rejection in history suppresses a repeat after a restart", () => {
    const messages = [
      userMsg("Find x and report y."),
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "answer_commit", state: { status: "error", error: `${CONJUNCTION_REJECTION_MARKER} earlier` } },
        ],
      } as never,
    ]
    expect(conjunctionRejection({ fields: [{ name: "a" }] }, messages, session())).toBeUndefined()
  })

  test("messages with missing parts do not crash the history scan", () => {
    const messages = [userMsg("Find x and report y."), { info: { role: "assistant" }, parts: [{}] } as never]
    expect(conjunctionRejection({ fields: [{ name: "a" }] }, messages, session())).toContain(CONJUNCTION_REJECTION_MARKER)
  })
})

describe("v0.12.8 adversarial: unsent memory notice", () => {
  const binding = { datamateId: 1, datamateName: "n", repoRemote: null, projectPath: "/p", linkedAt: 0 } as never
  const report = (over: Record<string, unknown> = {}) =>
    ({ binding, memory: { local: 3, unsynced: 2 }, skillsEnabled: true, skillsSyncedAt: null, ...over }) as never
  const deps = (over: Partial<UnsentMemoryDeps>): UnsentMemoryDeps => ({
    target: () => ({ directory: "/target", binding }),
    status: async () => report(),
    ...over,
  })

  test("notice text: unknown, zero, one and many", () => {
    expect(unsentMemoryNotice(0)).toBeNull()
    expect(unsentMemoryNotice(null)).toContain("Could not confirm")
    expect(unsentMemoryNotice(1)).toContain("1 memory on this machine is not in the workspace yet")
    expect(unsentMemoryNotice(1)).toContain("send it.")
    expect(unsentMemoryNotice(2)).toContain("2 memories on this machine are not in the workspace yet")
    expect(unsentMemoryNotice(2)).toContain("send them.")
  })

  test("no mirror target returns null and never calls status", async () => {
    let called = false
    const out = await unsentMemoryNoticeAfterRun("/f", 5000, deps({ target: () => undefined, status: async () => ((called = true), report()) }))
    expect(out).toBeNull()
    expect(called).toBe(false)
  })

  test("the target directory wins, the fallback is used when it is undefined", async () => {
    const seen: string[] = []
    const status = async (d: string) => (seen.push(d), report())
    await unsentMemoryNoticeAfterRun("/fallback", 5000, deps({ status }))
    await unsentMemoryNoticeAfterRun("/fallback", 5000, deps({ target: () => ({ directory: undefined, binding }), status }))
    expect(seen).toEqual(["/target", "/fallback"])
  })

  test("the binding the upload used is passed through", async () => {
    let got: unknown
    await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async (_d, b) => ((got = b), report()) }))
    expect(got).toBe(binding)
  })

  test("a status that rejects reports the count as unknown", async () => {
    const out = await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async () => Promise.reject(new Error("disk")) }))
    expect(out).toContain("Could not confirm")
  })

  test("a status that throws synchronously propagates (it is the caller's contract to return a promise)", async () => {
    await expect(
      unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: (() => { throw new Error("sync") }) as never })),
    ).rejects.toThrow("sync")
  })

  test("a status that never settles reports unknown after the timeout", async () => {
    const out = await unsentMemoryNoticeAfterRun("/f", 1, deps({ status: () => new Promise(() => {}) }))
    expect(out).toContain("Could not confirm")
  })

  test("unreadable memory is unknown even when counts are present", async () => {
    const out = await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async () => report({ memoryUnreadable: true }) }))
    expect(out).toContain("Could not confirm")
  })

  test("no binding or memory off is silent", async () => {
    expect(await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async () => report({ binding: null }) }))).toBeNull()
    expect(await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async () => report({ memory: null }) }))).toBeNull()
  })

  test("count 0 is silent, a null count is unknown, a positive count is reported", async () => {
    expect(await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async () => report({ memory: { local: 1, unsynced: 0 } }) }))).toBeNull()
    expect(
      await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async () => report({ memory: { local: 1, unsynced: null } }) })),
    ).toContain("Could not confirm")
    expect(
      await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async () => report({ memory: { local: 5, unsynced: 4 } }) })),
    ).toContain("4 memories")
  })

  test("a resolved null report is treated as unknown", async () => {
    expect(await unsentMemoryNoticeAfterRun("/f", 5000, deps({ status: async () => null as never }))).toContain("Could not confirm")
  })
})

describe("v0.12.8 adversarial: schema value profile", () => {
  test("valueShape of empty and punctuation-only strings", () => {
    expect(valueShape("")).toBe("")
    expect(valueShape("-/ .")).toBe("-/ .")
  })

  test("valueShape collapses runs and keeps punctuation", () => {
    expect(valueShape("H01M4/9066")).toBe("A9+A9/9+")
    expect(valueShape("abc DEF 123")).toBe("a+ A+ 9+")
    expect(valueShape("a")).toBe("a")
    expect(valueShape("aB")).toBe("aA")
  })

  test("valueShape handles unicode letters and digits", () => {
    expect(valueShape("Éé")).toBe("Aa")
    expect(valueShape("日本語")).toBe("a+")
    expect(valueShape("٣٤")).toBe("9+")
    expect(valueShape("🔥🔥")).toBe("🔥🔥")
  })

  test("valueShape of a very long string stays short and linear", () => {
    expect(valueShape("a".repeat(100_000))).toBe("a+")
    expect(valueShape("aB1".repeat(10_000)).length).toBe(30_000)
  })

  test("valueShape keeps shell and SQL metacharacters literal and does not execute them", () => {
    expect(valueShape("x'; DROP TABLE t;--")).toBe("a'; A+ A+ a;--")
  })

  test("profileDocuments of no documents is empty", () => {
    expect(profileDocuments([])).toBe("")
  })

  test("profileDocuments lists values for simple documents", () => {
    const out = profileDocuments([{ status: "open" }, { status: "closed" }, { status: "open" }])
    expect(out).toContain("Value samples:")
    expect(out).toContain("status")
    expect(out).toContain("open")
    expect(out).toContain("closed")
  })

  test("profileDocuments with null, mixed types and empty documents does not throw", () => {
    const out = profileDocuments([{ a: null }, { a: 1 }, { a: "x" }, {}, { a: [1, "y"] }, { a: { b: null } }])
    expect(out).toContain("Value samples:")
    expect(typeof out).toBe("string")
  })

  test("profileDocuments with __proto__ and constructor keys does not pollute prototypes", () => {
    const docs = [
      JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},"name":"a"}'),
      JSON.parse('{"__proto__":"str","name":"b"}'),
    ]
    const out = profileDocuments(docs)
    expect(typeof out).toBe("string")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
    expect(out).toContain("name")
  })

  test("profileDocuments clips very long strings instead of echoing them", () => {
    const long = "Q".repeat(50_000)
    const out = profileDocuments([{ note: long }, { note: long }])
    expect(out.length).toBeLessThan(5_000)
    expect(out).not.toContain(long)
  })

  test("profileDocuments caps the number of profiled fields", () => {
    const doc: Record<string, string> = {}
    for (let i = 0; i < 200; i++) doc[`field${String(i).padStart(3, "0")}`] = `v${i}`
    const out = profileDocuments([doc])
    expect(out).toContain("more columns not profiled")
  })
})
