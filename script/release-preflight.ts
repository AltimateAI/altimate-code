#!/usr/bin/env bun
/**
 * Release Preflight — deterministic gate for `/release` and `/release-beta`.
 *
 * Replaces LLM-improvised release judgment calls with objective, scriptable
 * checks. Born from the 2026-07-22 release retro: three straight
 * releases (v0.8.10, v0.9.1, v0.9.2) each hit at least one of these failure
 * modes live — a stale local tag that nearly published a 2641-commit-divergent
 * artifact, releasing with HEAD behind origin/main, an unmerged prerelease line
 * turning into a 17-hour merge side-quest, and marker-guard violations
 * surfacing one at a time across 7 serial fix rounds.
 *
 * Usage:
 *   bun script/release-preflight.ts --version 0.9.3 --stage pre
 *   bun script/release-preflight.ts --version 0.9.3 --stage tag
 *   bun script/release-preflight.ts --version 0.9.3-beta.1 --stage pre --allow-prerelease
 *
 * Exit codes:
 *   0 — all checks PASS (WARN/SKIP allowed)
 *   1 — at least one check FAILed
 */

import { parseArgs } from "util"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Pure helpers — semver + tag-selection logic. No git/npm/gh calls in here so
// they can be unit tested deterministically (see release-preflight.test.ts).
// ---------------------------------------------------------------------------

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

/** Strip a leading "v" from a version/tag string. */
export function normalizeVersion(input: string): string {
  return input.startsWith("v") || input.startsWith("V") ? input.slice(1) : input
}

/**
 * Parse a normalized (no leading "v") SemVer string into its components.
 * Follows semver.org rules (minus build metadata): no leading zeros in
 * numeric identifiers, no empty prerelease identifiers. Returns null if the
 * string isn't valid SemVer (major.minor.patch[-prerelease]).
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/

export function parseSemver(version: string): Semver | null {
  const m = SEMVER_RE.exec(version)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  }
}

/**
 * Compare two dot-separated prerelease strings per SemVer precedence:
 * numeric identifiers compare numerically (so beta.10 > beta.2), numeric <
 * alphanumeric, and a shorter identifier list is lower when it's a prefix.
 */
function comparePrerelease(a: string, b: string): number {
  const as = a.split(".")
  const bs = b.split(".")
  const len = Math.min(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const an = /^\d+$/.test(as[i])
    const bn = /^\d+$/.test(bs[i])
    if (an && bn) {
      const diff = Number(as[i]) - Number(bs[i])
      if (diff !== 0) return diff
    } else if (an !== bn) {
      return an ? -1 : 1 // numeric < alphanumeric
    } else if (as[i] !== bs[i]) {
      return as[i] < bs[i] ? -1 : 1
    }
  }
  return as.length - bs.length
}

/**
 * Compare two parsed SemVer values. Returns <0 if a<b, 0 if equal, >0 if a>b.
 * A stable version is always greater than any prerelease of the same
 * major.minor.patch, and prerelease identifiers follow SemVer precedence
 * (numeric-aware, so `beta.10` > `beta.2`).
 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1 // stable > prerelease
  if (b.prerelease === null) return -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** True if the tag name matches a stable release tag: v<major>.<minor>.<patch>. */
export function isStableTagName(tag: string): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)
}

/**
 * Replicates release.yml's PREV_TAG selection:
 *   git tag --merged HEAD --sort=-version:refname
 *     | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'
 *     | grep -vx "$CURRENT_TAG"
 *     | head -1
 *
 * Takes the raw (unsorted, unfiltered) list of tags already known to be
 * merged into HEAD — the git call that produces that list belongs in main(),
 * not here — and picks the greatest stable tag STRICTLY LOWER than the
 * target. Excluding only equality is not enough: if upstream history is ever
 * merged, fork-inherited tags like v1.18.3 would otherwise beat the real
 * previous release for a v0.9.x target.
 */
export function selectPrevTag(mergedTags: string[], currentTag: string): string | null {
  const target = parseSemver(normalizeVersion(currentTag))
  const parsed = mergedTags
    .filter((t) => isStableTagName(t) && t !== currentTag)
    .map((tag) => ({ tag, v: parseSemver(normalizeVersion(tag)) }))
    .filter((x): x is { tag: string; v: Semver } => x.v !== null)
    .filter((x) => target === null || compareSemver(x.v, target) < 0)
  parsed.sort((a, b) => compareSemver(b.v, a.v)) // descending
  return parsed.length > 0 ? parsed[0].tag : null
}

/**
 * Filter tags to the "prerelease line" for a given major.minor: tags of the
 * shape vMAJOR.MINOR.PATCH-anything. Used by the ancestry check — releasing
 * v0.9.1 must first confirm every v0.9.*-beta.* tag merged into origin/main.
 */
export function prereleaseLineTags(allTags: string[], major: number, minor: number): string[] {
  const re = new RegExp(`^v${major}\\.${minor}\\.[0-9]+-.+$`)
  return allTags.filter((t) => re.test(t))
}

// ---------------------------------------------------------------------------
// Thin runner — every external process call goes through here so main()
// stays readable and the pure logic above stays untestable-process-free.
// ---------------------------------------------------------------------------

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function repoRoot(): string {
  return path.resolve(__dirname, "..")
}

/** Run a command, never throwing — callers inspect `.code`. */
function run(cmd: string[]): RunResult {
  try {
    const proc = Bun.spawnSync(cmd, {
      cwd: repoRoot(),
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      code: proc.exitCode ?? 1,
      stdout: proc.stdout ? proc.stdout.toString("utf-8").trim() : "",
      stderr: proc.stderr ? proc.stderr.toString("utf-8").trim() : "",
    }
  } catch (e) {
    // Missing binary (ENOENT) and similar spawn failures land here.
    return { code: 127, stdout: "", stderr: `${cmd[0]}: not found (${e instanceof Error ? e.message : String(e)})` }
  }
}

function git(args: string[]): RunResult {
  return run(["git", ...args])
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"

type Status = "PASS" | "FAIL" | "WARN" | "SKIP"

interface CheckResult {
  name: string
  status: Status
  detail: string
}

const STATUS_COLOR: Record<Status, string> = {
  PASS: GREEN,
  FAIL: RED,
  WARN: YELLOW,
  SKIP: DIM,
}

function printCheck(result: CheckResult): void {
  const color = STATUS_COLOR[result.status]
  console.log(`  ${color}${BOLD}${result.status.padEnd(4)}${RESET}  ${BOLD}${result.name}${RESET}`)
  for (const line of result.detail.split("\n")) {
    if (line.length > 0) console.log(`        ${DIM}${line}${RESET}`)
  }
}

function banner(text: string): void {
  const line = "─".repeat(70)
  console.log(`\n${CYAN}${line}${RESET}`)
  console.log(`${CYAN}  ${BOLD}${text}${RESET}`)
  console.log(`${CYAN}${line}${RESET}\n`)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
  ${BOLD}Release Preflight${RESET} — deterministic gate for /release and /release-beta

  ${BOLD}USAGE${RESET}
    bun script/release-preflight.ts --version <X.Y.Z> --stage <pre|tag> [--allow-prerelease]

  ${BOLD}OPTIONS${RESET}
    --version <X.Y.Z|vX.Y.Z>   Target release version (required)
    --stage <pre|tag>          pre: HEAD must equal fresh origin/main (default)
                                tag: origin/main must be an ancestor of HEAD
    --allow-prerelease         Permit a "-beta.N" target (for /release-beta)
    --help, -h                 Show this help message

  ${BOLD}EXIT CODES${RESET}
    0  all checks PASS (WARN/SKIP allowed)
    1  at least one check FAILed
`)
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      version: { type: "string" },
      stage: { type: "string", default: "pre" },
      "allow-prerelease": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  }) as { values: Record<string, any> }

  if (args.help) {
    printUsage()
    process.exit(0)
  }

  if (!args.version) {
    console.error(`${RED}error${RESET} --version is required (e.g. --version 0.9.3)`)
    printUsage()
    process.exit(1)
  }

  const stage = args.stage === "tag" ? "tag" : "pre"
  const allowPrerelease = Boolean(args["allow-prerelease"])
  const rawVersion: string = args.version
  const version = normalizeVersion(rawVersion)
  const targetTag = `v${version}`

  banner(`Release Preflight — ${targetTag} (stage: ${stage})`)

  const results: CheckResult[] = []
  const add = (r: CheckResult) => {
    results.push(r)
    printCheck(r)
  }

  // ── 1. fetch ──────────────────────────────────────────────────────────────
  const fetchResult = git(["fetch", "origin", "main", "--tags"])
  if (fetchResult.code !== 0) {
    add({ name: "fetch", status: "FAIL", detail: `git fetch origin main --tags failed:\n${fetchResult.stderr}` })
  } else {
    add({ name: "fetch", status: "PASS", detail: "origin/main + tags fetched" })
  }

  // ── 2. clean worktree ────────────────────────────────────────────────────
  const statusResult = git(["status", "--porcelain"])
  const statusLines = statusResult.stdout.split("\n").filter((l) => l.length > 0)
  const tracked = statusLines.filter((l) => !l.startsWith("??"))
  const untracked = statusLines.filter((l) => l.startsWith("??"))
  if (tracked.length > 0) {
    add({
      name: "clean worktree",
      status: "FAIL",
      detail: `tracked modifications/staged changes present:\n${tracked.join("\n")}`,
    })
  } else if (untracked.length > 0) {
    add({
      name: "clean worktree",
      status: "WARN",
      detail: `untracked files present (will not be committed):\n${untracked.join("\n")}`,
    })
  } else {
    add({ name: "clean worktree", status: "PASS", detail: "no tracked or untracked changes" })
  }

  // ── 3. base ──────────────────────────────────────────────────────────────
  const headSha = git(["rev-parse", "HEAD"]).stdout
  const originMainSha = git(["rev-parse", "origin/main"]).stdout
  if (stage === "pre") {
    if (headSha && originMainSha && headSha === originMainSha) {
      add({ name: "base", status: "PASS", detail: `HEAD == origin/main (${headSha})` })
    } else {
      add({
        name: "base",
        status: "FAIL",
        detail: `HEAD (${headSha || "unknown"}) != origin/main (${originMainSha || "unknown"}) — stage 'pre' requires exact equality`,
      })
    }
  } else {
    const ancestor = git(["merge-base", "--is-ancestor", "origin/main", "HEAD"])
    if (ancestor.code === 0) {
      add({
        name: "base",
        status: "PASS",
        detail: `origin/main (${originMainSha}) is an ancestor of HEAD (${headSha}) — stage 'tag' allows local release commits ahead`,
      })
    } else {
      add({
        name: "base",
        status: "FAIL",
        detail: `origin/main (${originMainSha || "unknown"}) is NOT an ancestor of HEAD (${headSha || "unknown"})`,
      })
    }
  }

  // ── 4. tag collision (fail closed, never delete) ────────────────────────
  {
    const localTag = git(["rev-parse", "-q", "--verify", `refs/tags/${targetTag}`])
    const localExists = localTag.code === 0 && localTag.stdout.length > 0
    const remoteLs = git(["ls-remote", "origin", `refs/tags/${targetTag}`])
    const remoteExists = remoteLs.code === 0 && remoteLs.stdout.trim().length > 0

    if (!localExists && !remoteExists) {
      add({ name: "tag collision", status: "PASS", detail: `${targetTag} does not exist locally or on origin` })
    } else {
      const parts: string[] = []
      if (localExists) {
        const sha = localTag.stdout
        const info = git(["log", "-1", "--format=%aI %s", sha])
        parts.push(`LOCAL ${targetTag} -> ${sha} (${info.stdout || "unknown date/subject"})`)
      }
      if (remoteExists) {
        const remoteSha = remoteLs.stdout.split("\t")[0]
        parts.push(`REMOTE origin/${targetTag} -> ${remoteSha}`)
      }
      parts.push(
        `${targetTag} already exists — resolve explicitly (inspect what it points to, decide whether to ` +
          `retarget or pick a different version). This script will never delete a tag for you.`,
      )
      add({ name: "tag collision", status: "FAIL", detail: parts.join("\n") })
    }
  }

  // ── 5. version sanity ────────────────────────────────────────────────────
  {
    const parsed = parseSemver(version)
    if (!parsed) {
      add({ name: "version sanity", status: "FAIL", detail: `"${rawVersion}" is not valid SemVer (X.Y.Z[-prerelease])` })
    } else if (parsed.prerelease && !allowPrerelease) {
      add({
        name: "version sanity",
        status: "FAIL",
        detail: `"${version}" is a prerelease — pass --allow-prerelease for /release-beta targets`,
      })
    } else {
      const npmView = run(["npm", "view", "@altimateai/altimate-code", "version"])
      if (npmView.code !== 0) {
        // Fail closed: without the registry we cannot verify monotonicity or
        // that the version is unpublished — deferring that failure to the
        // irreversible release workflow is exactly the wrong place for it.
        add({
          name: "version sanity",
          status: "FAIL",
          detail: `could not reach npm to verify version state — retry when the registry is reachable:\n${npmView.stderr || npmView.stdout}`,
        })
      } else {
        const currentLatest = npmView.stdout.trim()
        const currentParsed = parseSemver(normalizeVersion(currentLatest))
        const alreadyPublished = run(["npm", "view", `@altimateai/altimate-code@${version}`, "version"])
        const isPublished = alreadyPublished.code === 0 && alreadyPublished.stdout.trim().length > 0
        // Fail closed: a non-zero exit only means "not published" when npm
        // says so (E404). The first `npm view` succeeded, so the registry is
        // reachable — any other error here is unknown state, not a green light.
        const publishCheckInconclusive =
          alreadyPublished.code !== 0 && !/E404|404 Not Found/i.test(alreadyPublished.stderr + alreadyPublished.stdout)

        if (publishCheckInconclusive) {
          add({
            name: "version sanity",
            status: "FAIL",
            detail: `could not determine whether @altimateai/altimate-code@${version} is already published (npm error was not E404):\n${alreadyPublished.stderr || alreadyPublished.stdout}`,
          })
        } else if (isPublished) {
          add({
            name: "version sanity",
            status: "FAIL",
            detail: `@altimateai/altimate-code@${version} is already published on npm`,
          })
        } else if (!currentParsed) {
          add({
            name: "version sanity",
            status: "FAIL",
            detail: `could not parse current npm 'latest' version "${currentLatest}" — cannot verify monotonicity`,
          })
        } else if (compareSemver(parsed, currentParsed) <= 0) {
          add({
            name: "version sanity",
            status: "FAIL",
            detail: `${version} is not strictly greater than current npm latest (${currentLatest})`,
          })
        } else if (parsed.prerelease) {
          // A prerelease target must also move the `beta` dist-tag forward —
          // being greater than stable `latest` is not enough. Publishing
          // 0.10.0-beta.4 while `beta` points at 0.10.0-beta.5 would move new
          // beta installs BACKWARD.
          const distTags = run(["npm", "view", "@altimateai/altimate-code", "dist-tags", "--json"])
          let betaCurrent: string | null = null
          if (distTags.code === 0) {
            try {
              betaCurrent = (JSON.parse(distTags.stdout) as Record<string, string>).beta ?? null
            } catch {
              betaCurrent = null
            }
          }
          const betaParsed = betaCurrent ? parseSemver(normalizeVersion(betaCurrent)) : null
          if (distTags.code !== 0) {
            add({
              name: "version sanity",
              status: "FAIL",
              detail: `could not read npm dist-tags to compare against the current beta channel:\n${distTags.stderr || distTags.stdout}`,
            })
          } else if (betaParsed && compareSemver(parsed, betaParsed) <= 0) {
            add({
              name: "version sanity",
              status: "FAIL",
              detail: `${version} is not strictly greater than the current beta dist-tag (${betaCurrent}) — new beta installs would move backward`,
            })
          } else {
            add({
              name: "version sanity",
              status: "PASS",
              detail: `${version} > latest (${currentLatest})${betaCurrent ? ` and > beta (${betaCurrent})` : "; no beta dist-tag"}; not yet published; prerelease allowed`,
            })
          }
        } else {
          add({
            name: "version sanity",
            status: "PASS",
            detail: `${version} > current latest (${currentLatest}); not yet published; stable`,
          })
        }
      }
    }
  }

  // ── 6. prerelease ancestry (scoped to target release line) ──────────────
  {
    const parsed = parseSemver(version)
    if (!parsed) {
      add({ name: "prerelease ancestry", status: "SKIP", detail: "skipped — target version failed to parse" })
    } else {
      const allTagsResult = git(["tag", "--list"])
      const allTags = allTagsResult.stdout.split("\n").filter((t) => t.length > 0)
      const lineTags = prereleaseLineTags(allTags, parsed.major, parsed.minor).filter((t) => t !== targetTag)

      if (lineTags.length === 0) {
        add({
          name: "prerelease ancestry",
          status: "PASS",
          detail: `no v${parsed.major}.${parsed.minor}.*-* prerelease tags exist for this release line`,
        })
      } else {
        // Check ancestry against HEAD (the release candidate), not origin/main:
        // for /release, HEAD equals or descends from origin/main so the result
        // is the same, and for /release-beta cutting beta.N+1 from a branch,
        // the beta.N tag is an ancestor of HEAD but not of origin/main —
        // checking origin/main would wrongly block every branch beta.
        const offenders: string[] = []
        for (const tag of lineTags) {
          const ancestor = git(["merge-base", "--is-ancestor", tag, "HEAD"])
          if (ancestor.code !== 0) offenders.push(tag)
        }
        if (offenders.length === 0) {
          add({
            name: "prerelease ancestry",
            status: "PASS",
            detail: `all ${lineTags.length} prerelease tag(s) for v${parsed.major}.${parsed.minor}.* are ancestors of HEAD:\n${lineTags.join(", ")}`,
          })
        } else {
          add({
            name: "prerelease ancestry",
            status: "FAIL",
            detail: `prerelease tag(s) NOT in this release candidate's history — merge before releasing this line:\n${offenders.join("\n")}`,
          })
        }
      }
    }
  }

  // ── 7. release-blocker PRs ───────────────────────────────────────────────
  {
    const gh = run([
      "gh",
      "pr",
      "list",
      "--repo",
      "AltimateAI/altimate-code",
      "--label",
      "release-blocker",
      "--state",
      "open",
      "--json",
      "number,title",
    ])
    const ghMissing = gh.code !== 0 && /not found|ENOENT|no such file/i.test(gh.stderr)
    if (ghMissing) {
      add({ name: "release-blocker PRs", status: "WARN", detail: `gh CLI not installed — cannot check release-blocker PRs:\n${gh.stderr}` })
    } else if (gh.code !== 0) {
      // gh exists but errored (auth, network, bad label…) — fail closed, we
      // cannot claim there are no blockers.
      add({ name: "release-blocker PRs", status: "FAIL", detail: `gh errored — blocker state unknown:\n${gh.stderr || gh.stdout}` })
    } else {
      let prs: { number: number; title: string }[] | null = null
      try {
        prs = JSON.parse(gh.stdout || "[]")
      } catch {
        prs = null
      }
      if (prs === null) {
        add({ name: "release-blocker PRs", status: "FAIL", detail: `could not parse gh output — blocker state unknown:\n${gh.stdout}` })
      } else if (prs.length > 0) {
        add({
          name: "release-blocker PRs",
          status: "FAIL",
          detail: prs.map((p) => `#${p.number} ${p.title}`).join("\n"),
        })
      } else {
        add({ name: "release-blocker PRs", status: "PASS", detail: "no open release-blocker PRs" })
      }
    }
  }

  // ── 8. PREV_TAG dry-run ──────────────────────────────────────────────────
  {
    const mergedResult = git(["tag", "--merged", "HEAD", "--sort=-version:refname"])
    const mergedTags = mergedResult.stdout.split("\n").filter((t) => t.length > 0)
    const prevTag = selectPrevTag(mergedTags, targetTag)

    const allTagsResult = git(["tag", "--list"])
    const anyStableTagExists = allTagsResult.stdout
      .split("\n")
      .filter((t) => t.length > 0)
      .some(isStableTagName)

    if (prevTag) {
      add({
        name: "PREV_TAG dry-run",
        status: "PASS",
        detail: `release notes will diff against ${prevTag} (compare: ${prevTag}...${targetTag})`,
      })
    } else if (anyStableTagExists) {
      add({
        name: "PREV_TAG dry-run",
        status: "FAIL",
        detail:
          `no previous tag found merged into HEAD, but stable tags exist in the repo — ` +
          `release notes would silently omit history (the v0.9.1 bug). Check for a diverged HEAD ` +
          `or an unmerged release branch.`,
      })
    } else {
      add({ name: "PREV_TAG dry-run", status: "PASS", detail: "no stable tags exist yet — initial release, no previous tag" })
    }
  }

  // ── 9. marker guard ──────────────────────────────────────────────────────
  {
    const guard = run(["bun", "run", "script/upstream/analyze.ts", "--markers", "--base", "origin/main", "--strict"])
    const fullOutput = [guard.stdout, guard.stderr].filter((s) => s.length > 0).join("\n")
    if (guard.code !== 0) {
      add({ name: "marker guard", status: "FAIL", detail: fullOutput || `exited ${guard.code} with no output` })
    } else if (/falling back to pattern-based detection/i.test(fullOutput)) {
      // analyze.ts exits 0 on this fallback, but without the upstream remote
      // it only pattern-matches packages/opencode/src/ and can miss unmarked
      // changes in other upstream-owned packages. A release machine must have
      // the real remote — fail closed.
      // altimate_change start — the operator instruction below names the
      // upstream repo URL so a release engineer can wire the remote up. The
      // branding-audit LEAK_PATTERNS flag this as an upstream reference; it
      // is legitimate operational text (an actionable fix hint for the
      // failing check), not accidental branding drift. Contained in an
      // altimate_change block so the audit skips it.
      add({
        name: "marker guard",
        status: "FAIL",
        detail: `upstream remote unavailable — guard ran in degraded pattern-only mode, coverage incomplete.\nAdd it: git remote add upstream https://github.com/anomalyco/opencode.git && git fetch upstream --no-tags\n${fullOutput}`,
      })
      // altimate_change end
    } else {
      add({ name: "marker guard", status: "PASS", detail: fullOutput || "no unmarked upstream-shared changes" })
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────
  banner("Summary")
  const width = Math.max(...results.map((r) => r.name.length)) + 2
  for (const r of results) {
    console.log(`  ${STATUS_COLOR[r.status]}${BOLD}${r.status.padEnd(4)}${RESET}  ${r.name.padEnd(width)}`)
  }
  console.log()

  const failed = results.filter((r) => r.status === "FAIL")
  const warned = results.filter((r) => r.status === "WARN")
  console.log(
    `  ${GREEN}${results.length - failed.length - warned.length} PASS/SKIP${RESET}, ${YELLOW}${warned.length} WARN${RESET}, ${RED}${failed.length} FAIL${RESET}`,
  )
  console.log()

  if (failed.length > 0) {
    console.error(`${RED}${BOLD}Preflight FAILED${RESET} — resolve the FAIL check(s) above before releasing.`)
    process.exit(1)
  }

  console.log(`${GREEN}${BOLD}Preflight PASSED${RESET}${warned.length > 0 ? ` (with ${warned.length} warning(s))` : ""}.`)
}

// Guard CLI execution when imported as a module (e.g., by tests).
if (import.meta.main) {
  main().catch((e) => {
    console.error(`${RED}error${RESET} preflight crashed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
