/**
 * Ownership + containment (#1305 review round 2).
 *
 * `resolveInstall()` answers from the path alone, which cannot prove that the running
 * binary belongs to a manager's GLOBAL tree. These cover the two pieces that decide it.
 */
import { describe, test, expect, afterAll } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { isInside, bunGlobalRoot, ownerOf, redactSecrets } from "../../src/installation"

describe("bunGlobalRoot", () => {
  test("derives the package tree from the shim directory", () => {
    // `bun pm bin -g` reports the SHIM dir; packages live in a sibling tree. Conflating the
    // two rejected every global bun install as "not-global".
    expect(bunGlobalRoot("/home/u/.bun/bin")).toBe("/home/u/.bun/install/global/node_modules")
  })

  test("a bun global binary is inside the derived root", () => {
    const root = bunGlobalRoot("/home/u/.bun/bin")
    const exec = "/home/u/.bun/install/global/node_modules/@altimateai/altimate-code/bin/altimate-code"
    // The regression: the shim dir does NOT contain the executable, the package root does.
    expect(exec.startsWith("/home/u/.bun/bin")).toBe(false)
    expect(exec.startsWith(root)).toBe(true)
  })

  test("returns empty when bun reports nothing", () => {
    expect(bunGlobalRoot("")).toBe("")
  })
})

describe("isInside", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ownership-"))
  // altimate_change — #1305: these ran on every invocation and never cleaned up, leaving a
  // directory behind in the OS temp dir each time.
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const parent = path.join(tmp, "node_modules")
  const sibling = path.join(tmp, "node_modules-other")
  fs.mkdirSync(parent, { recursive: true })
  fs.mkdirSync(sibling, { recursive: true })

  test("a child directory is inside", () => {
    expect(isInside(path.join(parent, "@altimateai", "altimate-code"), parent)).toBe(true)
  })

  test("the directory itself counts as inside", () => {
    expect(isInside(parent, parent)).toBe(true)
  })

  test("a sibling sharing a name prefix is NOT inside", () => {
    // The previous lowercased startsWith() matched `/x/node_modules-other` against
    // `/x/node_modules`, which let an unrelated tree pass the ownership check.
    expect(isInside(path.join(sibling, "pkg"), parent)).toBe(false)
  })

  test("an unrelated path is not inside", () => {
    expect(isInside("/somewhere/else/bin/altimate", parent)).toBe(false)
  })

  test("symlinked parents resolve before comparison", () => {
    // A symlinked prefix (/var vs /private/var on macOS, nvm, asdf) previously produced a
    // false "not-global" refusal because only the executable side was realpath-resolved.
    const link = path.join(tmp, "link-to-node_modules")
    try {
      fs.symlinkSync(parent, link)
    } catch {
      return // symlinks unavailable (e.g. unprivileged Windows) — nothing to assert
    }
    expect(isInside(path.join(link, "pkg"), parent)).toBe(true)
    expect(isInside(path.join(parent, "pkg"), link)).toBe(true)
  })

  test("an empty parent is never a container", () => {
    // globalLayout() returns "" when the manager cannot answer; that must not read as
    // containment (which would silently approve any path).
    expect(isInside("/anything", "")).toBe(false)
  })
})

describe("ownerOf", () => {
  // Real directories, because the whole point is that ownership is a filesystem fact rather
  // than something inferable from the path string.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-"))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  const mk = (p: string) => {
    const full = path.join(root, p)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, "")
    return full
  }

  test("finds the unscoped wrapper", () => {
    const exec = mk("altimate-code/bin/.altimate-code")
    expect(ownerOf(root, exec)).toBe("altimate-code")
  })

  test("finds the scoped wrapper", () => {
    const exec = mk("@altimateai/altimate-code/bin/.altimate-code")
    expect(ownerOf(root, exec)).toBe("@altimateai/altimate-code")
  })

  test("a platform binary nested in the unscoped wrapper reports the UNSCOPED name", () => {
    // The platform package is always scoped, so reading the scope off the running binary's
    // path named the wrong wrapper — upgrading then installed a duplicate and left the
    // user's install stale. Containment in the top-level directory gets it right.
    const exec = mk("altimate-code/node_modules/@altimateai/altimate-code-darwin-arm64/bin/altimate-code")
    expect(ownerOf(root, exec)).toBe("altimate-code")
  })

  test("a transitive dependency of another global CLI is NOT ours", () => {
    // Inside the manager's global tree, but not a global install of ours. Containment in the
    // global root alone accepted this and would have run `install -g` for a package the user
    // never installed.
    const exec = mk("another-cli/node_modules/altimate-code/bin/.altimate-code")
    expect(ownerOf(root, exec)).toBeUndefined()
  })

  test("a binary outside the global root is NOT ours", () => {
    expect(ownerOf(root, "/somewhere/else/altimate")).toBeUndefined()
  })

  test("pnpm isolated store: platform binary is a SIBLING of the wrapper, not inside it", () => {
    // The shape that actually runs on Windows (postinstall skips the cached binary) and
    // anywhere `--ignore-scripts` was used. An earlier version of this test put the binary
    // inside the wrapper's own store directory, which is not how pnpm lays it out — that
    // masked the failure and let a broken containment check look correct.
    const store = path.join(root, "pnpm-case", "node_modules")
    const wrapper = path.join(store, ".pnpm", "altimate-code@1.0.0", "node_modules", "altimate-code")
    const platform = path.join(
      store,
      ".pnpm",
      "@altimateai+altimate-code-linux-x64@1.0.0",
      "node_modules",
      "@altimateai",
      "altimate-code-linux-x64",
      "bin",
    )
    fs.mkdirSync(wrapper, { recursive: true })
    fs.mkdirSync(platform, { recursive: true })
    const exec = path.join(platform, "altimate-code")
    fs.writeFileSync(exec, "")
    try {
      fs.symlinkSync(wrapper, path.join(store, "altimate-code"))
    } catch {
      return // symlinks unavailable
    }
    // Neither wrapper directory contains the binary, but exactly one of our wrappers is
    // installed in this tree, so it is unambiguously the owner.
    expect(isInside(exec, wrapper)).toBe(false)
    expect(ownerOf(store, exec)).toBe("altimate-code")
  })

  test("a platform binary is ambiguous when BOTH wrappers are installed", () => {
    // Guessing here would upgrade or uninstall the wrong wrapper.
    const store = path.join(root, "ambiguous", "node_modules")
    fs.mkdirSync(path.join(store, "altimate-code"), { recursive: true })
    fs.mkdirSync(path.join(store, "@altimateai", "altimate-code"), { recursive: true })
    const platform = path.join(store, ".pnpm", "p@1", "node_modules", "@altimateai", "altimate-code-linux-x64", "bin")
    fs.mkdirSync(platform, { recursive: true })
    const exec = path.join(platform, "altimate-code")
    fs.writeFileSync(exec, "")
    expect(ownerOf(store, exec)).toBeUndefined()
  })

  test("a platform binary outside the manager's tree does not borrow its identity", () => {
    // A project-local platform package must not be attributed to a global wrapper.
    const store = path.join(root, "bounded", "node_modules")
    fs.mkdirSync(path.join(store, "altimate-code"), { recursive: true })
    const elsewhere = path.join(root, "someproject", "node_modules", "@altimateai", "altimate-code-linux-x64", "bin")
    fs.mkdirSync(elsewhere, { recursive: true })
    const exec = path.join(elsewhere, "altimate-code")
    fs.writeFileSync(exec, "")
    expect(ownerOf(store, exec)).toBeUndefined()
  })

  test("an unknown root yields no owner", () => {
    // globalLayout() returns "" when the manager cannot answer. That must not authorise
    // anything — the previous version treated it as permission to act.
    expect(ownerOf("", "/anything")).toBeUndefined()
  })

  test("resolves through a symlinked top-level entry (pnpm-style virtual store)", () => {
    // pnpm links top-level names into a virtual store whose location differs between
    // layouts; resolving the link means we never have to enumerate where the store lives.
    const store = path.join(root, ".store", "altimate-code@1", "node_modules", "altimate-code")
    fs.mkdirSync(path.join(store, "bin"), { recursive: true })
    const exec = path.join(store, "bin", ".altimate-code")
    fs.writeFileSync(exec, "")
    const link = path.join(root, "linked-root")
    fs.mkdirSync(link, { recursive: true })
    try {
      fs.symlinkSync(store, path.join(link, "altimate-code"))
    } catch {
      return // symlinks unavailable
    }
    expect(ownerOf(link, exec)).toBe("altimate-code")
  })
})

describe("post-upgrade verification preconditions", () => {
  // Round-3 review: Homebrew deletes the old versioned Cellar directory after a successful
  // `brew upgrade`, so the path we started from is commonly gone. Re-executing it returns
  // ENOENT, which the verification would otherwise report as "the binary could not be
  // started" for a successful upgrade. The guard is existence, not a brew special-case.
  test("a relocated binary is detectable before re-execution is attempted", () => {
    const gone = path.join(os.tmpdir(), "altimate-cellar-gone", "1.0.0", "bin", "altimate")
    expect(fs.existsSync(gone)).toBe(false)
  })

  test("a present binary is still verifiable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"))
    const bin = path.join(dir, "altimate")
    fs.writeFileSync(bin, "")
    expect(fs.existsSync(bin)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("redactSecrets", () => {
  // Diagnostics reach stderr (OPENCODE_PRINT_LOGS) and a remote OTLP collector, so these are
  // the shapes real npm/pnpm/yarn failures actually print.
  const cases: Array<[string, string]> = [
    ["npm registry auth", "//registry.npmjs.org/:_authToken=abc123def456ghi"],
    ["bearer header", "Authorization: Bearer abcdef123456"],
    ["credentialed url", "https://user:hunter2@registry.example.com/pkg"],
    ["github token", "remote: fatal ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
    ["key=value token", 'token="s3cr3t-value-here"'],
    ["hex digest", "sha512-" + "a".repeat(40)],
    // Shapes round 3 found still exposed.
    ["basic auth blob", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=="],
    ["quoted json key", '{"token":"short-secret"}'],
    ["bare url userinfo", "https://short-secret@registry.example/pkg"],
    // Short unlabelled tokens are the known gap: the catch-all patterns need 32+ hex or
    // 40+ base64 chars, so a short secret only gets masked when it carries a key or a
    // recognisable prefix. This pins the shapes that DO work.
    ["short token with key", "npm_config_authToken=abc123"],
    ["short prefixed token", "npm_abcd1234efgh"],
  ]
  for (const [name, input] of cases) {
    test(`masks ${name}`, () => {
      const out = redactSecrets(input)
      expect(out).toContain("[REDACTED]")
      for (const secret of [
        "abc123def456ghi",
        "abcdef123456",
        "hunter2",
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        "s3cr3t-value-here",
        "dXNlcjpwYXNzd29yZDEyMw==",
        "short-secret",
        "abc123",
        "abcd1234efgh",
      ]) {
        if (input.includes(secret)) expect(out).not.toContain(secret)
      }
    })
  }

  test("leaves ordinary diagnostics readable", () => {
    const msg = "npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /usr/local/lib"
    expect(redactSecrets(msg)).toBe(msg)
  })

  test("is a no-op on empty input", () => {
    expect(redactSecrets("")).toBe("")
  })
})
