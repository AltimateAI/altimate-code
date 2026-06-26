import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join, resolve } from "path"
import { Glob } from "bun"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppProcess } from "@opencode-ai/core/process"
import { Installation } from "../../src/installation"
import { isPublishableChannel } from "../../src/cli/upgrade"

const srcDir = resolve(import.meta.dir, "..", "..", "src")
const coreVersionSrc = resolve(import.meta.dir, "..", "..", "..", "core", "src", "installation", "version.ts")

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function latestWith(body: unknown, method: Installation.Method) {
  const layer = Installation.layer.pipe(
    Layer.provide(
      mockHttpClient(
        () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    ),
    Layer.provide(AppProcess.defaultLayer),
  )
  return Effect.runPromise(Installation.use.latest(method).pipe(Effect.provide(layer)))
}

// ---------------------------------------------------------------------------
// 1. VERSION normalization
// ---------------------------------------------------------------------------
describe("VERSION normalization", () => {
  test("VERSION never starts with 'v' prefix", () => {
    // In test env it's "local", but the logic that produces VERSION strips "v"
    if (Installation.VERSION !== "local") {
      expect(Installation.VERSION.startsWith("v")).toBe(false)
    }
  })

  test("shared InstallationVersion trims and strips 'v' prefix from OPENCODE_VERSION", () => {
    const content = readFileSync(coreVersionSrc, "utf-8")
    // Verify the VERSION definition includes .trim().replace(/^v/, "")
    expect(content).toContain('.trim().replace(/^v/, "")')
  })
})

// ---------------------------------------------------------------------------
// 2. Upgrade skip logic — version comparison
// ---------------------------------------------------------------------------
describe("upgrade version comparison", () => {
  test("same version from GitHub API matches (no false upgrade)", async () => {
    const latest = await latestWith({ tag_name: "v0.4.1" }, "unknown")
    // If VERSION were "0.4.1" (normalized), they'd match → upgrade skipped
    expect(latest).toBe("0.4.1")
    // Verify no "v" prefix that would cause mismatch
    expect(latest.startsWith("v")).toBe(false)
  })

  test("same version from npm API matches (no false upgrade)", async () => {
    const latest = await latestWith({ version: "0.4.1" }, "npm")
    expect(latest).toBe("0.4.1")
    expect(latest.startsWith("v")).toBe(false)
  })

  test("different version correctly triggers upgrade", async () => {
    const latest = await latestWith({ tag_name: "v0.5.0" }, "unknown")
    expect(latest).toBe("0.5.0")
    // "0.4.1" !== "0.5.0" → upgrade proceeds
    expect("0.4.1").not.toBe(latest)
  })

  test("auto-upgrade also uses normalized comparison", () => {
    // The auto-upgrade in cli/upgrade.ts uses the same normalized shared InstallationVersion
    const content = readFileSync(join(srcDir, "cli", "upgrade.ts"), "utf-8")
    expect(content).toContain("InstallationVersion === latest")
  })
})

// ---------------------------------------------------------------------------
// 2b. Branch/dev builds skip the upgrade check (no 404 spam in the TUI)
// ---------------------------------------------------------------------------
describe("isPublishableChannel — guards the upgrade check for branch/dev builds", () => {
  test("only the channels we actually publish are publishable (allowlist)", () => {
    // The build script creates releases only for non-preview ("latest") and "beta".
    expect(isPublishableChannel("latest")).toBe(true)
    expect(isPublishableChannel("beta")).toBe(true)
  })

  test("branch / dev / local channels are NOT publishable — incl. slash-FREE branch names", () => {
    // The original bug: a build off branch "upstream/merge-v1.17.9" set its channel to the branch
    // name → a 404 npm dist-tag lookup. A pure syntax check ("no slash") missed common branch names;
    // this is an allowlist, so slash-free branches are caught too.
    expect(isPublishableChannel("upstream/merge-v1.17.9")).toBe(false) // slash branch
    expect(isPublishableChannel("upstream-merge-v1.17.9")).toBe(false) // slash-free branch
    expect(isPublishableChannel("main")).toBe(false)
    expect(isPublishableChannel("dev")).toBe(false)
    expect(isPublishableChannel("feature-x")).toBe(false)
    expect(isPublishableChannel("v1.17.9")).toBe(false) // npm rejects semver-like dist-tags
    expect(isPublishableChannel("local")).toBe(false)
    expect(isPublishableChannel("")).toBe(false)
  })

  test("upgrade() guards on isLocal() OR a non-publishable channel before fetching", () => {
    const content = readFileSync(join(srcDir, "cli", "upgrade.ts"), "utf-8")
    expect(content).toContain("isPublishableChannel(InstallationChannel)")
    expect(content).toMatch(/if\s*\(\s*Installation\.isLocal\(\)\s*\|\|\s*!isPublishableChannel/)
  })
})

// ---------------------------------------------------------------------------
// 3. User-facing strings: no stale "opencode" references
// ---------------------------------------------------------------------------
describe("user-facing strings use 'altimate' not 'opencode'", () => {
  // Patterns that indicate user-facing strings containing "opencode" where it should be "altimate"
  const userFacingOpencode = /(?:run|Run)\s+[`'"]opencode\s|opencode\s+upgrade|opencode\s+auth/

  test("upgrade command uses 'altimate upgrade' not 'opencode upgrade'", () => {
    const content = readFileSync(join(srcDir, "cli", "cmd", "upgrade.ts"), "utf-8")
    expect(content).toContain("altimate upgrade")
    expect(content).not.toMatch(/opencode upgrade/)
  })

  test("provider error messages use 'altimate' not 'opencode'", () => {
    const errorTs = readFileSync(join(srcDir, "provider", "error.ts"), "utf-8")
    expect(errorTs).not.toMatch(/`opencode auth/)
    expect(errorTs).toContain("`altimate auth")
  })

  test("provider.ts uses 'altimate auth' not 'opencode auth'", () => {
    const content = readFileSync(join(srcDir, "provider", "provider.ts"), "utf-8")
    expect(content).not.toMatch(/`opencode auth/)
  })

  test("acp/service.ts uses 'altimate auth' not 'opencode auth'", () => {
    const content = readFileSync(join(srcDir, "acp", "service.ts"), "utf-8")
    expect(content).not.toMatch(/`opencode auth/)
    expect(content).toContain("`altimate auth")
  })

  test("acp/service.ts terminal-auth command uses 'altimate' binary", () => {
    const content = readFileSync(join(srcDir, "acp", "service.ts"), "utf-8")
    // The terminal-auth capability tells IDEs which command to run for auth
    expect(content).toMatch(/command:\s*"altimate"/)
    expect(content).not.toMatch(/command:\s*"opencode"/)
  })

  test("no user-facing 'opencode' command references in src/ (broad scan)", async () => {
    const violations: string[] = []
    const glob = new Glob("**/*.{ts,tsx}")

    for await (const file of glob.scan({ cwd: srcDir })) {
      const filePath = join(srcDir, file)
      const content = readFileSync(filePath, "utf-8")
      const lines = content.split("\n")

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip comments, imports, internal identifiers
        const trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("import ")) continue
        if (trimmed.startsWith("*")) continue // JSDoc

        // Check for user-facing strings like "run `opencode ...", "Run 'opencode ..."
        if (userFacingOpencode.test(line)) {
          violations.push(`${file}:${i + 1}: ${trimmed}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
