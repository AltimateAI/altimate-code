/**
 * Adversarial tests for v0.7.2 release.
 *
 * Release content:
 *   1. Install endpoint URL fix: altimate.ai/install -> www.altimate.sh/install
 *      across install script, README, troubleshooting docs, the source fetch in
 *      Installation.upgradeCurl(), and the published GitHub Action.
 *   2. Bounded 15s timeout via AbortSignal.timeout on the upgradeCurl fetch
 *      so a stalled CDN/origin can't hang `altimate upgrade` forever.
 *   3. Friendly error wrapper on upgradeCurl fetch failure — includes URL,
 *      manual re-install one-liner, and GitHub releases fallback URL.
 *   4. GitHub Action (github/action.yml) realigned with v0.7.1 binary rename:
 *      cache + PATH use ~/.altimate/bin (was ~/.altimate-code/bin), binary
 *      invoked as `altimate` (was `altimate-code`).
 *
 * Focus: invariants a support engineer or new release-skill run would want
 * pinned so this class of bug (release-fixes-install, install-is-still-broken)
 * can never recur silently.
 */

import { describe, test, expect } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../../../..")

const INSTALLATION_SRC = readFileSync(
  join(REPO_ROOT, "packages/opencode/src/installation/index.ts"),
  "utf-8",
)
const INSTALL_SCRIPT = readFileSync(join(REPO_ROOT, "install"), "utf-8")
const README = readFileSync(join(REPO_ROOT, "README.md"), "utf-8")
const TROUBLESHOOTING = readFileSync(
  join(REPO_ROOT, "docs/docs/reference/troubleshooting.md"),
  "utf-8",
)
const ACTION_YML = readFileSync(join(REPO_ROOT, "github/action.yml"), "utf-8")

// ---------------------------------------------------------------------------
// 1. Install endpoint URL — broken host eradicated, correct host present
// ---------------------------------------------------------------------------

describe("install endpoint URL — altimate.ai eradication", () => {
  // altimate.ai/install was the v0.7.1-era URL that 404'd against the
  // marketing-site SPA. v0.7.2 swaps it out everywhere. The negative
  // assertions catch any reviewer / merge / refactor that re-introduces it.
  const SURFACES: Array<[string, string]> = [
    ["installation/index.ts", INSTALLATION_SRC],
    ["install (curl script)", INSTALL_SCRIPT],
    ["README.md", README],
    ["troubleshooting.md", TROUBLESHOOTING],
    ["github/action.yml", ACTION_YML],
  ]

  for (const [name, content] of SURFACES) {
    test(`${name} does not reference altimate.ai/install`, () => {
      expect(content).not.toContain("altimate.ai/install")
    })
  }

  // Discord link on the marketing site is intentionally retained — different
  // path, unaffected by the install-site move.
  test("docs/mkdocs.yml altimate.ai/discord remains (intentionally out of scope)", () => {
    const mkdocs = readFileSync(join(REPO_ROOT, "docs/mkdocs.yml"), "utf-8")
    expect(mkdocs).toContain("altimate.ai/discord")
  })
})

describe("install endpoint URL — altimate.sh present and consistent", () => {
  test("source fetches from www.altimate.sh/install via named constant", () => {
    // Tolerate either apex (altimate.sh) or www. The apex is broken today,
    // so the constant uses www., but a future apex-DNS fix can drop the www.
    // without touching this test.
    expect(INSTALLATION_SRC).toMatch(
      /UPGRADE_INSTALL_URL\s*=\s*"https:\/\/(www\.)?altimate\.sh\/install"/,
    )
  })

  test("README and troubleshooting docs use the same host as the source", () => {
    // If the source uses www. but README points users at apex, customers hit
    // the 404. Lock the cross-file consistency at test time.
    const sourceMatch = INSTALLATION_SRC.match(/https:\/\/((?:www\.)?altimate\.sh)\/install/)
    expect(sourceMatch).not.toBeNull()
    const sourceHost = sourceMatch![1]
    expect(README).toContain(`https://${sourceHost}/install`)
    expect(TROUBLESHOOTING).toContain(`https://${sourceHost}/install`)
    expect(INSTALL_SCRIPT).toContain(`https://${sourceHost}/install`)
    expect(ACTION_YML).toContain(`https://${sourceHost}/install`)
  })

  test("install script --help examples both use altimate.sh", () => {
    // Two examples in the --help block; one used to be missed by a previous
    // half-fix where only the first --help example got updated.
    const help = INSTALL_SCRIPT.match(/Examples:[\s\S]*?EOF/)
    expect(help).not.toBeNull()
    expect(help![0]).toMatch(/curl -fsSL https:\/\/(www\.)?altimate\.sh\/install \| bash$/m)
    expect(help![0]).toMatch(/curl -fsSL https:\/\/(www\.)?altimate\.sh\/install \| bash -s --/)
    expect(help![0]).not.toContain("altimate.ai")
  })
})

// ---------------------------------------------------------------------------
// 2. Bounded fetch timeout — present, named, and bounded
// ---------------------------------------------------------------------------

describe("upgradeCurl bounded timeout", () => {
  test("AbortSignal.timeout is wired into the fetch options", () => {
    // Without a timeout the install-script fetch can hang on a stalled CDN.
    // Assert the AbortSignal is passed, separately from the value, so a
    // refactor that extracts the literal does not break this regression.
    expect(INSTALLATION_SRC).toMatch(/AbortSignal\.timeout\(/)
  })

  test("timeout value is a named constant set to 15 seconds", () => {
    expect(INSTALLATION_SRC).toMatch(/UPGRADE_FETCH_TIMEOUT_MS\s*=\s*15_000/)
  })

  test("timeout constant is referenced by upgradeCurl, not duplicated", () => {
    // The reviewer should see the constant in the fetch call site. A
    // double-defined literal would mean someone reverted the named-constant
    // refactor — flag it.
    expect(INSTALLATION_SRC).toMatch(
      /AbortSignal\.timeout\(\s*UPGRADE_FETCH_TIMEOUT_MS\s*\)/,
    )
    const timeoutLiterals = INSTALLATION_SRC.match(/AbortSignal\.timeout\(\s*15_000\s*\)/g)
    expect(timeoutLiterals).toBeNull()
  })

  test("URL constant is referenced by upgradeCurl, not duplicated", () => {
    expect(INSTALLATION_SRC).toMatch(/fetch\(\s*UPGRADE_INSTALL_URL\b/)
  })
})

// ---------------------------------------------------------------------------
// 3. Friendly fetch-failure error — message contains user-recovery surface
// ---------------------------------------------------------------------------

describe("upgradeCurl error surface", () => {
  test("fetch is wrapped in try/catch (raw AbortError must not reach the user)", () => {
    // Locate the try { ... } catch block in upgradeCurl. A future refactor
    // that drops the wrapper would regress to "DOMException: The operation
    // was aborted" reaching the user with no URL, no instructions.
    const upgradeCurlBody = INSTALLATION_SRC.match(
      /async function upgradeCurl[\s\S]*?\n {2}}\n/,
    )
    expect(upgradeCurlBody).not.toBeNull()
    expect(upgradeCurlBody![0]).toMatch(/try\s*{[\s\S]*?fetch\(UPGRADE_INSTALL_URL/)
    expect(upgradeCurlBody![0]).toMatch(/}\s*catch\s*\(\s*err/)
  })

  test("rethrown error names the install URL", () => {
    expect(INSTALLATION_SRC).toContain("Could not download install script from")
  })

  test("rethrown error tells the user how to re-install manually", () => {
    expect(INSTALLATION_SRC).toContain("Re-run the install manually")
    expect(INSTALLATION_SRC).toMatch(/curl -fsSL \$\{UPGRADE_INSTALL_URL\} \| bash/)
  })

  test("rethrown error points at the GitHub releases fallback", () => {
    // If www.altimate.sh is itself down, the user needs an exit ramp. The
    // releases page is the canonical fallback.
    expect(INSTALLATION_SRC).toContain(
      "https://github.com/AltimateAI/altimate-code/releases/latest",
    )
  })

  test("HTTP non-2xx is surfaced as a tagged error, not a bare statusText", () => {
    // `new Error(res.statusText)` produced "Not Found" / "Service Unavailable"
    // with no status code and no URL. The v0.7.2 path includes the numeric
    // status so the rethrown message is "HTTP 404 Not Found", not "Not Found".
    expect(INSTALLATION_SRC).toMatch(/HTTP \$\{res\.status\} \$\{res\.statusText\}/)
  })
})

// ---------------------------------------------------------------------------
// 4. Published GitHub Action — paths and binary name match v0.7.1 rename
// ---------------------------------------------------------------------------

describe("github/action.yml — post-v0.7.1 rename alignment", () => {
  test("Action installs from the new altimate.sh URL", () => {
    expect(ACTION_YML).toMatch(/curl -fsSL https:\/\/(www\.)?altimate\.sh\/install \| bash/)
  })

  test("Action cache path matches the v0.7.1 install directory", () => {
    // v0.7.1 renamed the curl-install directory from ~/.altimate-code/bin to
    // ~/.altimate/bin. A stale cache path would mean every cache miss
    // re-downloads (and a cache hit restores nothing useful).
    expect(ACTION_YML).toContain("path: ~/.altimate/bin")
    expect(ACTION_YML).not.toMatch(/path:\s*~\/\.altimate-code\/bin/)
  })

  test("Action PATH addition matches the install directory", () => {
    expect(ACTION_YML).toContain('echo "$HOME/.altimate/bin" >> $GITHUB_PATH')
    expect(ACTION_YML).not.toContain('echo "$HOME/.altimate-code/bin"')
  })

  test("Action invokes the renamed binary, not the legacy name", () => {
    // v0.7.1 shipped only `altimate` from the curl path. `altimate-code` does
    // not exist on PATH after a curl install; the npm path still has both.
    expect(ACTION_YML).toContain("run: altimate github run")
    expect(ACTION_YML).not.toMatch(/run:\s*altimate-code github run/)
  })

  test("Action and source fetch the install script from the same host", () => {
    // Cross-file consistency: if `altimate upgrade` (source) and the GitHub
    // Action diverge on host, a customer using both paths sees inconsistent
    // behavior.
    const sourceHost = INSTALLATION_SRC.match(/https:\/\/((?:www\.)?altimate\.sh)\/install/)![1]
    expect(ACTION_YML).toContain(`https://${sourceHost}/install`)
  })

  test("Action file exists at github/action.yml (not .github/action.yml)", () => {
    // The published Action MUST be at `github/action.yml` to be referenced as
    // `uses: AltimateAI/altimate-code@vX`. Moving it under `.github/` would
    // silently break every downstream consumer.
    expect(existsSync(join(REPO_ROOT, "github/action.yml"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. altimate_change marker integrity — upstream-shared file invariants
// ---------------------------------------------------------------------------

describe("altimate_change markers around upgradeCurl", () => {
  test("URL + timeout constants live inside an altimate_change block", () => {
    // The marker guard catches unmarked custom code at PR-time, but only if
    // someone re-runs it. Pin the invariant at test time so a refactor that
    // moves the constants outside the block fails CI here, not at the next
    // upstream merge.
    const blockRe =
      /\/\/ altimate_change start[\s\S]*?UPGRADE_INSTALL_URL[\s\S]*?UPGRADE_FETCH_TIMEOUT_MS[\s\S]*?\/\/ altimate_change end/
    expect(INSTALLATION_SRC).toMatch(blockRe)
  })

  test("try/catch wrapper lives inside an altimate_change block", () => {
    const wrapperRe =
      /\/\/ altimate_change start[\s\S]*?try\s*{[\s\S]*?fetch\(UPGRADE_INSTALL_URL[\s\S]*?Could not download install script[\s\S]*?\/\/ altimate_change end/
    expect(INSTALLATION_SRC).toMatch(wrapperRe)
  })

  test("every altimate_change start has a matching end", () => {
    const starts = (INSTALLATION_SRC.match(/altimate_change start/g) ?? []).length
    const ends = (INSTALLATION_SRC.match(/altimate_change end/g) ?? []).length
    expect(starts).toBe(ends)
  })
})

// ---------------------------------------------------------------------------
// 6. Migration safety — v0.7.1 curl users must be able to recover
// ---------------------------------------------------------------------------

describe("v0.7.1 curl-user recovery surface", () => {
  test("troubleshooting doc has install-path section pointing at the new URL", () => {
    // v0.7.1 curl users have a broken `altimate upgrade`. The troubleshooting
    // page must surface the manual one-liner so they can self-heal.
    expect(TROUBLESHOOTING).toMatch(
      /curl -fsSL https:\/\/(www\.)?altimate\.sh\/install \| bash/,
    )
  })

  test("README curl one-liner matches the source-side install URL", () => {
    // If README says X and the binary fetches Y, a user reading both sees a
    // contradiction. Lock them in sync.
    const sourceHost = INSTALLATION_SRC.match(/https:\/\/((?:www\.)?altimate\.sh)\/install/)![1]
    expect(README).toContain(`curl -fsSL https://${sourceHost}/install | bash`)
  })
})

// ---------------------------------------------------------------------------
// 7. CHANGELOG entry — release skill's own backstop
// ---------------------------------------------------------------------------

describe("CHANGELOG entry for v0.7.2", () => {
  const CHANGELOG = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf-8")

  test("CHANGELOG has a 0.7.2 section above 0.7.1", () => {
    // Skill rule: changelog must be updated before the tag. If this test
    // fails, the release commit was made without updating CHANGELOG.md.
    const idx072 = CHANGELOG.indexOf("## [0.7.2]")
    const idx071 = CHANGELOG.indexOf("## [0.7.1]")
    expect(idx072).toBeGreaterThan(-1)
    expect(idx071).toBeGreaterThan(idx072)
  })
})
