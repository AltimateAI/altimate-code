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
    // The prefix here is ~/.local, so packages land in ~/.local/lib/node_modules — NOT
    // ~/.local/bin, which holds only the shim. That is why keeping the `.local/bin`
    // standalone branch is safe: the two can never collide on execPath.
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
    ["standalone, distro-resolved ~/.local/bin", "/home/u/.local/bin/altimate", "curl"],
    // scoop/choco deliberately resolve to "unknown": upgrade()/uninstall still reference the
    // upstream `opencode` package, so an actionable answer here would install or remove a
    // DIFFERENT package. Notify-only until those commands carry Altimate identities.
    ["scoop", "C:\\Users\\u\\scoop\\apps\\altimate-code\\current\\altimate.exe", "unknown"],
    ["choco", "C:\\ProgramData\\chocolatey\\lib\\altimate-code\\tools\\altimate.exe", "unknown"],
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
    expect(resolveInstall("/home/u/.altimate/bin/altimate", {}).binDir).toBe("/home/u/.altimate/bin")
  })

  // Review findings on #1306 — layouts that contain a package segment but are NOT a
  // global install. Attributing them to a manager would make upgrade() run `install -g`
  // and CREATE a global install the user never had (automatically, for patch releases).
  test("an npx cache invocation is not attributed to npm", () => {
    expect(
      resolveInstall(
        "/home/u/.npm/_npx/a1b2c3/node_modules/@altimateai/altimate-code-linux-x64/bin/altimate-code",
        {},
      ).method,
    ).toBe("unknown")
  })

  test("a package-manager download cache is not attributed to a manager", () => {
    expect(
      resolveInstall(
        "/home/u/.bun/install/cache/@altimateai/altimate-code-linux-x64/bin/altimate-code",
        {},
      ).method,
    ).toBe("unknown")
  })

  test("yarn classic on Windows is yarn, not npm", () => {
    // %LOCALAPPDATA%\Yarn\config\global — the unix `.yarn` / `yarn/global` spellings do
    // not cover it, and falling through to npm would `npm install -g` over a yarn install.
    expect(
      resolveInstall(
        "C:\\Users\\u\\AppData\\Local\\Yarn\\config\\global\\node_modules\\@altimateai\\altimate-code-win32-x64\\bin\\altimate-code.exe",
        {},
      ).method,
    ).toBe("yarn")
  })

  test("a standalone binary in ~/.local/bin is still a curl install (#820 back-compat)", () => {
    // Kept deliberately: it is a distro-resolved standalone location and is what
    // test/sanity/Dockerfile installs to. Safe because the node_modules match runs first —
    // see the npm-under-~/.local case above, which resolves to npm rather than here.
    expect(resolveInstall("/home/u/.local/bin/altimate", {}).method).toBe("curl")
    expect(resolveInstall("/home/u/.local/bin/altimate", {}).binDir).toBe("/home/u/.local/bin")
  })
})
