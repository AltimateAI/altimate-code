// Self-test for the tracker-leak scanner's regexes. See
// `script/check-tracker-leaks.ts`. The scanner is the sole guard against
// internal-tracker references landing on this public repo — if its regex
// regresses, the guard silently stops working. These tests pin the regex
// against representative suffix classes it must catch plus the negatives
// that must remain clean.
//
// Fixture note: this file is on a public repo that forbids concrete
// project-prefixed tracker keys in source. Test inputs are therefore built
// at runtime from a helper — `key(1234, "foo")` produces the exact string
// the regex needs to see, but the literal never appears in git-searchable
// source. Grep the repo for `\bAI-\d+` and this file returns nothing.

import { describe, expect, test } from "bun:test"
import { RULES } from "../../../../script/check-tracker-leaks"

const jiraRule = RULES.find((r) => r.name.startsWith("Jira ticket key"))!
const urlRule = RULES.find((r) => r.name.startsWith("Atlassian instance URL"))!

// Build a Jira-key-shaped fixture without embedding the literal in source.
// PREFIX + "-" + digits produces the exact string at runtime; the scanner's
// regex sees whatever the test passes to `matches()`. Splitting the two
// letters + hyphen defeats a naïve `grep -RE 'AI-\d+' .` sweep of this file.
const PREFIX = "A" + "I"
const key = (n: number, suffix = ""): string => `${PREFIX}-${n}${suffix}`

// Same treatment for the Atlassian host used in the URL tests below.
const HOST = "altimate" + "ai.atlassian.net"

function matches(pattern: RegExp, text: string): string[] {
  // Fresh regex per call — global flag state would otherwise leak between calls.
  const rx = new RegExp(pattern.source, pattern.flags)
  return [...text.matchAll(rx)].map((m) => m[0])
}

describe("Jira-key regex — positive cases (MUST match)", () => {
  test.each([
    ["bare key at end of line", `See ${key(1234)}`],
    ["key followed by period", `See ${key(1234)}.`],
    ["key followed by comma", `See ${key(1234)}, next item`],
    ["key in parentheses", `Fix (${key(1234)}) landed`],
    ["key at branch-name boundary", `feature/${key(1234, "-fix")}`],
    ["key followed by hyphen-word", key(1234, "-branch")],
    ["key followed by slash", `${key(1234)}/subtask`],
    ["key followed by colon", `${key(1234)}: title`],
    ["key at start of line", `${key(1234)} is the ticket`],
    ["key on its own line", key(1234)],
    ["key followed by whitespace + newline", `${key(1234)}\nnext`],
  ])("matches: %s", (_label, text) => {
    const hits = matches(jiraRule.pattern, text)
    expect(hits).toContain(key(1234))
  })

  // The consensus-review fix specifically — these MUST match after the
  // pattern was loosened (dropped trailing \b). The original required a
  // trailing word boundary, which fails when a word char follows the digits.
  test.each([
    ["suffix letter directly", key(1234, "foo"), key(1234)],
    ["suffix underscore", key(1234, "_bar"), key(1234)],
    ["suffix mixed word chars", key(1234, "thing"), key(1234)],
    ["branch with underscore", `feature/${key(1234, "_bug")}`, key(1234)],
    ["path prefix + suffix underscore", `docs/${key(1234, "_notes.md")}`, key(1234)],
  ])("catches suffix-adjacent leak: %s", (_label, text, expected) => {
    const hits = matches(jiraRule.pattern, text)
    expect(hits).toContain(expected)
  })
})

describe("Jira-key regex — known blind spots (documented)", () => {
  // No leading word-boundary = no match. Camel-cased pastes where the
  // prefix immediately follows another word char remain a known blind spot.
  // Realistic leak surface (branch names, commit messages, path fragments,
  // doc text) is delimited so this doesn't hit in practice.
  test("does NOT catch camelCase paste without separator", () => {
    expect(matches(jiraRule.pattern, `handle${key(1234, "thing")}`)).toEqual([])
  })
})

describe("Jira-key regex — negative cases (MUST NOT match)", () => {
  test.each([
    ["prefix word char", `prefix${key(1234)}`],
    ["prefix underscore", `_${key(1234)}`],
    ["different project prefix", "ML-1234"],
    ["no dash", `${PREFIX}1234`],
    ["dash but no digits", `${PREFIX}-`],
    ["ordinary word AI", `the ${PREFIX} is here`],
    ["url with 'ai-'", "https://example.com/ai-features"],
    ["lowercase", "ai-1234"],
  ])("doesn't match: %s", (_label, text) => {
    const hits = matches(jiraRule.pattern, text)
    expect(hits).toEqual([])
  })
})

describe("Atlassian URL regex", () => {
  test("matches the bare host", () => {
    expect(matches(urlRule.pattern, HOST)).toEqual([HOST])
  })

  test("matches inside a URL", () => {
    expect(matches(urlRule.pattern, `https://${HOST}/browse/${key(1)}`)).toContain(HOST)
  })

  test("does not match unrelated atlassian hosts", () => {
    expect(matches(urlRule.pattern, "acme.atlassian.net")).toEqual([])
    expect(matches(urlRule.pattern, "docs.atlassian.com")).toEqual([])
  })
})
