/**
 * Install resolution (#1305).
 *
 * `resolveInstall()` answers "which install produced THIS process", replacing a
 * substring test on execPath plus a probe loop that asked each package manager
 * whether it had the package at all. The second question picks arbitrarily when more
 * than one install exists, which is the common case once a user has tried both the
 * curl installer and npm.
 *
 * These cases are table-driven over fabricated paths because the real layouts cannot
 * be created on a test machine.
 */
import { describe, test, expect } from "bun:test"
import { resolveInstall, type Method } from "../../src/installation"

const NPM_PREFIXED = "/usr/local/lib/node_modules/@altimateai/altimate-code"
const PLATFORM = "node_modules/@altimateai/altimate-code-darwin-arm64/bin/altimate-code"

describe("resolveInstall", () => {
  const cases: Array<[string, string, Method]> = [
    // The npm bin/altimate shim spawns the PLATFORM package, so execPath is the nested
    // platform binary rather than the wrapper — detection must match the -<os>-<arch> suffix.
    ["npm, default prefix", `${NPM_PREFIXED}/${PLATFORM}`, "npm"],
    // Regression: this is the layout the old `.local/bin` rule misread as "curl", which
    // made `altimate upgrade` run `curl | bash` and orphan the npm install.
    [
      "npm, prefix set to ~/.local",
      "/home/u/.local/lib/node_modules/@altimateai/altimate-code/node_modules/@altimateai/altimate-code-linux-x64/bin/altimate-code",
      "npm",
    ],
    [
      "pnpm, virtual store layout",
      "/home/u/.local/share/pnpm/global/5/.pnpm/@altimateai+altimate-code@0.11.2/node_modules/@altimateai/altimate-code-linux-x64/bin/altimate-code",
      "pnpm",
    ],
    [
      "pnpm, plain global link layout",
      "/home/u/.local/share/pnpm/global/5/node_modules/@altimateai/altimate-code-linux-x64/bin/altimate-code",
      "pnpm",
    ],
    [
      "bun global",
      "/home/u/.bun/install/global/node_modules/@altimateai/altimate-code-linux-x64/bin/altimate-code",
      "bun",
    ],
    ["yarn global", "/home/u/.yarn/global/node_modules/@altimateai/altimate-code-linux-x64/bin/altimate-code", "yarn"],
    // Homebrew bin entries are symlinks into Cellar; realpath lands there. Matching the
    // Cellar segment (not the prefix) keeps /usr/local from colliding with npm.
    ["brew, apple silicon", "/opt/homebrew/Cellar/altimate-code/0.11.2/bin/altimate", "brew"],
    ["brew, intel prefix", "/usr/local/Cellar/altimate-code/0.11.2/bin/altimate", "brew"],
    ["standalone install", "/home/u/.altimate/bin/altimate", "curl"],
    ["standalone, pre-v0.7.1 dir", "/home/u/.opencode/bin/altimate", "curl"],
    ["scoop", "C:\\Users\\u\\scoop\\apps\\altimate-code\\current\\altimate.exe", "scoop"],
    ["choco", "C:\\ProgramData\\chocolatey\\lib\\altimate-code\\tools\\altimate.exe", "choco"],
    // A dev build or an unrecognised location must not be attributed to a package
    // manager — "unknown" degrades to notify-only rather than running someone else's
    // installer over it.
    ["dev build", "/tmp/build/dist/altimate", "unknown"],
  ]

  for (const [name, execPath, expected] of cases) {
    test(`${name} -> ${expected}`, () => {
      expect(resolveInstall(execPath, {}).method).toBe(expected)
    })
  }

  test("a pinned ALTIMATE_CODE_BIN_PATH is never attributed to an installer", () => {
    // The shim honours this ahead of everything else, so the running binary is whatever
    // the user pointed at. Auto-upgrading it would overwrite a deliberate choice.
    const env = { ALTIMATE_CODE_BIN_PATH: "/somewhere/custom/altimate" }
    expect(resolveInstall(`${NPM_PREFIXED}/${PLATFORM}`, env).method).toBe("unknown")
  })

  test("standalone resolution reports the directory the upgrade would write", () => {
    expect(resolveInstall("/home/u/.altimate/bin/altimate", {}).root).toBe("/home/u/.altimate/bin")
  })

  test("a plain user bin directory is not a standalone install", () => {
    // `.local/bin` on its own carries no information about who installed the binary.
    expect(resolveInstall("/home/u/.local/bin/altimate", {}).method).toBe("unknown")
  })
})
