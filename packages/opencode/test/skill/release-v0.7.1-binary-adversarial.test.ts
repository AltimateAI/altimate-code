/**
 * Adversarial tests for the v0.7.1 binary-fix + rename release surface (PR #820).
 *
 * The companion file `release-v0.7.1-adversarial.test.ts` covers the
 * provider-error work that also ships in v0.7.1; this file covers PR #820
 * specifically — the embed-shim mechanism, curl-install rename, musl + win-arm
 * fail-fast, and the 16 review-driven fixes layered on top of those.
 *
 * Pattern: content-level assertions where the change is in a build script,
 * shell script, or upstream-shared file (refactoring those for unit-testability
 * is out of scope). Behavioral assertions where the change is in a callable
 * TypeScript module the test can `import`.
 */
import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

const PKG_DIR = path.resolve(import.meta.dir, "../..")
const REPO_ROOT = path.resolve(PKG_DIR, "../..")

const installScript = readFileSync(path.join(REPO_ROOT, "install"), "utf8")
const buildTs = readFileSync(path.join(PKG_DIR, "script/build.ts"), "utf8")
const installationTs = readFileSync(path.join(PKG_DIR, "src/installation/index.ts"), "utf8")
const smokeTest = readFileSync(path.join(PKG_DIR, "test/install/smoke-test-binary.test.ts"), "utf8")
const binAltimate = readFileSync(path.join(PKG_DIR, "bin/altimate"), "utf8")
const postinstall = readFileSync(path.join(PKG_DIR, "script/postinstall.mjs"), "utf8")

describe("v0.7.1 PR #820 — installation method() upgrade-path detection", () => {
  // P0 review finding: `altimate upgrade` after a v0.7.1 curl install must
  // identify the install method as "curl" so it picks the curl-upgrade path.
  // Pre-fix the detector only looked at `.opencode/bin` and `.local/bin`.
  test("detects new curl-install path .altimate/bin", () => {
    expect(installationTs).toContain(`path.join(".altimate", "bin")`)
  })
  test("retains .opencode/bin back-compat for pre-rename installs", () => {
    expect(installationTs).toContain(`path.join(".opencode", "bin")`)
  })
  test("retains .local/bin detection (distro-resolved path)", () => {
    expect(installationTs).toContain(`path.join(".local", "bin")`)
  })
  test("each curl-path branch returns the string \"curl\"", () => {
    // Avoid a future regression where someone adds `.altimate` but accidentally
    // returns "npm" or similar — the three branches must each return "curl".
    const re = /process\.execPath\.includes\(path\.join\("\.[a-zA-Z]+", "bin"\)\)\) return "curl"/g
    const matches = installationTs.match(re) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })
})

describe("v0.7.1 PR #820 — install script: APP rename to altimate", () => {
  test("APP variable is `altimate` (no `altimate-code` fallback)", () => {
    expect(installScript).toMatch(/^APP=altimate\s*$/m)
    expect(installScript).not.toMatch(/^APP=altimate-code\s*$/m)
  })
  test("INSTALL_DIR is ~/.altimate/bin (not legacy ~/.altimate-code/bin)", () => {
    expect(installScript).toContain("INSTALL_DIR=$HOME/.altimate/bin")
    expect(installScript).not.toContain(".altimate-code/bin")
  })
  test("GitHub repo URL stays AltimateAI/altimate-code (only the binary name changed)", () => {
    expect(installScript).toContain("github.com/AltimateAI/altimate-code/releases")
  })
})

describe("v0.7.1 PR #820 — install script: review-driven hardening", () => {
  test("Rosetta-detected x64→arm64 swap is announced (not silent)", () => {
    // Pre-fix: a fresh M-series Mac under Rosetta silently flipped to arm64
    // with zero output. Reassuring users requires a visible notice.
    expect(installScript).toContain("Rosetta detected")
  })
  test("install_from_binary guards against cp-on-self truncation", () => {
    // Without -ef inode equality check, `--binary ~/.altimate/bin/altimate`
    // would cp-onto-self and truncate the destination to an empty file.
    expect(installScript).toContain("$binary_path") // (sanity: file references the input)
    expect(installScript).toContain(`"$binary_path" -ef "$dest_path"`)
    expect(installScript).toContain("Source and destination are the same file")
  })
  test("stale altimate-code binary cleanup runs after fresh install", () => {
    // Pre-rename users have ~/.altimate-code/bin/altimate-code on PATH; the
    // rename only moves to ~/.altimate/bin, so the old binary lingers as a
    // stale v0.7.0 binary on $PATH. Cleanup must remove it after install.
    expect(installScript).toContain(`rm -f "\${INSTALL_DIR}/altimate-code"`)
    expect(installScript).toContain("Removed stale")
    expect(installScript).toContain("renamed to altimate in v0.7.1")
  })
  test("tar/unzip extract only the expected binary member", () => {
    // Defense in depth: if a future build mistakenly tars a directory of
    // attacker-controlled paths, extraction must still hit only the binary.
    expect(installScript).toContain(
      `tar --no-same-owner -xzf "$tmp_dir/$filename" -C "$tmp_dir" "$binary_name"`,
    )
    expect(installScript).toContain(`unzip -q "$tmp_dir/$filename" "$binary_name" -d "$tmp_dir"`)
  })
  test("check_version probes both `altimate` AND `altimate-code` on PATH", () => {
    // Without dual-probe, an upgrade from v0.7.0 (which only has altimate-code
    // on PATH) would always re-download even when the version already matches.
    expect(installScript).toContain('command -v altimate >/dev/null 2>&1')
    expect(installScript).toContain('command -v altimate-code >/dev/null 2>&1')
  })
  test("musl error suggests gcompat for both curl AND npm fallback paths", () => {
    // The Chaos Gremlin caught: npm postinstall also bails on raw musl, so a
    // bare "Use npm" message is half-right. Mention gcompat for npm too.
    expect(installScript).toContain("apk add gcompat")
    expect(installScript).toContain("apk add gcompat && npm install -g altimate-code")
    expect(installScript).toMatch(/gcompat is required either way/i)
  })
  test("get-started banner uses primary `altimate` name + correct docs URL", () => {
    expect(installScript).toContain("altimate                 ")
    expect(installScript).toContain("Open the TUI")
    expect(installScript).toContain('Run a quick task')
    expect(installScript).toContain("altimate-code.dev")
    // Legacy domain dropped from final banner — postinstall.mjs uses .dev
    expect(installScript).not.toMatch(/^echo -e "\$\{MUTED\}For more information visit \$\{NC\}https:\/\/altimate\.ai/m)
  })
  test("curl uses --fail in both progress and fallback download paths", () => {
    // Without --fail, a 404 / WAF block / captive portal writes HTML to the
    // archive file and tar dies "not in gzip format" — silently confusing.
    const failCount = (installScript.match(/curl --fail/g) || []).length
    expect(failCount).toBeGreaterThanOrEqual(2)
  })
  test("musl detection uses pipefail-safe ldd capture", () => {
    // `set -o pipefail` (line 2) means `ldd --version 2>&1 | grep -qi musl`
    // would inherit ldd's non-zero exit (intentional on musl) and the if-block
    // would never fire — defeating detection on Void/Adelie/custom musl distros.
    expect(installScript).toContain(`ldd_out="$(ldd --version 2>&1 || true)"`)
    expect(installScript).toContain(`printf '%s' "$ldd_out" | grep -qi musl`)
  })
  test("musl path does not construct a musl-suffixed archive name", () => {
    // is_musl=true exits above, so no `target=$target-musl` line should remain.
    expect(installScript).not.toMatch(/target="\$target-musl"/)
  })
})

describe("v0.7.1 PR #820 — build.ts: _requiredExports injection refusal", () => {
  test("captured loader literal is JSON.parsed (not inlined raw)", () => {
    // Pre-fix: the regex match group was inlined verbatim into the staged
    // shim, so a malicious altimate-core publishing
    //   const _requiredExports = ["x"]; phoneHome(); const _foo = [
    // would have JS executed at every CLI startup. JSON.parse + shape-check
    // rejects anything that isn't a pure string-array.
    expect(buildTs).toContain("JSON.parse(requiredExportsMatch[1])")
  })
  test("validates every element is a non-empty short string", () => {
    expect(buildTs).toContain("Array.isArray(parsed)")
    expect(buildTs).toMatch(/typeof n === "string"/)
    expect(buildTs).toContain("n.length > 0")
    // Upper-bound guards against a malicious very-long string that could
    // be used to exhaust resources or smuggle data into the embedded shim.
    expect(buildTs).toContain("n.length < 200")
  })
  test("re-serializes via JSON.stringify before inlining", () => {
    // Inlining the validated value (not the raw regex capture) means any
    // bytes the JSON.parse rejected can't sneak through.
    expect(buildTs).toContain("JSON.stringify(parsed)")
  })
  test("rejection has a clear actionable message", () => {
    expect(buildTs).toContain("Refusing to inline into the staged shim")
  })
})

describe("v0.7.1 PR #820 — build.ts: altimate-core version pinning", () => {
  test("asserts resolved on-disk version matches package.json declaration", () => {
    // Catches the stale-hoist scenario: bun install --os=* --cpu=* re-links
    // the top-level entry but a previous hoist for an older version can linger
    // in node_modules/.bun/, and import.meta.resolve resolves to whatever was
    // hoisted first. Mismatch = wrong .node embedded in the release archive.
    expect(buildTs).toContain(`pkg.dependencies["@altimateai/altimate-core"]`)
    expect(buildTs).toContain("does not match package.json")
  })
  test("rebuild hint points at concrete recovery steps", () => {
    expect(buildTs).toContain("rm -rf node_modules bun.lock && bun install")
  })
})

describe("v0.7.1 PR #820 — build.ts: staging directory hygiene", () => {
  test("staging dir is wiped before each per-target build (pre-loop cleanup)", () => {
    // Without this, a previous build that crashed between staging and the
    // post-build cleanup leaves a stale .altimate-core-staged/ on disk. The
    // next build's mkdir -p succeeds and (if onResolve ever regresses) an
    // older .node could be reused.
    expect(buildTs).toContain("Pre-loop cleanup")
    expect(buildTs).toMatch(/rm -rf dist\/\$\{name\}\/\.altimate-core-staged/)
  })
  test("post-build staging cleanup is still present", () => {
    expect(buildTs).toContain("Staging dir is no longer needed")
  })
})

describe("v0.7.1 PR #820 — build.ts: defense-in-depth target guards", () => {
  test("empty-targets array exits non-zero with diagnostic", () => {
    expect(buildTs).toContain("no build targets selected")
    expect(buildTs).toContain("process.exit(1)")
  })
  test("musl-host --single guard names gcompat as the workaround", () => {
    expect(buildTs).toContain("musl-linux host would build the glibc target")
    expect(buildTs).toContain("apk add gcompat")
  })
  test("build matrix excludes linux-musl and win32-arm64 (no NAPI prebuilds)", () => {
    // The allTargets array must not include musl entries; win32-arm64 also
    // gone. allTargets must still be non-empty.
    expect(buildTs).not.toMatch(/abi:\s*"musl"\s*,?\s*\}\s*,/)
    // Verify the comment explaining the exclusion is in place.
    expect(buildTs).toContain("linux-*-musl")
    expect(buildTs).toContain("win32-arm64")
  })
  test("altimateCorePlatformFor throws for excluded targets", () => {
    // Even if allTargets is later edited mistakenly, the platform mapper
    // refuses to produce a NAPI package name for excluded targets.
    expect(buildTs).toContain("No @altimateai/altimate-core prebuild for linux-")
    expect(buildTs).toContain("No @altimateai/altimate-core prebuild for win32-")
  })
})

describe("v0.7.1 PR #820 — smoke test hermeticity", () => {
  test("findLocalBinary filters by host OS+arch slug", () => {
    // Without this filter, a stale Linux ELF on a Darwin host would be picked
    // and spawnSync would return null status, producing a confusing failure.
    expect(smokeTest).toContain("dirMatchesHost")
    expect(smokeTest).toContain("hostOsSlug")
    expect(smokeTest).toContain("hostArchSlug")
  })
  test("NODE_PATH-cleared test uses tmpdir cwd (truly hermetic)", () => {
    // Bun's compiled binary walks up from process.execPath for node_modules;
    // running from the worktree would let the binary find the workspace's
    // altimate-core that way, masking a silent embed-shim regression.
    expect(smokeTest).toContain("await using tmp = await tmpdir()")
    expect(smokeTest).toContain("cwd: tmp.path")
    expect(smokeTest).toContain(`NODE_PATH: ""`)
  })
  test("content-level test asserts exactly one .node embedded", () => {
    // Belt-and-suspenders: even if the runtime test passes by accident on a
    // future Bun version that resolves differently, this catches a binary
    // that statically contains references to every platform's .node.
    expect(smokeTest).toContain("execFileSync")
    expect(smokeTest).toContain("strings")
    expect(smokeTest).toContain("distinct.size).toBe(1)")
  })
})

describe("v0.7.1 PR #820 — npm wrapper + postinstall fail-fast parity", () => {
  test("npm wrapper hard-errors on musl with actionable workaround", () => {
    expect(binAltimate).toContain("Alpine Linux (musl)")
    expect(binAltimate).toContain("apk add gcompat")
  })
  test("npm wrapper hard-errors on win32-arm64 with actionable workaround", () => {
    expect(binAltimate).toContain("Windows on ARM64")
    expect(binAltimate).toMatch(/WSL/)
  })
  test("postinstall fail-fast mirrors npm wrapper on musl + win32-arm64", () => {
    expect(postinstall).toContain("Alpine Linux (musl)")
    expect(postinstall).toContain("apk add gcompat")
    expect(postinstall).toContain("Windows on ARM64")
  })
  test("postinstall musl detection uses spawnSync (not execSync) for stderr", () => {
    // execSync throws on non-zero exit AND only returns stdout — would
    // silently miss every non-Alpine musl distro because ldd's musl signal
    // is on stderr and the exit code is non-zero.
    expect(postinstall).toContain("spawnSync")
    expect(postinstall).toContain("ldd")
  })
  test("npm wrapper drops musl-fallback entries from `names` resolution", () => {
    // The wrapper used to try `-musl` suffixes when finding a platform package;
    // since musl is not built, those suffixes would always 404 and confuse the
    // diagnostic. Names list now contains no musl variants.
    expect(binAltimate).not.toMatch(/`\${base}-musl`/)
    expect(binAltimate).not.toMatch(/`\${base}-baseline-musl`/)
  })
})

describe("v0.7.1 PR #820 — docs surface coverage", () => {
  test("troubleshooting.md covers all four PR #820 install error classes", () => {
    const ts = readFileSync(
      path.join(REPO_ROOT, "docs/docs/reference/troubleshooting.md"),
      "utf8",
    )
    expect(ts).toContain("Standalone binary not found after curl install")
    expect(ts).toContain("Cannot find module")
    expect(ts).toContain("Alpine Linux (musl) not supported")
    expect(ts).toContain("Windows on ARM64 not supported")
    expect(ts).toContain("apk add gcompat")
    expect(ts).toContain("~/.altimate/bin")
  })
  test("README documents the curl install option with the correct binary name", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8")
    // Accept either apex (altimate.sh) or www. host so a future apex-DNS fix
    // that swaps www.altimate.sh → altimate.sh doesn't need another test update.
    expect(readme).toMatch(/curl -fsSL https:\/\/(www\.)?altimate\.sh\/install \| bash/)
    expect(readme).toContain("~/.altimate/bin")
    expect(readme).toMatch(/single self-contained binary named `altimate`/)
  })
})

describe("v0.7.1 PR #820 — archive-name + bin-rename invariants", () => {
  // Cross-file invariants the per-file tests would each see in isolation but
  // can't catch when one file drifts ahead of the others.
  const publishTs = readFileSync(path.join(PKG_DIR, "script/publish.ts"), "utf8")
  test("publish.ts AUR + brew templates reference altimate-<target>.{tar.gz,zip}", () => {
    expect(publishTs).toContain("altimate-linux-x64.tar.gz")
    expect(publishTs).toContain("altimate-linux-arm64.tar.gz")
    expect(publishTs).toContain("altimate-darwin-x64.zip")
    expect(publishTs).toContain("altimate-darwin-arm64.zip")
    // Legacy archive names must be gone from the templates.
    expect(publishTs).not.toContain("altimate-code-linux-x64.tar.gz")
    expect(publishTs).not.toContain("altimate-code-darwin-arm64.zip")
  })
  test("brew formula installs `altimate` and symlinks `altimate-code` back-compat", () => {
    expect(publishTs).toContain(`bin.install "altimate"`)
    expect(publishTs).toContain(`bin.install_symlink "altimate" => "altimate-code"`)
  })
  test("build.ts archive name maps platform package → altimate-<target>", () => {
    expect(buildTs).toContain(`key.replace(/^@altimateai\\/altimate-code-/, "altimate-")`)
  })
  test("Windows archive carries .exe; other targets carry the bare name", () => {
    // Linux/Darwin: tar takes `altimate`; Windows: zip takes `altimate.exe`.
    expect(buildTs).toContain(`key.includes("windows") ? "altimate.exe" : "altimate"`)
  })
})

describe("v0.7.1 PR #820 — release.yml hermetic CI smoke tests", () => {
  const releaseYml = readFileSync(path.join(REPO_ROOT, ".github/workflows/release.yml"), "utf8")
  test("build-time smoke test runs binary with NODE_PATH cleared", () => {
    expect(releaseYml).toContain("env -u NODE_PATH")
  })
  test("build-time smoke test runs binary from RUNNER_TEMP (hermetic cwd)", () => {
    expect(releaseYml).toMatch(/cd "?\$\{RUNNER_TEMP[^"]*"?/)
  })
  test("pre-publish smoke test also runs with NODE_PATH cleared + hermetic cwd", () => {
    // Both the build-time and pre-publish smoke tests must be hermetic — the
    // pre-publish one is the LAST gate before npm publish.
    const matches = releaseYml.match(/env -u NODE_PATH/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
  test("build matrix drops linux-musl and win32-arm64 entries", () => {
    // Match only the matrix `{ index: N, name: "..." }` lines, not comments
    // that mention the excluded targets to explain the exclusion.
    const matrixEntries = [...releaseYml.matchAll(/-\s*\{\s*index:\s*\d+,\s*name:\s*"([^"]+)"\s*\}/g)].map(
      (m) => m[1],
    )
    expect(matrixEntries.length).toBeGreaterThan(0)
    expect(matrixEntries).not.toContain("linux-arm64-musl")
    expect(matrixEntries).not.toContain("linux-x64-musl")
    expect(matrixEntries).not.toContain("linux-x64-baseline-musl")
    expect(matrixEntries).not.toContain("win32-arm64")
  })
  test("publish-npm job narrows permissions to contents: read", () => {
    // Defense in depth: the job holds NPM_TOKEN; explicit narrow permissions
    // mean any unexpected GitHub API write attempt fails.
    const publishNpmIdx = releaseYml.indexOf("publish-npm:")
    expect(publishNpmIdx).toBeGreaterThan(0)
    const githubReleaseIdx = releaseYml.indexOf("github-release:")
    expect(githubReleaseIdx).toBeGreaterThan(publishNpmIdx)
    const publishNpmBlock = releaseYml.slice(publishNpmIdx, githubReleaseIdx)
    expect(publishNpmBlock).toContain("permissions:")
    expect(publishNpmBlock).toContain("contents: read")
  })
})
