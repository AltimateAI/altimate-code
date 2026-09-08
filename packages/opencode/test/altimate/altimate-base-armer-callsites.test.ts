import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// `FreeTierCapability.issueArmer()` is the one way to arm the consent authority that
// `registerAfterConsent` checks, so *which entrypoints claim it* is a security-relevant fact. It
// was described in prose in three files, and when a second entrypoint was added the prose in two of
// them silently became false — the same failure happened repeatedly across four review rounds.
//
// Prose cannot police itself, so this does. If someone adds a claimer, this fails and points at the
// canonical docstring that has to be updated with it.

const SRC = path.join(import.meta.dir, "../../src")

/** Entrypoints allowed to claim the armer, each owning a surface that shows a disclosure. */
const EXPECTED_CLAIMERS = ["cli/cmd/serve.ts", "cli/tui/worker.ts"]

/**
 * Strips comments before matching, because several files legitimately *discuss* these functions in
 * prose — `host.ts` explains the capability model in its header. A naive grep counted those as call
 * sites, which is exactly the kind of false signal that makes a lint-style test worse than none.
 */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe("Altimate Base consent armer call sites", () => {
  test("only the documented entrypoints claim issueArmer()", () => {
    const claimers = sourceFiles(SRC)
      .filter((file) => {
        // The declaration in capability.ts is not a call site.
        if (file.endsWith(path.join("altimate", "free", "capability.ts"))) return false
        return /\bissueArmer\s*\(/.test(code(file))
      })
      .map((file) => path.relative(SRC, file).split(path.sep).join("/"))
      .sort()

    expect(
      claimers,
      "A file now claims the Base consent armer that the canonical docstring in " +
        "src/altimate/free/capability.ts does not list. Add it there (and to EXPECTED_CLAIMERS here) " +
        "only if it genuinely owns a surface that shows the disclosure first.",
    ).toEqual([...EXPECTED_CLAIMERS].sort())
  })

  test("capability.ts names exactly those entrypoints in its canonical docstring", () => {
    // Keeps the prose and the enforced list from drifting apart in the other direction.
    const capability = fs.readFileSync(path.join(SRC, "altimate/free/capability.ts"), "utf8")
    for (const claimer of EXPECTED_CLAIMERS) {
      expect(capability, `capability.ts does not mention ${claimer}`).toContain(claimer)
    }
  })

  test("the redeemer stays claimed by registerAfterConsent alone", () => {
    const redeemers = sourceFiles(SRC)
      .filter((file) => {
        if (file.endsWith(path.join("altimate", "free", "capability.ts"))) return false
        return /\bissueRedeemer\s*\(/.test(code(file))
      })
      .map((file) => path.relative(SRC, file).split(path.sep).join("/"))
    expect(redeemers).toEqual(["altimate/free/client.ts"])
  })
})
