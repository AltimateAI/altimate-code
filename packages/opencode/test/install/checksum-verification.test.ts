/**
 * Release-archive integrity verification across the install surface.
 *
 * The release publishes a checksums.txt asset; both installers fetch it and
 * verify the downloaded archive (sha256) before extracting — hard-fail on
 * mismatch, soft-skip when the file is absent (older pinned releases).
 */
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../../../..")
const BASH_INSTALL = readFileSync(join(REPO_ROOT, "install"), "utf-8")
const PS1 = readFileSync(join(REPO_ROOT, "install.ps1"), "utf-8")
const RELEASE_YML = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf-8")

describe("release publishes checksums", () => {
  test("release.yml generates checksums.txt and uploads it", () => {
    expect(RELEASE_YML).toContain("sha256sum *.tar.gz *.zip > checksums.txt")
    expect(RELEASE_YML).toContain("packages/opencode/dist/checksums.txt")
  })
})

describe("bash installer verifies checksums", () => {
  test("fetches checksums.txt and compares sha256", () => {
    expect(BASH_INSTALL).toContain("checksums.txt")
    expect(BASH_INSTALL).toMatch(/sha256sum|shasum -a 256/)
  })

  test("hard-fails on mismatch", () => {
    expect(BASH_INSTALL).toContain("Checksum mismatch")
    expect(BASH_INSTALL).toContain("verify_checksum")
  })
})

describe("PowerShell installer verifies checksums", () => {
  test("fetches checksums.txt and compares sha256", () => {
    expect(PS1).toContain("checksums.txt")
    expect(PS1).toContain("Get-FileHash")
    expect(PS1).toContain("Test-Checksum")
  })

  test("hard-fails on mismatch before extracting", () => {
    expect(PS1).toContain("Checksum mismatch")
    // The verify call must precede the actual extraction call (not the
    // Expand-Archive mention in the top-of-file ProgressPreference comment).
    expect(PS1.indexOf("Test-Checksum -Path")).toBeLessThan(PS1.indexOf("Expand-Archive -Path"))
  })
})
