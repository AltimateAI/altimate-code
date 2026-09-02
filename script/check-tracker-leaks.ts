#!/usr/bin/env bun
/**
 * Scans the local diff, branch name, and commit messages against `origin/main`
 * for internal-tracker references that must not land on this public repo.
 * The exact patterns live in the `RULES` array below — read there for what
 * gets flagged.
 *
 * Exits 1 on any hit with a clear, per-source report. Exits 0 clean.
 *
 * Sources scanned:
 *   1. Current branch name.
 *   2. Commit messages of local commits ahead of `origin/main`.
 *   3. `git diff origin/main...HEAD` — content of the pushed diff, added lines only.
 *
 * Base ref override via `--base=<ref>` (defaults to `origin/main`) — CI passes the
 * PR base. When no commits are ahead of the base, the script is a no-op success.
 *
 * NOTE: this only checks pushed content. Historical commits already on main are
 * intentionally out of scope — rewriting main history is destructive and not the
 * job of a pre-push guard.
 */

import { $ } from "bun"

// altimate_change — #1052 D8 review-fix: drop the trailing word-boundary from
// the Jira-key regex so the guard catches suffix-adjacent leaks (letter,
// underscore, or another word char immediately after the digits). The
// original required a trailing `\b`, which fails when a word char follows —
// exactly the class of typo and paste-through the scrubber exists to prevent.
//
// Naïve fixes (negative lookahead like `(?![a-zA-Z0-9_])`) don't help: the
// regex engine backtracks the digit run, but every position still has a digit
// as the "next char" so the lookahead keeps failing. The correct fix is no
// trailing boundary at all — the pattern matches greedily through the digits,
// stops at the first non-digit, and reports the prefix regardless of what
// follows.
//
// Caveat: pastes with no separator before the prefix (no leading `\b`) are
// not caught. Camel-cased inputs remain a known blind spot — accepted; the
// realistic leak surface is branches, commits, comments, and doc text where
// the reference is delimited by whitespace, punctuation, or a path separator.
// Split so this rule's own definition doesn't match the scanner it defines
// (same technique used for the Jira-key/Atlassian-host fixtures in
// packages/opencode/test/skill/tracker-leak-check.test.ts).
const INTERNAL_HOST = "oneal" + "timate.com"

export const RULES = [
  {
    name: "Jira ticket key (AI-<digits>)",
    pattern: /\bAI-\d+/g,
    remediation:
      "Rename branch / rewrite commit / delete text. Track work via GitHub issues on AltimateAI/altimate-code.",
  },
  {
    name: "Atlassian instance URL",
    pattern: /\baltimateai\.atlassian\.net\b/g,
    remediation: "Replace with the corresponding GitHub issue link or drop the reference.",
  },
  {
    name: `Internal hostname (${INTERNAL_HOST})`,
    pattern: new RegExp(`\\b${INTERNAL_HOST.replace(/\./g, "\\.")}\\b`, "g"),
    remediation: "Replace with the corresponding GitHub issue link or drop the reference.",
  },
]

type Hit = {
  rule: string
  source: string
  match: string
  line?: string
  remediation: string
}

// altimate_change — bot-review fix: replace the `sh -c ${cmd}` helper.
// Two problems it had:
//   (a) `sh -c ${cmd}` collapsed the whole command string into one shell arg,
//       which the shell then re-parsed — so a caller-supplied value (e.g.
//       `--base=$(rm -rf ~)`) would execute as shell. Cubic P1.
//   (b) `catch { return "" }` swallowed real errors (missing ref, corrupted
//       repo). A failed git command would look identical to a clean scan.
//
// `git` is invoked directly via Bun.$ (no shell). Args are passed through the
// tagged-template interpolation which quotes each interpolation as a single
// argv element — no shell parsing anywhere. `.nothrow()` lets us inspect the
// exit code instead of catching an exception. `exitOnFailure` distinguishes
// "expected empty result" (mergeBase against a diverged history) from
// "unexpected failure" (git binary missing, corrupt index) so the latter
// fails loud rather than reporting the branch as clean.
async function git(args: string[], opts: { failOnError?: boolean } = { failOnError: true }): Promise<string> {
  const r = await $`git ${args}`.quiet().nothrow()
  if (r.exitCode !== 0) {
    if (opts.failOnError) {
      process.stderr.write(
        `\ntracker-leak check: \`git ${args.join(" ")}\` exited ${r.exitCode}\n${r.stderr.toString().trim()}\n\n`,
      )
      process.exit(2)
    }
    return ""
  }
  return r.text().trim()
}

function scanText(text: string, source: string, hits: Hit[]) {
  for (const rule of RULES) {
    const seen = new Set<string>()
    for (const m of text.matchAll(rule.pattern)) {
      if (seen.has(m[0])) continue
      seen.add(m[0])
      // Try to find the line the match sits on for context.
      const before = text.slice(0, m.index ?? 0)
      const lineStart = before.lastIndexOf("\n") + 1
      const lineEnd = text.indexOf("\n", m.index ?? 0)
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
      hits.push({ rule: rule.name, source, match: m[0], line, remediation: rule.remediation })
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const baseArg = args.find((a) => a.startsWith("--base="))
  const base = baseArg ? baseArg.slice("--base=".length) : "origin/main"

  // altimate_change — bot-review fix: validate --base looks like a git ref
  // (defense in depth on top of the shell-safe git wrapper). Refs allow
  // alnum + `/_.@{}~^-`, so a value containing `$`, backticks, spaces, etc.
  // is definitely not a ref and should be rejected loudly.
  if (!/^[A-Za-z0-9/_.@{}~^-]+$/.test(base)) {
    process.stderr.write(`tracker-leak check: refusing suspicious --base value: ${JSON.stringify(base)}\n`)
    process.exit(2)
  }

  // Bot-review fix: git hands a pre-push hook one line per ref being pushed on
  // stdin (`<local ref> <local sha> <remote ref> <remote sha>`). Scanning HEAD
  // regardless meant `git push origin feature:other` — or pushing any branch
  // that is not the checked-out one — approved refs nobody had looked at.
  // Prefer the pushed tips when stdin gives them; fall back to HEAD otherwise
  // (manual runs, CI).
  const pushed = await readPushedRefs()
  // Distinguish "git handed us refs" from "no stdin" (manual run / CI). A push
  // made up only of deletions yields refs but no tips to scan, and must NOT
  // fall back to HEAD — HEAD is unrelated to the ref being deleted, and would
  // fail a push that adds no content at all.
  if (pushed.hadInput && pushed.tips.length === 0) return
  const tips = pushed.hadInput ? pushed.tips : [{ ref: "HEAD", sha: "HEAD" }]

  // Bot-review fix: an unborn HEAD (freshly `git init`, zero commits) makes
  // `rev-parse --abbrev-ref HEAD` exit 128. Failing loud there contradicted the
  // documented "brand-new repo → silent success" path below, so this one lookup
  // tolerates failure while every other git call still fails hard.
  // altimate_change start — in a pull_request checkout `actions/checkout` lands
  // on the synthetic merge commit in detached HEAD, so `rev-parse --abbrev-ref`
  // yields "HEAD" and the branch-name source — one of the three this script
  // documents — is silently inert. CI exports the real head ref as PR_BRANCH.
  // (bot review: the env var was added to the workflow without this read, so it
  // had no effect at all.)
  const branch =
    process.env.PR_BRANCH?.trim() ||
    (await git(["rev-parse", "--abbrev-ref", "HEAD"], { failOnError: false }))
  // altimate_change end

  const hits: Hit[] = []
  if (pushed.hadInput) {
    // Bot-review fix: scan the ref NAMES being pushed, both ends. The
    // destination is the one that becomes public, and it need not match the
    // source — `git push origin main:refs/heads/<tracker-key>` publishes a
    // tracker-shaped branch while `main` and its contents are perfectly clean.
    // Tags go the same way. Only fall back to the checked-out branch name when
    // git gave us nothing (manual run, CI).
    for (const tip of tips) {
      scanText(tip.ref, `pushed ref name (${tip.ref})`, hits)
      if (tip.remote && tip.remote !== tip.ref) scanText(tip.remote, `destination ref name (${tip.remote})`, hits)
    }
  } else if (branch) {
    scanText(branch, "branch name", hits)
  }
  for (const tip of tips) await scanTip(tip, base, hits)
  reportAndExit(hits)
}

/** One `<local ref> <local sha> <remote ref> <remote sha>` line per pushed ref. */
async function readPushedRefs(): Promise<{
  hadInput: boolean
  tips: Array<{ ref: string; sha: string; remote?: string }>
}> {
  if (process.stdin.isTTY) return { hadInput: false, tips: [] }
  try {
    const raw = await new Response(Bun.stdin.stream()).text()
    const rows = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/))
      .filter((parts) => parts.length >= 2 && /^[0-9a-f]{40}$/i.test(parts[1]))
    return {
      hadInput: rows.length > 0,
      // An all-zero local sha means the ref is being DELETED — no content to scan.
      tips: rows
        .filter((parts) => !/^0{40}$/.test(parts[1]))
        .map((parts) => ({ ref: parts[0], sha: parts[1], remote: parts[2] })),
    }
  } catch {
    return { hadInput: false, tips: [] }
  }
}

async function scanTip(tip: { ref: string; sha: string }, base: string, hits: Hit[]) {
  const mergeBase = await git(["merge-base", tip.sha, base], { failOnError: false })
  if (!mergeBase) {
    // No shared history with base — brand-new repo, or base missing locally
    // (common on a shallow clone). Bot-review fix: say so on stderr instead of
    // exiting silently, so a guard that has disabled itself is visible rather
    // than looking like a clean scan.
    process.stderr.write(
      `tracker-leak check: no merge-base between ${tip.ref} and ${base}; skipping content scan. ` +
        `Fetch the base ref (\`git fetch origin main\`) or pass --base=<ref> to enable it.\n`,
    )
    return
  }

  const ahead = Number(await git(["rev-list", "--count", `${mergeBase}..${tip.sha}`]))
  if (ahead > 0) {
    // 2. Commit messages of local commits
    const messages = await git(["log", `${mergeBase}..${tip.sha}`, "--format=%B%x00"])
    scanText(messages, `${ahead} commit message(s) on ${tip.ref} ahead of ${base}`, hits)

    // 3. Added lines in the pushed diff. `--unified=0` narrows context; only
    //    real content additions count. Every diff line starting with `+`
    //    that is NOT the `+++ b/path` file-header line is added content —
    //    filtering by `!startsWith("+++")` also drops legitimate content
    //    lines beginning with `++` (an added line whose text starts with
    //    two plus signs renders as `+++...` in unified-diff). The safe
    //    filter matches the file header exactly: `+++ ` (with the trailing
    //    space or tab), so content lines whose first non-plus is anything
    //    else — including tracker-shaped strings — still get scanned.
    const diff = await git(["diff", "--unified=0", `${mergeBase}...${tip.sha}`])
    const added = diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++ ") && !l.startsWith("+++\t"))
      .join("\n")
    scanText(added, `${tip.ref}: ${ahead}-commit diff vs ${base} (added lines)`, hits)
  }
}

function reportAndExit(hits: Hit[]) {
  if (hits.length === 0) {
    // Silent on clean runs — pre-push hooks should be quiet on success.
    return
  }

  process.stderr.write("\n\x1b[31m✗ tracker-leak check failed\x1b[0m\n\n")
  process.stderr.write(`This repo is public. Internal tracker references cannot land here.\n\n`)
  const bySource: Record<string, Hit[]> = {}
  for (const h of hits) (bySource[h.source] ??= []).push(h)
  for (const [source, list] of Object.entries(bySource)) {
    process.stderr.write(`  in ${source}:\n`)
    for (const h of list) {
      process.stderr.write(`    - ${h.rule}: \x1b[33m${h.match}\x1b[0m\n`)
      if (h.line && h.line !== h.match) {
        const preview = h.line.length > 100 ? h.line.slice(0, 97) + "..." : h.line
        process.stderr.write(`      line: ${preview}\n`)
      }
    }
    process.stderr.write("\n")
  }
  const uniqueRemediations = new Set(hits.map((h) => h.remediation))
  process.stderr.write("Remediation:\n")
  for (const r of uniqueRemediations) process.stderr.write(`  - ${r}\n`)
  process.stderr.write("\nBypass (emergencies only): SKIP_TRACKER_CHECK=1 git push ...\n\n")
  process.exit(1)
}

// altimate_change — #1052 D8 review-fix (M6 companion): gate side-effectful
// main() so RULES can be imported by the self-test file without triggering a
// scanner run at test-collection time. Bun sets `import.meta.main = true` only
// when this file is the entrypoint.
if (import.meta.main) {
  if (process.env.SKIP_TRACKER_CHECK === "1") {
    process.stderr.write("tracker-leak check skipped via SKIP_TRACKER_CHECK=1\n")
  } else {
    await main()
  }
}
