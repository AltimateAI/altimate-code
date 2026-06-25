/**
 * Carry-forward regression guard: the `altimate-code` brand identity survived
 * the OpenCode v1.17.9 upstream merge.
 *
 * Branding is a PROVEN merge-leak hazard — the bridge merge reverted the
 * GitHub-App identity block to upstream and it had to be re-applied (carries an
 * `upstream_fix` marker). These tests assert the brand resolves to Altimate
 * Code, not OpenCode, in the load-bearing user-facing files.
 */
import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import packageJson from "../../../package.json"
import { GITHUB_APP_INSTALL_URL } from "../../../src/cli/cmd/github.handler"

const ROOT = join(import.meta.dir, "..", "..", "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

describe("carry-forward: branding resolves to Altimate Code", () => {
  test("package identity is @altimateai/altimate-code with altimate-code bin", () => {
    expect(packageJson.name).toBe("@altimateai/altimate-code")
    expect(Object.keys(packageJson.bin)).toContain("altimate-code")
    expect(packageJson.name).not.toBe("opencode")
  })

  test("GitHub App identity is the altimate-code-agent app, not upstream", () => {
    expect(GITHUB_APP_INSTALL_URL).toBe("https://github.com/apps/altimate-code-agent/installations/new")
    expect(GITHUB_APP_INSTALL_URL).toContain("altimate-code-agent")
    expect(GITHUB_APP_INSTALL_URL).not.toContain("opencode")
  })

  test("github handler carries the branded agent username + workflow file", () => {
    const src = read("src/cli/cmd/github.handler.ts")
    expect(src).toContain('AGENT_USERNAME = "altimate-code-agent[bot]"')
    expect(src).toContain(".github/workflows/altimate-code.yml")
  })

  test("install / upgrade URL constants point at altimate.sh, not opencode.ai", () => {
    const src = read("src/installation/index.ts")
    // The resolved constant values must be the branded altimate.sh endpoints.
    expect(src).toMatch(/UPGRADE_INSTALL_URL = "https:\/\/www\.altimate\.sh\/install"/)
    expect(src).toMatch(/UPGRADE_INSTALL_PS_URL = "https:\/\/www\.altimate\.sh\/install\.ps1"/)
    // No constant should be assigned an opencode.ai install URL (an explanatory
    // comment may still mention upstream's, so we match assignments, not text).
    expect(src).not.toMatch(/=\s*"https?:\/\/[^"]*opencode\.ai\/install/)
  })

  test("config paths prefer the branded .altimate-code dir (with .opencode fallback)", () => {
    const src = read("src/config/paths.ts")
    expect(src).toContain(".altimate-code")
    // .opencode survives only as a back-compat fallback, in the same target list
    expect(src).toMatch(/\.altimate-code["'],\s*["']\.opencode/)
  })

  test("release lookups target the AltimateAI/altimate-code repo", () => {
    const src = read("src/installation/index.ts")
    expect(src).toContain("AltimateAI/altimate-code")
    expect(src).not.toContain("sst/opencode")
  })

  test("no upstream package name leak in package.json", () => {
    const raw = read("package.json")
    expect(raw).not.toContain('"name": "opencode"')
  })
})
