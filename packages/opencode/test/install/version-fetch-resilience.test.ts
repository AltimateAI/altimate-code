/**
 * Latest-version resolution must be resilient, in BOTH installers.
 *
 * The `latest` install path hits api.github.com/.../releases/latest only for the
 * version-string display + the already-installed short-circuit — the download
 * itself uses releases/latest/download/<file> (server-side latest). A transient
 * 504 or the 60/hr/IP unauthenticated rate limit must NOT abort the install:
 * retry a few times, then degrade gracefully and install latest anyway.
 */
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../../../..")
const BASH = readFileSync(join(REPO_ROOT, "install"), "utf-8")
const PS1 = readFileSync(join(REPO_ROOT, "install.ps1"), "utf-8")

describe("bash installer — latest-version fetch is non-fatal", () => {
  test("retries the releases/latest API call", () => {
    expect(BASH).toContain("for attempt in 1 2 3")
    // --fail so a 504 errors out (and retries) instead of parsing an error body.
    expect(BASH).toContain("curl -fsSL https://api.github.com")
  })

  test("degrades gracefully instead of exiting on API failure", () => {
    expect(BASH).toContain("installing the latest release anyway")
    // The old fatal hard-fail must be gone from the latest path.
    expect(BASH).not.toContain("Failed to fetch version information")
  })

  test("only short-circuits as already-installed on a real version match", () => {
    expect(BASH).toContain('[ -n "$specific_version" ] && [[ "$installed_version" == "$specific_version" ]]')
  })
})

describe("PowerShell installer — latest-version fetch is non-fatal", () => {
  test("retries the releases/latest API call", () => {
    expect(PS1).toContain("for ($attempt = 1; $attempt -le 3; $attempt++)")
  })

  test("degrades gracefully instead of exiting on API failure", () => {
    expect(PS1).toContain("installing the latest release anyway")
    // The old fatal hard-fail must be gone.
    expect(PS1).not.toContain("Failed to fetch version information")
  })
})
