/**
 * Pins that every entrypoint wires autoRegisterWithin()'s onLateRegistration callback the way
 * the headless-disclosure guarantee requires: run/acp/web always pass a real callback so a
 * registration that completes after the startup wait still prints the disclosure once; serve
 * passes one too, EXCEPT when it's serving the VS Code extension (ALTIMATE_CLI_CLIENT=datamates),
 * which renders its own notice in the chat panel and must not get a second one from stdout.
 *
 * Source assertions, not execution — the CLI commands here are Effect-based and heavy to run
 * directly. Follows the pattern in test/branding/upstream-guard.test.ts.
 */
import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join, resolve } from "path"

const cmdDir = resolve(import.meta.dir, "..", "..", "src", "cli", "cmd")

function read(file: string): string {
  return readFileSync(join(cmdDir, file), "utf-8")
}

/**
 * Extracts the argument list of the first `autoRegisterWithin(...)` call, respecting nested
 * parens (its own arguments include calls like `printDisclosureOnceForHeadless(true)`, which a
 * naive non-greedy regex stops inside of instead of at the real closing paren).
 */
function autoRegisterWithinArgs(source: string): string | null {
  const start = source.indexOf("autoRegisterWithin(")
  if (start === -1) return null
  const openParen = start + "autoRegisterWithin".length
  let depth = 0
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === "(") depth++
    else if (source[i] === ")") {
      depth--
      if (depth === 0) return source.slice(openParen + 1, i)
    }
  }
  return null
}

// A real callback: any arrow function that ultimately calls printDisclosureOnceForHeadless(true).
// Matches both single-line (`() => void FreeTierConsent.printDisclosureOnceForHeadless(true)`)
// and multi-line arrow bodies, without caring about exact whitespace.
const REAL_CALLBACK = /\(\)\s*=>[\s\S]{0,80}?printDisclosureOnceForHeadless\(true\)/

describe("autoRegisterWithin() late-notice callback wiring per entrypoint", () => {
  test.each(["run.ts", "acp.ts", "web.ts", "agent.ts", "review.ts"])(
    "%s always passes a real onLateRegistration callback",
    (file) => {
      const source = read(file)
      const args = autoRegisterWithinArgs(source)
      expect(args, `${file} must call autoRegisterWithin()`).not.toBeNull()
      expect(args, `${file}'s autoRegisterWithin() call`).toMatch(REAL_CALLBACK)
      // Guards against a regression that passes the callback conditionally (that's serve.ts's
      // job, not these five) — none of them may reference ALTIMATE_CLI_CLIENT or ternary out.
      expect(args, `${file} must not gate its callback like serve.ts does`).not.toMatch(/\?\s*\(\)\s*=>/)
    },
  )

  test("serve.ts passes a real callback when NOT serving the datamates (VS Code) client", () => {
    const source = read("serve.ts")
    expect(source).toMatch(/ALTIMATE_CLI_CLIENT\s*!==\s*["']datamates["']/)
    const args = autoRegisterWithinArgs(source)
    expect(args, "serve.ts must call autoRegisterWithin()").not.toBeNull()
    // The callback argument must be conditioned on the same flag check, with `undefined` as the
    // datamates branch — asserting the ternary shape directly, not just "a callback exists
    // somewhere in this file" (which the datamates test below would also satisfy).
    expect(args).toMatch(/printsNotice\s*\?[\s\S]{0,80}?printDisclosureOnceForHeadless\(true\)[\s\S]{0,20}?:\s*undefined/)
  })

  test("serve.ts's printsNotice is false exactly when ALTIMATE_CLI_CLIENT is datamates", () => {
    const source = read("serve.ts")
    // printsNotice must be defined FROM the datamates check — not some other, unrelated
    // condition that happens to also gate the callback. If a future refactor renames or
    // decouples this, the previous test's ternary-shape assertion would still pass on a
    // `printsNotice` that no longer means "not datamates" — this pins the definition itself.
    expect(source).toMatch(/printsNotice\s*=\s*OpencodeFlag\.ALTIMATE_CLI_CLIENT\s*!==\s*["']datamates["']/)
  })
})
