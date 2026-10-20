/**
 * The standalone installers expose `altimate-code` beside `altimate`, the same
 * pair of names npm, Homebrew and AUR ship. These run the real bash installer
 * through its `--binary` path (no network) against a throwaway HOME. install.ps1
 * gets source-level checks here and execution in test/windows/install.Tests.ps1.
 */
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import os from "os"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const INSTALL_SH_PATH = join(REPO_ROOT, "install")
const INSTALL_PS1 = readFileSync(join(REPO_ROOT, "install.ps1"), "utf-8")
const testUnlessWindows = process.platform === "win32" ? test.skip : test

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(os.tmpdir(), "install-alias-home-"))
  try {
    fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// The shims both Windows installers write; install.ps1's Install-Alias and the bash
// installer's write_windows_shims must produce exactly these bytes.
const CMD_SHIM = '@echo off\r\n"%~dp0altimate.exe" %*\r\nexit /b %ERRORLEVEL%\r\n'
const SH_SHIM_LINES = [
  "#!/bin/sh",
  'case "$(uname -s)" in',
  '  MINGW*|MSYS*|CYGWIN*) exec "$(dirname "$0")/altimate.exe" "$@" ;;',
  "esac",
  'echo "altimate-code: this is the Windows build; it runs only from Git Bash, MSYS or Cygwin" >&2',
  "exit 127",
]
const SH_SHIM = SH_SHIM_LINES.join("\n") + "\n"

function runInstaller(home: string, binaryName = "altimate", pathPrefix = "") {
  const src = join(home, "src")
  mkdirSync(src, { recursive: true })
  const fakeBin = join(src, binaryName)
  writeFileSync(fakeBin, '#!/bin/sh\necho fake-altimate "$@"\n', { mode: 0o755 })
  const res = spawnSync("bash", [INSTALL_SH_PATH, "--binary", fakeBin, "--no-modify-path"], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, "data"),
      GITHUB_ACTIONS: "",
      PATH: `${pathPrefix}${process.env.PATH}`,
    },
  })
  return { code: res.status ?? -1, stderr: res.stderr ?? "", bin: join(home, ".altimate", "bin") }
}

// A `uname` that reports Git Bash, so the installer takes its Windows path on any host.
function gitBashUname(dir: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "uname"), '#!/bin/sh\n[ "$1" = "-m" ] && echo x86_64 || echo MINGW64_NT-10.0-19045\n', {
    mode: 0o755,
  })
  return dir
}

// An offline release: a curl stub whose release-exists probe gets 200, whose download
// gets a local archive of `binary`, and for which checksums.txt is missing (the installer
// then skips verification). Returns the directory holding the stub.
function offlineRelease(home: string, binary: string) {
  const stubs = join(home, "stubs")
  const pkg = join(home, "pkg")
  mkdirSync(stubs, { recursive: true })
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, "altimate"), binary, { mode: 0o755 })
  // Linux releases ship .tar.gz, every other target .zip (see `archive_ext` in install).
  const archive = join(home, "release")
  const pack =
    process.platform === "linux"
      ? spawnSync("tar", ["-czf", archive, "-C", pkg, "altimate"])
      : spawnSync("zip", ["-q", archive, "altimate"], { cwd: pkg })
  expect(pack.status).toBe(0)
  writeFileSync(
    join(stubs, "curl"),
    [
      "#!/bin/sh",
      'out=""; prev=""',
      'for a in "$@"; do',
      '  [ "$a" = "-w" ] && { echo 200; exit 0; }',
      '  [ "$prev" = "-o" ] && out="$a"; prev="$a"',
      "done",
      `[ -n "$out" ] && exec cp "${archive}${process.platform === "linux" ? "" : ".zip"}" "$out"`,
      "exit 22",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return stubs
}

describe("install — altimate-code alias, executed", () => {
  testUnlessWindows("installs altimate-code as a relative link to altimate that runs it", () => {
    withHome((home) => {
      const { code, bin, stderr } = runInstaller(home)
      expect(stderr).not.toMatch(/syntax error|command not found/)
      expect(code).toBe(0)
      const alias = join(bin, "altimate-code")
      expect(lstatSync(alias).isSymbolicLink()).toBe(true)
      expect(readlinkSync(alias)).toBe("altimate")
      const run = spawnSync(alias, ["--version"], { encoding: "utf-8" })
      expect(run.stdout.trim()).toBe("fake-altimate --version")
    })
  })

  testUnlessWindows("replaces a stale altimate-code binary instead of leaving it on PATH", () => {
    withHome((home) => {
      const bin = join(home, ".altimate", "bin")
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, "altimate-code"), "#!/bin/sh\necho stale\n", { mode: 0o755 })
      const { code } = runInstaller(home)
      expect(code).toBe(0)
      expect(lstatSync(join(bin, "altimate-code")).isSymbolicLink()).toBe(true)
      expect(spawnSync(join(bin, "altimate-code"), [], { encoding: "utf-8" }).stdout.trim()).toBe("fake-altimate")
    })
  })

  testUnlessWindows("re-running the installer keeps a single working alias", () => {
    withHome((home) => {
      expect(runInstaller(home).code).toBe(0)
      const { code, bin } = runInstaller(home)
      expect(code).toBe(0)
      expect(readlinkSync(join(bin, "altimate-code"))).toBe("altimate")
    })
  })

  testUnlessWindows("replaces a link to a directory without writing into that directory", () => {
    withHome((home) => {
      const bin = join(home, ".altimate", "bin")
      const elsewhere = join(home, "elsewhere")
      mkdirSync(bin, { recursive: true })
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, join(bin, "altimate-code"))
      const { code } = runInstaller(home)
      expect(code).toBe(0)
      expect(readlinkSync(join(bin, "altimate-code"))).toBe("altimate")
      expect(readdirSync(elsewhere)).toEqual([])
    })
  })

  testUnlessWindows("the already-installed exit still adds the alias", () => {
    withHome((home) => {
      const bin = join(home, ".altimate", "bin")
      const stubs = join(home, "stubs")
      mkdirSync(bin, { recursive: true })
      mkdirSync(stubs)
      writeFileSync(join(bin, "altimate"), "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 })
      // The release-exists probe is the only network call on a pinned version.
      writeFileSync(join(stubs, "curl"), "#!/bin/sh\necho 200\n", { mode: 0o755 })
      const res = spawnSync("bash", [INSTALL_SH_PATH, "--version", "9.9.9", "--no-modify-path"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: join(home, "data"),
          GITHUB_ACTIONS: "",
          PATH: `${stubs}:${bin}:${process.env.PATH}`,
        },
      })
      expect(res.stdout).toContain("already installed")
      expect(res.status).toBe(0)
      expect(readlinkSync(join(bin, "altimate-code"))).toBe("altimate")
    })
  })

  testUnlessWindows("the already-installed exit leaves the alias alone when the match is elsewhere on PATH", () => {
    withHome((home) => {
      const bin = join(home, ".altimate", "bin")
      const other = join(home, "other")
      const stubs = join(home, "stubs")
      mkdirSync(bin, { recursive: true })
      mkdirSync(other)
      mkdirSync(stubs)
      // The matching version comes from another install earlier on PATH; the standalone
      // binary is older, so an alias to it would run a different version.
      writeFileSync(join(other, "altimate"), "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 })
      writeFileSync(join(bin, "altimate"), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 })
      writeFileSync(join(stubs, "curl"), "#!/bin/sh\necho 200\n", { mode: 0o755 })
      const res = spawnSync("bash", [INSTALL_SH_PATH, "--version", "9.9.9", "--no-modify-path"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: join(home, "data"),
          GITHUB_ACTIONS: "",
          PATH: `${stubs}:${other}:${bin}:${process.env.PATH}`,
        },
      })
      expect(res.stdout).toContain("already installed")
      expect(res.status).toBe(0)
      expect(existsSync(join(bin, "altimate-code"))).toBe(false)
    })
  })

  testUnlessWindows("the already-installed exit matches the install dir through a symlinked PATH entry", () => {
    withHome((home) => {
      const bin = join(home, ".altimate", "bin")
      const stubs = join(home, "stubs")
      const linkedBin = join(home, "linked-bin")
      mkdirSync(bin, { recursive: true })
      mkdirSync(stubs)
      symlinkSync(bin, linkedBin)
      writeFileSync(join(bin, "altimate"), "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 })
      writeFileSync(join(stubs, "curl"), "#!/bin/sh\necho 200\n", { mode: 0o755 })
      const res = spawnSync("bash", [INSTALL_SH_PATH, "--version", "9.9.9", "--no-modify-path"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: join(home, "data"),
          GITHUB_ACTIONS: "",
          PATH: `${stubs}:${linkedBin}/:${process.env.PATH}`,
        },
      })
      expect(res.stdout).toContain("already installed")
      expect(res.status).toBe(0)
      expect(readlinkSync(join(bin, "altimate-code"))).toBe("altimate")
    })
  })

  testUnlessWindows("a downloaded release gets the alias", () => {
    withHome((home) => {
      const stubs = offlineRelease(home, '#!/bin/sh\necho downloaded "$@"\n')
      const res = spawnSync("bash", [INSTALL_SH_PATH, "--version", "0.0.0-alias-test", "--no-modify-path"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: join(home, "data"),
          GITHUB_ACTIONS: "",
          PATH: `${stubs}:${process.env.PATH}`,
        },
      })
      expect(res.stderr).not.toMatch(/syntax error|command not found/)
      expect(res.status).toBe(0)
      const alias = join(home, ".altimate", "bin", "altimate-code")
      expect(readlinkSync(alias)).toBe("altimate")
      expect(spawnSync(alias, ["--version"], { encoding: "utf-8" }).stdout.trim()).toBe("downloaded --version")
    })
  })

  testUnlessWindows("re-running --binary on the installed file itself restores the alias", () => {
    withHome((home) => {
      const { bin } = runInstaller(home)
      rmSync(join(bin, "altimate-code"))
      const res = spawnSync("bash", [INSTALL_SH_PATH, "--binary", join(bin, "altimate"), "--no-modify-path"], {
        encoding: "utf-8",
        env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data"), GITHUB_ACTIONS: "" },
      })
      expect(res.stdout).toContain("Source and destination are the same file")
      expect(res.status).toBe(0)
      expect(readlinkSync(join(bin, "altimate-code"))).toBe("altimate")
    })
  })

  testUnlessWindows("under Git Bash it writes the install.ps1 shims instead of copying the binary", () => {
    withHome((home) => {
      const uname = gitBashUname(join(home, "uname"))
      const bin = join(home, ".altimate", "bin")
      mkdirSync(bin, { recursive: true })
      // An older Git Bash install left a full copy here; PATHEXT would put it before the .cmd.
      writeFileSync(join(bin, "altimate-code.exe"), "stale copy", { mode: 0o755 })
      const { code, stderr } = runInstaller(home, "altimate.exe", `${uname}:`)
      expect(stderr).not.toMatch(/syntax error|command not found/)
      expect(code).toBe(0)
      expect(readFileSync(join(bin, "altimate-code.cmd"), "utf-8")).toBe(CMD_SHIM)
      expect(readFileSync(join(bin, "altimate-code"), "utf-8")).toBe(SH_SHIM)
      // Cygwin keeps POSIX modes, so the sh shim must carry the execute bit itself.
      expect(lstatSync(join(bin, "altimate-code")).mode & 0o111).toBe(0o111)
      expect(existsSync(join(bin, "altimate-code.exe"))).toBe(false)
    })
  })

  testUnlessWindows("the sh shim forwards only under Git Bash and refuses elsewhere, e.g. WSL", () => {
    withHome((home) => {
      const uname = gitBashUname(join(home, "uname"))
      const { bin } = runInstaller(home, "altimate.exe", `${uname}:`)
      const shim = join(bin, "altimate-code")
      const underGitBash = spawnSync("sh", [shim, "a b", "--version"], {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${uname}:${process.env.PATH}` },
      })
      expect(underGitBash.stdout.trim()).toBe("fake-altimate a b --version")
      const elsewhere = spawnSync("sh", [shim, "--version"], { encoding: "utf-8" })
      expect(elsewhere.status).toBe(127)
      expect(elsewhere.stdout).toBe("")
    })
  })

  testUnlessWindows("in WSL the Windows install on PATH does not pass for an installed Linux build", () => {
    withHome((home) => {
      // The Windows install as WSL sees it: install.ps1's shims beside an altimate.exe
      // that reports the same version the Linux installer is about to install.
      const windowsHome = join(home, "windows")
      const uname = gitBashUname(join(home, "uname"))
      const { bin: windowsBin } = runInstaller(windowsHome, "altimate.exe", `${uname}:`)
      writeFileSync(join(windowsBin, "altimate.exe"), "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 })
      const stubs = offlineRelease(home, '#!/bin/sh\necho linux "$@"\n')
      const res = spawnSync("bash", [INSTALL_SH_PATH, "--version", "9.9.9", "--no-modify-path"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: join(home, "data"),
          GITHUB_ACTIONS: "",
          // System dirs only, so no `altimate` installed on the host answers the probe first.
          PATH: `${stubs}:${windowsBin}:/usr/bin:/bin`,
        },
      })
      expect(res.stdout).not.toContain("already installed")
      expect(res.status).toBe(0)
      const alias = join(home, ".altimate", "bin", "altimate-code")
      expect(readlinkSync(alias)).toBe("altimate")
      expect(spawnSync(alias, ["--version"], { encoding: "utf-8" }).stdout.trim()).toBe("linux --version")
    })
  })

  testUnlessWindows("a Windows binary gets an altimate-code.exe alias", () => {
    withHome((home) => {
      const { code, bin } = runInstaller(home, "altimate.exe")
      expect(code).toBe(0)
      expect(readlinkSync(join(bin, "altimate-code.exe"))).toBe("altimate.exe")
    })
  })

  testUnlessWindows("leaves a real directory at the alias path alone and still installs", () => {
    withHome((home) => {
      const bin = join(home, ".altimate", "bin")
      mkdirSync(join(bin, "altimate-code"), { recursive: true })
      const { code, stderr } = runInstaller(home)
      expect(stderr).not.toMatch(/syntax error|command not found/)
      expect(code).toBe(0)
      expect(lstatSync(join(bin, "altimate-code")).isDirectory()).toBe(true)
      expect(readdirSync(join(bin, "altimate-code"))).toEqual([])
      expect(existsSync(join(bin, "altimate"))).toBe(true)
    })
  })

  testUnlessWindows("a --binary with an unrelated name gets no alias", () => {
    withHome((home) => {
      const { code, bin } = runInstaller(home, "altimate-dev")
      expect(code).toBe(0)
      expect(existsSync(join(bin, "altimate-dev"))).toBe(true)
      expect(existsSync(join(bin, "altimate-code"))).toBe(false)
    })
  })
})

describe("install.ps1 — altimate-code alias", () => {
  // Install-Alias itself is executed by test/windows/install.Tests.ps1; this pins its call sites.
  test("installs the alias after the binary and on the already-installed exit", () => {
    const calls = [...INSTALL_PS1.matchAll(/^\s*Install-Alias -Dir \$InstallDir\s*$/gm)].map((m) => m.index!)
    expect(calls.length).toBe(2)
    const alreadyInstalled = INSTALL_PS1.indexOf("already installed")
    const exitAfter = INSTALL_PS1.slice(alreadyInstalled).search(/^\s*exit 0\b/m) + alreadyInstalled
    expect(calls[0]).toBeGreaterThan(alreadyInstalled)
    expect(calls[0]).toBeLessThan(exitAfter)
    expect(calls[1]).toBeGreaterThan(INSTALL_PS1.indexOf("Install-Target -Baseline:$true"))
    // The already-installed alias is only for a match found in $InstallDir itself.
    const guard = INSTALL_PS1.indexOf("if (Test-PathInDir -Path $probe -Dir $InstallDir) {")
    expect(guard).toBeGreaterThan(alreadyInstalled)
    expect(guard).toBeLessThan(calls[0])
  })

  test("writes the same sh shim lines as the bash installer", () => {
    for (const line of SH_SHIM_LINES) expect(INSTALL_PS1).toContain(`'${line}'`)
  })
})
