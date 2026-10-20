import { describe, expect, test } from "bun:test"
import { installerSiblingFiles, removeFileCommand } from "../../src/cli/cmd/uninstall"

describe("uninstall — installer files beside the binary", () => {
  test("names the alias next to a standalone unix install", () => {
    expect(installerSiblingFiles("/home/u/.altimate/bin/altimate", "linux")).toEqual([
      "/home/u/.altimate/bin/altimate-code",
      // `install --binary altimate.exe` links this name on any OS
      "/home/u/.altimate/bin/altimate-code.exe",
    ])
  })

  test("names every Windows alias form next to altimate.exe", () => {
    expect(installerSiblingFiles("C:\\Users\\u\\.altimate\\bin\\altimate.exe", "win32")).toEqual([
      "C:\\Users\\u\\.altimate\\bin\\altimate.exe.old",
      "C:\\Users\\u\\.altimate\\bin\\altimate-code.cmd",
      "C:\\Users\\u\\.altimate\\bin\\altimate-code",
      "C:\\Users\\u\\.altimate\\bin\\altimate-code.exe",
      "C:\\Users\\u\\.altimate\\bin\\altimate-code.exe.old",
    ])
  })

  test("names the canonical binary when running from a copied alias", () => {
    expect(installerSiblingFiles("C:\\Users\\u\\.altimate\\bin\\ALTIMATE-CODE.EXE", "win32")).toEqual([
      "C:\\Users\\u\\.altimate\\bin\\altimate.exe",
      "C:\\Users\\u\\.altimate\\bin\\altimate.exe.old",
      "C:\\Users\\u\\.altimate\\bin\\altimate-code.cmd",
      "C:\\Users\\u\\.altimate\\bin\\altimate-code",
      "C:\\Users\\u\\.altimate\\bin\\altimate-code.exe.old",
    ])
  })

  test("matches a differently cased install dir on Windows", () => {
    expect(installerSiblingFiles("C:\\Users\\u\\.ALTIMATE\\BIN\\altimate.exe", "win32")).toContain(
      "C:\\Users\\u\\.ALTIMATE\\BIN\\altimate-code.cmd",
    )
  })

  test("matches the running name case-sensitively on POSIX", () => {
    expect(installerSiblingFiles("/home/u/.altimate/bin/ALTIMATE", "linux")).toEqual([
      "/home/u/.altimate/bin/altimate",
      "/home/u/.altimate/bin/altimate-code",
      "/home/u/.altimate/bin/altimate-code.exe",
    ])
  })

  test("names nothing outside the installers' own directory", () => {
    expect(installerSiblingFiles("/home/u/.local/bin/altimate", "linux")).toEqual([])
    expect(installerSiblingFiles("/home/u/.opencode/bin/altimate", "linux")).toEqual([])
    expect(installerSiblingFiles("/home/u/.altimate/not-bin/altimate", "linux")).toEqual([])
  })
})

describe("uninstall — removal commands", () => {
  test("Windows gets a PowerShell command that runs where install.ps1 does", () => {
    expect(removeFileCommand("C:\\Users\\u\\.altimate\\bin\\altimate-code.cmd", "win32", true)).toBe(
      "Remove-Item -LiteralPath 'C:\\Users\\u\\.altimate\\bin\\altimate-code.cmd' -Force",
    )
    expect(removeFileCommand("C:\\Users\\u\\.altimate\\bin\\altimate.exe", "win32")).toBe(
      "Remove-Item -LiteralPath 'C:\\Users\\u\\.altimate\\bin\\altimate.exe' -Force",
    )
  })

  test("POSIX keeps rm, with -f only when asked", () => {
    expect(removeFileCommand("/home/u/.altimate/bin/altimate", "linux")).toBe("rm '/home/u/.altimate/bin/altimate'")
    expect(removeFileCommand("/home/u/.altimate/bin/altimate-code", "darwin", true)).toBe(
      "rm -f '/home/u/.altimate/bin/altimate-code'",
    )
  })

  test("a path with $, backticks or quotes stays literal in either shell", () => {
    expect(removeFileCommand("/home/o'neil $dev `x`/.altimate/bin/altimate", "linux")).toBe(
      "rm '/home/o'\\''neil $dev `x`/.altimate/bin/altimate'",
    )
    expect(removeFileCommand("C:\\Users\\o'neil $dev\\.altimate\\bin\\altimate.exe", "win32")).toBe(
      "Remove-Item -LiteralPath 'C:\\Users\\o''neil $dev\\.altimate\\bin\\altimate.exe' -Force",
    )
  })
})
