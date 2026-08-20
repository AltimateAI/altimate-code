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

import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
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

// altimate_change — bot-review fix: end-to-end coverage of the scanner's git
// behaviour, not just its regexes. These run the real script against throwaway
// repositories, because the failures the reviewers found were all in how the
// scanner picks WHAT to scan, which the regex tests cannot see. The script is
// invoked as a subprocess rather than importing its internals, so nothing has
// to be exported purely for tests. Leak fixtures still come from `key()`, so no
// tracker-shaped literal enters this file.
describe("scanner end-to-end (git behaviour)", () => {
  const SCRIPT = path.resolve(import.meta.dir, "../../../../script/check-tracker-leaks.ts")
  const ZERO = "0".repeat(40)

  // These repositories contain tracker-key fixtures, so they are removed rather
  // than left in tmp for the next person to grep.
  const created: string[] = []
  afterAll(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
  })

  function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-e2e-"))
    created.push(dir)
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" })
    git("init", "-q", "-b", "main", ".")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "test")
    return dir
  }
  const git = (dir: string, ...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" })
  function run(dir: string, stdin?: string) {
    return spawnSync("bun", [SCRIPT], { cwd: dir, encoding: "utf-8", input: stdin ?? "" })
  }
  function commit(dir: string, text: string, message: string) {
    fs.appendFileSync(path.join(dir, "f.txt"), text + "\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-qm", message)
  }
  function baseline(dir: string) {
    commit(dir, "base", "init")
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD")
  }

  test("a repository with no commits is a clean scan, not a hard failure", () => {
    // `rev-parse --abbrev-ref HEAD` exits 128 on an unborn HEAD; failing loud
    // there contradicted the documented brand-new-repo path.
    expect(run(repo()).status).toBe(0)
  })

  test("a clean branch passes silently", () => {
    const dir = repo()
    baseline(dir)
    git(dir, "checkout", "-qb", "feature")
    commit(dir, "nothing to see", "clean work")
    const r = run(dir)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe("")
  })

  test("a tracker reference in an added line fails the scan", () => {
    const dir = repo()
    baseline(dir)
    git(dir, "checkout", "-qb", "feature")
    commit(dir, `see ${key(1234)} for context`, "leaky work")
    const r = run(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(key(1234))
  })

  test("scans the ref being pushed, not the checked-out branch", () => {
    // git hands a pre-push hook `<local ref> <local sha> <remote ref> <remote sha>`.
    // Scanning HEAD regardless let `git push origin dirty:other` approve a ref
    // nobody had looked at.
    const dir = repo()
    baseline(dir)
    git(dir, "checkout", "-qb", "dirty")
    commit(dir, `hidden ${key(9999)}`, "leaky work")
    const dirtySha = git(dir, "rev-parse", "dirty").stdout.trim()
    git(dir, "checkout", "-q", "main") // HEAD is now clean

    expect(run(dir).status).toBe(0) // no stdin → HEAD only → misses it
    const pushed = run(dir, `refs/heads/dirty ${dirtySha} refs/heads/other ${ZERO}\n`)
    expect(pushed.status).toBe(1)
    expect(pushed.stderr).toContain(key(9999))
  })

  test("scans the destination ref name, which need not match the source", () => {
    // `git push origin main:refs/heads/<tracker-key>` publishes a tracker-shaped
    // branch while the source branch and every line of its content are clean.
    const dir = repo()
    baseline(dir)
    const mainSha = git(dir, "rev-parse", "main").stdout.trim()
    const r = run(dir, `refs/heads/main ${mainSha} refs/heads/${key(7777)} ${ZERO}\n`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(key(7777))
  })

  test("a deletion-only push scans nothing rather than falling back to HEAD", () => {
    const dir = repo()
    baseline(dir)
    git(dir, "checkout", "-qb", "dirty")
    commit(dir, `hidden ${key(4242)}`, "leaky work") // HEAD is dirty on purpose
    const r = run(dir, `(delete) ${ZERO} refs/heads/gone ${"1".repeat(40)}\n`)
    expect(r.status).toBe(0)
  })
})
