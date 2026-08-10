// #1052 D8 review-fix (M6): self-test for the tracker-leak scanner's regexes.
// The scanner is the sole guard against internal-tracker refs landing on the
// public repo. If its regex regresses, the whole hook is silently useless. The
// original `\bAI-\d+\b` had exactly that bug — it missed `AI-1234foo` /
// `AI-1234_bar` because a trailing word char defeats the ending word-boundary.
// Consensus review flagged this as CRITICAL. These tests pin the regex
// against the specific suffix classes it must catch, plus the negative cases
// that must remain clean.
//
// If you edit `script/check-tracker-leaks.ts` RULES and this test still passes,
// you probably didn't regress the guard. If a case here starts failing, either
// the regex changed intentionally (update the test) or the regex broke silently
// (the whole point of this file).

import { describe, expect, test } from "bun:test"
import { RULES } from "../../../../script/check-tracker-leaks"

const jiraRule = RULES.find((r) => r.name.startsWith("Jira ticket key"))!
const urlRule = RULES.find((r) => r.name.startsWith("Atlassian instance URL"))!

function matches(pattern: RegExp, text: string): string[] {
  // Fresh regex per call — global flag state would otherwise leak between calls.
  const rx = new RegExp(pattern.source, pattern.flags)
  return [...text.matchAll(rx)].map((m) => m[0])
}

describe("Jira-key regex — positive cases (MUST match)", () => {
  test.each([
    ["bare key at end of line", "See AI-1234"],
    ["key followed by period", "See AI-1234."],
    ["key followed by comma", "See AI-1234, next item"],
    ["key in parentheses", "Fix (AI-1234) landed"],
    ["key at branch-name boundary", "feature/AI-1234-fix"],
    ["key followed by hyphen-word", "AI-1234-branch"],
    ["key followed by slash", "AI-1234/subtask"],
    ["key followed by colon", "AI-1234: title"],
    ["key at start of line", "AI-1234 is the ticket"],
    ["key on its own line", "AI-1234"],
    ["key followed by whitespace + newline", "AI-1234\nnext"],
  ])("matches: %s (%s)", (_label, text) => {
    const hits = matches(jiraRule.pattern, text)
    expect(hits).toContain("AI-1234")
  })

  // The consensus-review M1 fix specifically — these MUST match after the
  // pattern was loosened (dropped trailing \b). The original `\bAI-\d+\b`
  // missed all of these because a trailing word char defeats the ending \b.
  test.each([
    ["suffix letter directly", "AI-1234foo", "AI-1234"],
    ["suffix underscore", "AI-1234_bar", "AI-1234"],
    ["suffix mixed word chars", "AI-1234thing", "AI-1234"],
    ["branch with underscore", "feature/AI-1234_bug", "AI-1234"],
    ["path prefix + suffix underscore", "docs/AI-1234_notes.md", "AI-1234"],
  ])("catches suffix-adjacent leak: %s (%s) → %s", (_label, text, expected) => {
    const hits = matches(jiraRule.pattern, text)
    expect(hits).toContain(expected)
  })
})

describe("Jira-key regex — known blind spots (documented)", () => {
  // No leading `\b` = no match. Camel-cased pastes where AI immediately
  // follows another word char remain a known blind spot. Realistic leak
  // surface (branch names, commit messages, path fragments, doc text) is
  // delimited so this doesn't hit in practice.
  test("does NOT catch camelCase paste without separator", () => {
    expect(matches(jiraRule.pattern, "handleAI-1234thing")).toEqual([])
  })
})

describe("Jira-key regex — negative cases (MUST NOT match)", () => {
  test.each([
    ["prefix word char", "prefixAI-1234"],
    ["prefix underscore", "_AI-1234"],
    ["different project prefix", "ML-1234"],
    ["no dash", "AI1234"],
    ["dash but no digits", "AI-"],
    ["ordinary word AI", "the AI is here"],
    ["url with 'ai-'", "https://example.com/ai-features"],
    ["lowercase", "ai-1234"],
  ])("doesn't match: %s (%s)", (_label, text) => {
    const hits = matches(jiraRule.pattern, text)
    expect(hits).toEqual([])
  })
})

describe("Atlassian URL regex", () => {
  test("matches the bare host", () => {
    expect(matches(urlRule.pattern, "altimateai.atlassian.net")).toEqual([
      "altimateai.atlassian.net",
    ])
  })

  test("matches inside a URL", () => {
    expect(
      matches(urlRule.pattern, "https://altimateai.atlassian.net/browse/AI-1"),
    ).toContain("altimateai.atlassian.net")
  })

  test("does not match unrelated atlassian hosts", () => {
    expect(matches(urlRule.pattern, "acme.atlassian.net")).toEqual([])
    expect(matches(urlRule.pattern, "docs.atlassian.com")).toEqual([])
  })
})
