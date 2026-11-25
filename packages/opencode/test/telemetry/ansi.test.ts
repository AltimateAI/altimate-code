import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Telemetry } from "../../src/altimate/telemetry"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"
import { Ansi } from "../../src/altimate/telemetry/ansi"

const cases = [
  ["plain", "request failed: password is connection refused"],
  ["csi", "request failed: \x1b[31mpassword\x1b[0m is connection refused"],
  ["c1", "request failed: \x9b31mpassword\x9b0m is connection refused"],
  ["osc-bel", "\x1b]0;synthetic title\x07password=wrong user"],
  ["osc-st", "\x1b]0;synthetic title\x1b\\password=wrong user"],
  ["osc-c1-st", "\x1b]0;synthetic title\x9cpassword=wrong user"],
  ["incomplete-osc", "request failed \x1b]8;;wrong user"],
  ["incomplete-csi", "password=wrong user \x1b[31"],
  ["multiline", "connection refused\npassword=wrong user"],
  ["at-cap", "error ".repeat(1638) + "xx"],
  ["beyond-cap", "error ".repeat(2000) + "password=wrong user"],
  ["open-quote", "error ".repeat(1300) + '"' + "connection ".repeat(500)],
  ["path-cut", "error ".repeat(1300) + "/Users/synthetic/a ".repeat(200)],
  ["lookahead", "x ".repeat(4093) + "password=wrong user"],
  ["unbroken", "x".repeat(12000)],
]

const pieces = [
  "connection refused",
  "password=wrong user",
  "'wrong user'",
  '"connection refused"',
  "/Users/synthetic/file.sql",
  "C:\\Users\\synthetic\\file.sql",
  "\x1b[31m",
  "\x9b31m",
  "\x1b]8;;https://example.test\x07",
  "\n",
  "token=wrong user",
  "connection string=wrong user",
]
const corpus = Array.from({ length: 96 }, (_, i) =>
  pieces
    .map((_, j) => pieces[(i * (j + 1) + j * 7) % pieces.length])
    .join(i % 2 ? " " : "_")
    .repeat(i % 5 === 0 ? 300 : 1),
)

const hashes: Record<string, string> = {
  plain: "ae7e754cfb2d72a2",
  csi: "ae7e754cfb2d72a2",
  c1: "40678db384156848",
  "osc-bel": "914eb30c45c8b094",
  "osc-st": "914eb30c45c8b094",
  "osc-c1-st": "bd974ba379a9b36f",
  "incomplete-osc": "821db0d35dce78e7",
  "incomplete-csi": "bb977ba58d3d2d21",
  multiline: "7ee1b11bcf0c4db1",
  "at-cap": "80b18d6fbcfa3063",
  "beyond-cap": "80b18d6fbcfa3063",
  "open-quote": "80b18d6fbcfa3063",
  "path-cut": "80b18d6fbcfa3063",
  lookahead: "bf3ce936232f73c1",
  unbroken: "e3b0c44298fc1c14",
}

describe("bounded ANSI profiles", () => {
  test("shares the historical input and lookahead limits", () => {
    expect(Ansi.MAX_INPUT).toBe(8192)
    expect(Ansi.LOOKAHEAD).toBe(2048)
  })

  test.each([
    ["CSI", "\x1b[31mpassword\x1b[0m=wrong user"],
    ["C1 CSI", "\x9b31mpassword\x9b0m=wrong user"],
    ["OSC BEL", "\x1b]0;synthetic\x07password=wrong user"],
    ["OSC ST", "\x1b]0;synthetic\x1b\\password=wrong user"],
    ["OSC C1 ST", "\x1b]0;synthetic\x9cpassword=wrong user"],
  ])("normalizes the template's %s sequences", (_, raw) => {
    expect(Ansi.normalize(raw, "template")).toBe("password=wrong user")
  })

  test.each([
    ["text", "x".repeat(8193)],
    ["ANSI-only text", "\x1b[0m".repeat(3000)],
    ["unfinished CSI", "\x1b[" + "0;".repeat(5000)],
    ["OSC closing past the cap", "\x1b]0;" + "x".repeat(8192) + "\x07"],
    ["credential marker crossing the cap", " ".repeat(8190) + "password=wrong user"],
    ["large unfinished OSC", "\x1b]0;" + "x".repeat(2_000_000)],
  ])("rejects oversized %s before stripping", (_, raw) => {
    expect(Ansi.normalize(raw, "template")).toBeUndefined()
  })

  test.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
    "preserves the original first-line boundary for %j",
    (newline) => {
      const first = "x".repeat(8192)
      expect(Ansi.normalize(first + newline + "password=wrong user", "template")).toBe(first)
      expect(Ansi.normalize(newline + "x".repeat(100000), "template")).toBe("")
    },
  )

  test("does not emit a surrogate split by the input cap", () => {
    expect(Ansi.normalize(" ".repeat(8191) + "😀", "template")).toBeUndefined()
    expect(Ansi.normalize(" ".repeat(8190) + "😀", "template")).toBe(" ".repeat(8190) + "😀")
  })

  test("bounds the legacy normalization window without dropping line separators", () => {
    expect(Ansi.normalize("x".repeat(10240) + "wrong user", "legacy")).toBe("x".repeat(10240))
    expect(Ansi.normalize("connection\nrefused", "legacy")).toBe("connection\nrefused")
  })

  test("keeps the historical C1 hash profile explicitly separate", () => {
    const raw = "request failed: \x9b31mpassword\x9b0m is connection refused"
    const cleaned = Ansi.normalize(raw, "template")!
    expect(cleaned).toBe("request failed: password is connection refused")
    expect(ErrorDetail.describeToolError(raw).errorMessage).toBe("request failed <x>")
    expect(ErrorDetail.describeToolError(raw).errorHash).toBe("40678db384156848")
    expect(Telemetry.hashError(Telemetry.maskString(cleaned).slice(0, 500))).toBe("ae7e754cfb2d72a2")
  })
})

describe("pre-V4 maskString compatibility", () => {
  test.each(cases)("pins the historical error hash for %s", (name, raw) => {
    expect(ErrorDetail.describeToolError(raw).errorHash).toBe(hashes[name])
  })

  test("preserves complete masked output over the frozen 96-input corpus", () => {
    expect(corpus.length).toBe(96)
    const digest = createHash("sha256")
      .update(JSON.stringify(corpus.map((raw) => Telemetry.maskString(raw))))
      .digest("hex")
    expect(digest).toBe("1fe645e8c04b5f30482bce034f9ddde64a36ac20beb475696a384edb39e1028c")
  })
})
