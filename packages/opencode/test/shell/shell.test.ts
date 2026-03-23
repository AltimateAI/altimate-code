import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Shell } from "../../src/shell/shell"

describe("Shell.acceptable: blacklist enforcement", () => {
  let savedShell: string | undefined

  beforeEach(() => {
    savedShell = process.env.SHELL
    // Reset the lazy caches so each test starts fresh
    Shell.acceptable.reset()
    Shell.preferred.reset()
  })

  afterEach(() => {
    if (savedShell !== undefined) {
      process.env.SHELL = savedShell
    } else {
      delete process.env.SHELL
    }
    Shell.acceptable.reset()
    Shell.preferred.reset()
  })

  test("returns SHELL when set to bash", () => {
    process.env.SHELL = "/bin/bash"
    expect(Shell.acceptable()).toBe("/bin/bash")
  })

  test("returns SHELL when set to zsh", () => {
    process.env.SHELL = "/usr/bin/zsh"
    expect(Shell.acceptable()).toBe("/usr/bin/zsh")
  })

  test("rejects fish and returns fallback", () => {
    process.env.SHELL = "/usr/bin/fish"
    const result = Shell.acceptable()
    expect(result).not.toBe("/usr/bin/fish")
    // Fallback should be a real shell path
    expect(result.length).toBeGreaterThan(0)
  })

  test("rejects nu (nushell) and returns fallback", () => {
    process.env.SHELL = "/usr/bin/nu"
    const result = Shell.acceptable()
    expect(result).not.toBe("/usr/bin/nu")
    expect(result.length).toBeGreaterThan(0)
  })

  test("shell containing 'nu' in name but not basename is not blacklisted", () => {
    // /opt/menu/bin/bash — basename is "bash", not "nu"
    process.env.SHELL = "/opt/nushell/bin/bash"
    expect(Shell.acceptable()).toBe("/opt/nushell/bin/bash")
  })

  test("returns fallback when SHELL is unset", () => {
    delete process.env.SHELL
    const result = Shell.acceptable()
    expect(result.length).toBeGreaterThan(0)
    // On Linux/macOS, fallback should be a valid shell path
    expect(result).toMatch(/\/(bash|zsh|sh|cmd\.exe)$/)
  })
})

describe("Shell.preferred: no blacklist filtering", () => {
  let savedShell: string | undefined

  beforeEach(() => {
    savedShell = process.env.SHELL
    Shell.preferred.reset()
  })

  afterEach(() => {
    if (savedShell !== undefined) {
      process.env.SHELL = savedShell
    } else {
      delete process.env.SHELL
    }
    Shell.preferred.reset()
  })

  test("returns SHELL even when blacklisted (fish)", () => {
    process.env.SHELL = "/usr/bin/fish"
    expect(Shell.preferred()).toBe("/usr/bin/fish")
  })

  test("returns SHELL even when blacklisted (nu)", () => {
    process.env.SHELL = "/usr/bin/nu"
    expect(Shell.preferred()).toBe("/usr/bin/nu")
  })

  test("returns fallback when SHELL is unset", () => {
    delete process.env.SHELL
    const result = Shell.preferred()
    expect(result.length).toBeGreaterThan(0)
  })
})
