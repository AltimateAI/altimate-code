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

  test("decodes a Byte[] checksums.txt body (Windows PowerShell 5.1)", () => {
    // GitHub serves release assets as octet-stream, so PS 5.1 returns .Content
    // as Byte[]; without an explicit decode it coerces to decimal text and the
    // check silently soft-skips. See test/windows/install.Tests.ps1 for the
    // behavioral guard.
    expect(PS1).toContain("-is [byte[]]")
    expect(PS1).toContain("[System.Text.Encoding]::UTF8.GetString")
  })
})

describe("archive and checksums come from the same release (no latest/ race)", () => {
  test("bash derives the checksums URL from the same base as the archive", () => {
    // verify_checksum builds checksums_url from the archive's own URL (${url%/*}),
    // so the two are always fetched from the same release path.
    expect(BASH_INSTALL).toContain('checksums_url="${url%/*}/checksums.txt"')
  })

  test("PowerShell pins both URLs to the resolved release tag (cubic P2)", () => {
    // The archive and checksums.txt share one $base; that base is the resolved
    // tag, so a release published mid-install can't hand back mismatched assets.
    // Falls back to latest/ only when the version couldn't be resolved.
    expect(PS1).toContain('$url = "$base/$filename"')
    expect(PS1).toContain('$checksumsUrl = "$base/checksums.txt"')
    expect(PS1).toContain('$base = "https://github.com/AltimateAI/altimate-code/releases/download/v$specificVersion"')
  })
})
