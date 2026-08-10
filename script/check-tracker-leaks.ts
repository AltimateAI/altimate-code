#!/usr/bin/env bun
/**
 * Scans the local diff, branch name, and commit messages against `origin/main`
 * for internal-tracker references that must not land on this public repo:
 *
 *   - Bare Jira keys of the form `AI-<digits>` (project prefix).
 *   - The internal Atlassian instance host `altimateai.atlassian.net`.
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

const RULES = [
  {
    name: "Jira ticket key (AI-<digits>)",
    pattern: /\bAI-\d+\b/g,
    remediation: "Rename branch / rewrite commit / delete text. Track work via GitHub issues on AltimateAI/altimate-code.",
  },
  {
    name: "Atlassian instance URL",
    pattern: /\baltimateai\.atlassian\.net\b/g,
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

async function shOK(cmd: string): Promise<string> {
  try {
    const r = await $`sh -c ${cmd}`.quiet()
    return r.text().trim()
  } catch {
    return ""
  }
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

  const branch = await shOK("git rev-parse --abbrev-ref HEAD")
  const mergeBase = await shOK(`git merge-base HEAD ${base}`)
  if (!mergeBase) {
    // No shared history with base — either brand-new repo or base doesn't exist locally.
    // Silent success: nothing to check.
    return
  }

  const ahead = Number(await shOK(`git rev-list --count ${mergeBase}..HEAD`))
  const hits: Hit[] = []

  // 1. Branch name
  scanText(branch, "branch name", hits)

  if (ahead > 0) {
    // 2. Commit messages of local commits
    const messages = await shOK(`git log ${mergeBase}..HEAD --format=%B%x00`)
    scanText(messages, `${ahead} commit message(s) ahead of ${base}`, hits)

    // 3. Added lines in the pushed diff. `--unified=0` narrows context; grep for
    //    added lines keeps the check focused on new content, not unmodified surroundings.
    const diff = await shOK(`git diff --unified=0 ${mergeBase}...HEAD`)
    const added = diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .join("\n")
    scanText(added, `${ahead}-commit diff vs ${base} (added lines)`, hits)
  }

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

if (process.env.SKIP_TRACKER_CHECK === "1") {
  process.stderr.write("tracker-leak check skipped via SKIP_TRACKER_CHECK=1\n")
} else {
  await main()
}
