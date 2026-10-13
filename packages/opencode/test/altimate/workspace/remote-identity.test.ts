// altimate_change - new file
// The client's port of the workspace service's remote rule, and the
// comparisons built on it.
//
// fixtures/remote-identity-vectors.json is the service's own output for each
// input: `canonical` from its canonicalization, `unify` from its host
// unification applied to the raw input, `unified` from the two in sequence.
import { describe, expect, test } from "bun:test"
import vectors from "./fixtures/remote-identity-vectors.json"
import {
  canonicalRepoRemote,
  projectIdentity,
  publicRepoKey,
  sameIdentifier,
  sameProjectIdentity,
  sameRepoRemote,
  unifyPublicHost,
} from "../../../src/altimate/workspace/remote-identity"

const rows = vectors as { input: string; canonical: string; unify: string; unified: string }[]

describe("parity with the workspace service", () => {
  test("the fixture covers the forms that matter", () => {
    const inputs = new Set(rows.map((r) => r.input))
    for (const input of [
      "git@github.com:Acme/X.git",
      "ssh://git@ssh.github.com:443/Acme/X.git",
      "https://www.github.com/Acme/X.git",
      "https://github.com:0/acme/x",
      "ssh://git@github.com:022/acme/x",
      "https://[github.com]/acme/x",
      "\ufeffgit@github.com:acme/x.git",
      "https://bitbuc\u212aet.org/Team/Repo",
      "C:\\repos\\analytics.git",
    ])
      expect(inputs.has(input)).toBe(true)
    expect(rows.length).toBeGreaterThan(150)
  })

  test("canonicalization matches on every row", () => {
    const wrong = rows.filter((r) => canonicalRepoRemote(r.input) !== r.canonical)
    expect(wrong.map((r) => r.input)).toEqual([])
  })

  test("host unification matches on every row, raw and canonical", () => {
    const wrong = rows.filter(
      (r) => unifyPublicHost(r.input) !== r.unify || unifyPublicHost(canonicalRepoRemote(r.input)) !== r.unified,
    )
    expect(wrong.map((r) => r.input)).toEqual([])
  })
})

describe("sameRepoRemote", () => {
  const X = "https://github.com/acme/x"

  test("every form of a public-host repo shares one key", () => {
    for (const form of [
      "ssh://git@github.com/acme/x",
      "git@github.com:Acme/X.git",
      "https://github.com/acme/x.git",
      "http://www.github.com/acme/x/",
      "ssh://git@ssh.github.com:443/acme/x",
      "github.com:acme/x",
      X,
    ]) {
      expect(publicRepoKey(form)).toBe("github.com/acme/x")
      expect(sameRepoRemote(form, X)).toBe(true)
    }
  })

  test("a stored value ending in .git matches the remote git prints for it", () => {
    // The service stores `https://github.com/acme/x.git` for a remote ending
    // in `x.git.git`.
    expect(sameRepoRemote("https://github.com/acme/x.git", "git@github.com:acme/x.git.git")).toBe(true)
    for (const n of [1, 33, 200]) {
      const raw = X + ".git".repeat(n)
      expect(sameRepoRemote(raw, canonicalRepoRemote(raw))).toBe(true)
      expect(publicRepoKey(raw)).toBe("github.com/acme/x")
    }
  })

  test("other hosts compare exactly, so .git keeps two repos apart", () => {
    // A self-hosted server can hold repos `X` and `X.git` side by side. The
    // service stores `.../X.git` for the second and `.../X` for the first.
    expect(publicRepoKey("https://git.acme.internal/acme/X.git")).toBeUndefined()
    expect(sameRepoRemote("https://git.acme.internal/acme/X", "https://git.acme.internal/acme/X")).toBe(true)
    expect(sameRepoRemote("https://git.acme.internal/acme/X.git", "https://git.acme.internal/acme/X")).toBe(false)
    expect(sameRepoRemote("ssh://git@git.acme.internal/data/x", "https://git.acme.internal/data/x")).toBe(false)
    expect(sameRepoRemote("git@github.acme.com:team/repo.git", "https://github.acme.com/team/repo")).toBe(false)
    expect(sameRepoRemote("https://gitea.example.com/Foo/Bar", "https://gitea.example.com/foo/bar")).toBe(false)
  })

  test("different repos stay different", () => {
    expect(sameRepoRemote("git@github.com:acme/x.git", "https://github.com/acme/y")).toBe(false)
    expect(sameRepoRemote("https://github.com/acme/x", "https://gitlab.com/acme/x")).toBe(false)
  })
})

describe("sameProjectIdentity", () => {
  const remote = (value: string) => ({ kind: "remote" as const, value })
  const path = (value: string) => ({ kind: "path" as const, value })

  test("remotes compare by the service's rule", () => {
    expect(sameProjectIdentity(remote("ssh://git@github.com/acme/x"), remote("https://github.com/acme/x"))).toBe(true)
  })

  test("paths compare exactly and are never read as remotes", () => {
    expect(sameProjectIdentity(path("/work/x"), path("/work/x"))).toBe(true)
    expect(sameProjectIdentity(path("/work/x/"), path("/work/x"))).toBe(false)
    expect(sameProjectIdentity(path("/srv/a.git"), path("/srv/a"))).toBe(false)
    expect(sameProjectIdentity(path("C:\\repos\\x.git"), path("C:\\repos\\x"))).toBe(false)
  })

  test("a remote never equals a path, and a missing identity matches nothing", () => {
    expect(sameProjectIdentity(remote("/work/x"), path("/work/x"))).toBe(false)
    expect(sameProjectIdentity(undefined, remote("https://github.com/acme/x"))).toBe(false)
    expect(sameProjectIdentity(undefined, undefined)).toBe(false)
  })

  test("projectIdentity prefers the remote and ignores non-strings", () => {
    expect(projectIdentity("https://github.com/acme/x", "/work/x")).toEqual(remote("https://github.com/acme/x"))
    expect(projectIdentity(null, "/work/x")).toEqual(path("/work/x"))
    expect(projectIdentity(42, undefined)).toBeUndefined()
  })
})

describe("sameIdentifier (the link dialog's drift check)", () => {
  test("a remote as git prints it is no drift from the value the service stored", () => {
    expect(sameIdentifier("remote", "https://github.com/acme/x", "git@github.com:acme/x.git")).toBe(true)
    expect(sameIdentifier("remote", "ssh://git@github.com/acme/x", "git@github.com:acme/x.git")).toBe(true)
    expect(sameIdentifier("remote", "https://github.com/acme/x", "https://github.com/Acme/X.git")).toBe(true)
  })

  test("a different repo is still drift", () => {
    expect(sameIdentifier("remote", "https://github.com/acme/x", "git@github.com:acme/renamed.git")).toBe(false)
    expect(sameIdentifier("remote", "ssh://git@git.acme.internal/data/x", "https://git.acme.internal/data/x")).toBe(
      false,
    )
  })

  test("off the public hosts, the service's canonical form of the local remote is no drift", () => {
    expect(sameIdentifier("remote", "ssh://git@git.acme.internal/data/x", "git@git.acme.internal:data/x.git")).toBe(
      true,
    )
    expect(sameIdentifier("remote", "https://git.acme.internal/data/X", "https://git.acme.internal/data/X.git/")).toBe(
      true,
    )
    expect(sameIdentifier("remote", "https://git.acme.internal/data/X", "https://git.acme.internal/data/Y.git")).toBe(
      false,
    )
  })

  test("paths compare exactly", () => {
    expect(sameIdentifier("path", "/work/x", "/work/x")).toBe(true)
    expect(sameIdentifier("path", "/work/x.git", "/work/x")).toBe(false)
  })
})
