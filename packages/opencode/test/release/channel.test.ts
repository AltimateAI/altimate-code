/**
 * Which npm dist-tag a publish lands on.
 *
 * Getting this wrong in the `latest` direction moves every existing user onto
 * whatever was published, and the documented recovery
 * (`npm dist-tag add …@<good> latest`) needs publish credentials most of the
 * team does not hold — so the decision is pinned here rather than left to an
 * inline expression whose only protection is an env var reaching one workflow
 * step. See #1233.
 */

import { describe, test, expect } from "bun:test"
import { resolveChannel } from "../../../script/src/channel"

describe("resolveChannel: a prerelease must never reach `latest`", () => {
  test("an explicit channel always wins", () => {
    // This is the path the release workflow actually takes.
    expect(resolveChannel({ OPENCODE_CHANNEL: "beta", OPENCODE_VERSION: "v0.10.0-beta.1" })).toBe("beta")
    expect(resolveChannel({ OPENCODE_CHANNEL: "latest", OPENCODE_VERSION: "v0.10.0" })).toBe("latest")
  })

  test("a prerelease tag falls back to `beta`, not `latest`", () => {
    // The regression this guards. With OPENCODE_CHANNEL unset, the version is
    // the tag name — and before the fix, `0.10.0-beta.1` failed the `0.0.0-`
    // test and returned "latest", moving the stable dist-tag onto a beta.
    for (const v of ["v0.10.0-beta.1", "0.10.0-beta.1", "v1.0.0-rc.2", "v0.9.6-beta.10"]) {
      expect(resolveChannel({ OPENCODE_VERSION: v })).toBe("beta")
    }
  })

  test("a plain release version still resolves to `latest`", () => {
    // The fix must not push ordinary stable releases off `latest`.
    for (const v of ["v0.10.0", "0.10.0", "v1.2.3"]) {
      expect(resolveChannel({ OPENCODE_VERSION: v })).toBe("latest")
    }
  })

  test("`0.0.0-` preview builds still defer to the branch channel", () => {
    // These carry a `-` too, but they must keep falling through to the
    // branch-name channel rather than being captured as `beta`.
    expect(resolveChannel({ OPENCODE_VERSION: "0.0.0-release/v0.10.0-202609012234" })).toBeNull()
    expect(resolveChannel({ OPENCODE_VERSION: "v0.0.0-somebranch-123" })).toBeNull()
  })

  test("an explicit bump means a stable release", () => {
    expect(resolveChannel({ OPENCODE_BUMP: "minor" })).toBe("latest")
  })

  test("no signal at all defers to the caller", () => {
    expect(resolveChannel({})).toBeNull()
  })
})
