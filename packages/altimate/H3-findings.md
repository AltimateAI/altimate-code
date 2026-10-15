# H3 findings: injectable updater (ALT-F03)

Date: 2026-10-15. Starting HEAD: `8ff13c6fc7`, branch `spike/v2-branded-host`. Bun 1.4.2. Changes are unstaged; no commit or real publication was made.

The updater now consumes the build-selected identity. Offline updater, upgrade-command and wrapper tests pass, as does the canonical root check. The installed two-version upgrade and TUI acceptance below remain **unrun**: they require listeners/network. The existing H5 binary was used separately to prove the new npm packaging preserves its real native sidecars.

## Mechanism and stock compatibility

`Identity.updater` is a required part of the complete descriptor, validated at the build boundary. Production `Updater.layer` uses the compiled `Identity`; `layerWith({ identity, fetch })` exposes the same implementation to offline tests without global fetch replacement. There is no runtime environment override for a release endpoint. A local endpoint must be explicitly selected in the build descriptor.

| Surface | Stock default | Altimate descriptor |
| --- | --- | --- |
| Release URL | `https://opencode.ai/update/api/{channel}/{artifact}/{distribution}?current={current}` | `https://altimate.ai/altimate-code/update/api/{channel}/{artifact}/{distribution}?current={current}` |
| Expected npm package | `@opencode/{artifact}` (`cli` or `cli-node`) | `@altimateai/altimate-code` |
| Installed-package regex | `^@opencode(?:-ai)?/cli(?:-node)?$` | `^(?:@altimateai/)?altimate-code$` |
| Installer URL | `https://opencode.ai/v2/install` | `null`: deferred |
| Standalone install location | `~/.opencode/bin/opencode[.exe]` | `~/.altimate-code/bin/altimate-code[.exe]` |
| Homebrew detection | `opencode`, `opencode-beta`, `opencode-v2` | `null`: deferred |
| Homebrew release/target | Core: `https://formulae.brew.sh/api/formula/opencode.json`, `opencode`; tap: `anomalyco/tap/opencode-v2`, or `anomalyco/tap/opencode-beta` for beta | No lookup/install |
| WinGet ID | `Anomaly.OpenCode` | `null`: deferred |
| Policy files, low to high precedence | `config.json`, `opencode.json`, `opencode.jsonc` | Stock fallback files, then `altimate-code.json`, `altimate-code.jsonc` |

URL substitutions retain the existing channel sanitization and percent encoding. Package substitution uses the compiled artifact. The npm/pnpm/Bun/Yarn/Vite+ argument arrays retain their stock flags and now receive only a validated expected package. WinGet detection derives its case-insensitive directory match from the configured ID. Core Homebrew uses its configured independent endpoint; tap package expectations follow the build channel.

The intentional stock behavior change is **manifest package validation**. A non-Core release whose `metadata.package` differs from the descriptor's expected package fails with both received and expected names before a package-manager command runs. This applies to checks and explicit-version upgrades. An arbitrary manifest can no longer migrate a stock CLI into a different npm package. The existing package migration test now tests migration *to* the expected artifact package, and the Node test declares its `cli-node` artifact explicitly. The local-channel beta-Cellar fixture now advertises the default tap package; the real beta channel remains mapped to the beta formula. Core's schema has no package field, so its package is fixed by the descriptor.

Stock endpoint strings, policy ordering, install detection, installer commands and package-manager argument bytes remain unchanged for matching releases. `commands.ts` already has the identity-aware upgrade description. The existing upgrade handler already formats `UpgradeError`; neither needed a production edit. No public Protocol or Server HttpApi changed, so no client generation was required.

For Altimate, explicit `latest`/`upgrade` requests for Homebrew, WinGet or curl fail before fetching or spawning with **“not supported for this distribution”**. The standalone Altimate path can still be recognized and produces that refusal. Unsupported Homebrew/WinGet identities are not inferred from OpenCode installations. Null methods have no uninstall command through this service. The branded descriptor contains no upstream update URL; the egress test invokes every method and examines fetched URLs and URL-bearing command arguments. A second test enables a synthetic branded installer URL and verifies that path as well. This covers URLs the updater constructs, not arbitrary behavior inside external package managers or a remote server's redirects.

## v1 conventions and release service decision

Read directly from the sibling v1 checkout's `packages/opencode/src/installation/index.ts` and `packages/core/src/installation/version.ts`:

- npm/Bun/pnpm version checks use `${registry}/@altimateai/altimate-code/${InstallationChannel}`. Both `@altimateai/altimate-code` and unscoped `altimate-code` are recognized installation owners. H3 selects the scoped name as the expected wrapper, while allowing either name for detection.
- v1 standalone release checks use `https://api.github.com/repos/AltimateAI/altimate-code/releases/latest`; its installer is `https://www.altimate.sh/install` (and `.ps1` on Windows).
- v1's published channels are `latest` and `beta`; `local` and branch previews are not published. H3 preserves the same channel names and package identity. `spike` in this recipe is an explicitly local npm dist-tag/mock channel, not a promised public channel.

v1 has no service with the v2 `{ version, metadata: { package } }` response contract. The descriptor's `altimate.ai/altimate-code/update/api/...` URL is therefore a **placeholder**, not a deployed endpoint. We do not repoint v2 at GitHub's incompatible JSON or the v1 installer. Serving that contract and shipping standalone/Homebrew/WinGet installers remain distribution work.

The model catalog and OpenCode provider egress named in the spike plan remain a separate product decision. This patch does not claim to remove those URLs from the whole application.

## npm wrapper packaging

The original `packages/cli/script/publish.ts` produced `@opencode/cli`, with `opencode`/`opencode2` bins, an `@opencode/cli-*` optional dependency per platform, and a postinstall script that hardlinks or copies the platform executable into the wrapper. It was not identity-aware. Its ordinary dry-run also prepared upstream artifact archives; it was not a dedicated local packaging path.

The minimal addition is:

```sh
# From packages/cli, after building a matching version into $dist.
OPENCODE_VERSION=0.0.1-spike OPENCODE_CHANNEL=spike OPENCODE_CLI_DIST="$dist" \
  bun run script/publish.ts --pack-only --identity=../altimate/identity.json
```

`--pack-only` requires an explicit version before importing release metadata, packs platform and wrapper tarballs, and skips registry lookups, publication, uploads, artifact registration, Docker and distribution release scripts. A branded descriptor without `--pack-only` is refused. Existing stock publication remains the default. The branded wrapper is `@altimateai/altimate-code`, with the `altimate-code` bin and H5's existing unscoped `altimate-code-darwin-arm64` optional dependency. The internal Unix bin target retains the upstream `.exe` suffix; npm links it as `altimate-code`, and detection checks the manifest bin path rather than assuming a suffix. Generic repository/license/platform metadata remains upstream-shaped; this is a local spike wrapper, not a completed public release pipeline.

H5's driver resolver uses the running executable's sibling `lib/`. The old postinstall moved only the executable, so an npm installation would lose that lookup. Postinstall now copies a platform package's `lib/`, when present, beside the wrapper binary. Stock has no such sidecars. The original platform package retains its sidecars, so npm installs use an extra approximately 50.7 MiB for that copy.

The [real artifact receipt](evidence/h3/wrapper-artifact.json) records packing H5 `0.0.0-spike`, extracting both tarballs to an isolated npm-shaped directory, running production postinstall, and invoking the installed artifact's smoke. The platform tarball is 101,979,396 bytes; the wrapper is 2,977 bytes. The smoke exits 0 with `[[42]]`, RPC true, no listener, and every recorded DuckDB module under the installed wrapper's `lib/`. This binary predates H3: that result proves packaging/native delivery, **not** the new updater or a registry installation.

## Offline verification

All tests ran from package directories with the supplied Bun 1.4.2; no listener was opened, and update transport/package-manager execution was injected in updater tests. The packaging test runs real local pack, tar extraction and postinstall against a small fixture. No real publish ran.

| Check | Result |
| --- | --- |
| CLI `src/services/updater.test.ts test/updater-install.test.ts test/upgrade.test.ts test/publish.test.ts` | **74 pass, 5 Windows-only skips, 0 fail**, 353 assertions; subprocess tests additionally exercise the Node artifact and three installed-build cases |
| Util `test/identity.test.ts` | **5 pass, 0 fail**, 45 assertions |
| CLI `bun typecheck` | Exit 0 |
| Root `bun run check` | Exit 0, **37/37 tasks**; 1,353 lint warnings, zero lint errors |
| Actual H5 artifact wrapper/native smoke | Exit 0; `[[42]]`; no listener |
| Independent source review | No blocking finding |

Receipts: [CLI suites](evidence/h3/updater-tests.txt), [identity tests](evidence/h3/identity-tests.txt), [CLI types](evidence/h3/cli-typecheck.txt), [root check summary](evidence/h3/check.txt). Full root output is `/private/tmp/altimate-h3/check.txt`. Wrangler reported its denied external log writes without failing the root check. The Windows retained-image tests were skipped on macOS; this is not cross-platform acceptance.

Coverage includes exact stock npm/Core/tap/WinGet/curl commands and URLs, branded manager detection and targets, unscoped v1 detection, wrong-package rejection before install, all deferred methods before I/O, branded URL egress, configurable standalone detection/installer, and real `check`/`apply`/recheck with compiled `0.0.1-spike` and `spike` constants. Policy tests prove branded filenames override fallback files and a disabled background policy still allows explicit checks.

## Live recipe for the user: two installed versions

Run on darwin-arm64 with dependencies already installed, as for H5. This section deliberately starts local listeners and publishes **only to a disposable local registry**. Choose unused ports if 4873, 4874 or the managed-service port 57251 are occupied. Keep the resulting binaries local: their compiled release endpoint points to localhost.

### 1. Prepare the isolated descriptor and both full artifacts

```sh
export PATH=/private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/a3ba8813-c4f4-4234-9efe-d5c7103ee560/scratchpad/bun142/bun-darwin-aarch64:$PATH
repo=/Users/anandgupta/codebase/altimate-code-v2-host
h3=$(mktemp -d /private/tmp/altimate-h3-live.XXXXXX)
mkdir -p "$h3/home" "$h3/tmp" "$h3/project" "$h3/prefix" "$h3/config/altimate-code"

bun -e '
  const path = await import("node:path");
  const [repo, out] = process.argv.slice(1);
  const source = path.join(repo, "packages/altimate/identity.json");
  const identity = await Bun.file(source).json();
  identity.hostPlugins = path.resolve(path.dirname(source), identity.hostPlugins);
  identity.buildPlugin = path.resolve(path.dirname(source), identity.buildPlugin);
  identity.updater.releaseUrl = "http://127.0.0.1:4874/update/api/{channel}/{artifact}/{distribution}?current={current}";
  await Bun.write(out, JSON.stringify(identity, null, 2));
' "$repo" "$h3/identity.json"

cd "$repo/packages/cli"
for version in 0.0.1-spike 0.0.2-spike; do
  TMPDIR=/private/tmp OPENCODE_VERSION="$version" OPENCODE_CHANNEL=spike \
    bun run script/build.ts --single --skip-install --identity="$h3/identity.json" \
    --outdir="$h3/dist-$version"
  OPENCODE_VERSION="$version" OPENCODE_CHANNEL=spike OPENCODE_CLI_DIST="$h3/dist-$version" \
    bun run script/publish.ts --pack-only --identity="$h3/identity.json"
done
```

These rebuild H5's complete artifact with H3 embedded, preserve embedded web assets, and retain the native `lib/` sidecars. Merely editing the old H5 `package.json` cannot produce the two runtime versions. `--skip-install` assumes the already-locked build dependencies are present; otherwise install those first as in H5.

### 2. Run Verdaccio and the release mock

```sh
cat > "$h3/verdaccio.yaml" <<EOF
storage: $h3/registry-storage
auth:
  htpasswd:
    file: $h3/registry-htpasswd
uplinks: {}
max_body_size: 512mb
packages:
  '@altimateai/*':
    access: \$all
    publish: \$all
  'altimate-code-*':
    access: \$all
    publish: \$all
log: { type: stdout, format: pretty, level: warn }
EOF

# Use an installed Verdaccio, or let npx obtain it. This command needs network if uncached.
npx --yes verdaccio@6 --config "$h3/verdaccio.yaml" --listen 127.0.0.1:4873 \
  > "$h3/verdaccio.log" 2>&1 &
h3_registry_pid=$!

cat > "$h3/release.json" <<'EOF'
{"version":"0.0.2-spike","metadata":{"package":"@altimateai/altimate-code"}}
EOF
cat > "$h3/release-server.ts" <<'EOF'
const manifest = Bun.file(process.argv[2])
Bun.serve({
  hostname: "127.0.0.1",
  port: 4874,
  async fetch(request) {
    console.log(request.method, request.url)
    if (new URL(request.url).pathname !== "/update/api/spike/cli/npm")
      return new Response("Not found", { status: 404 })
    return Response.json(await manifest.json())
  },
})
EOF
bun "$h3/release-server.ts" "$h3/release.json" > "$h3/release.log" 2>&1 &
h3_release_pid=$!

# Wait for startup; inspect the two logs if either final request fails.
for attempt in $(seq 1 60); do
  if curl --silent --fail http://127.0.0.1:4873/-/ping > /dev/null && \
    curl --silent --fail 'http://127.0.0.1:4874/update/api/spike/cli/npm' > /dev/null; then
    break
  fi
  sleep 1
done
curl --fail http://127.0.0.1:4873/-/ping
curl --fail 'http://127.0.0.1:4874/update/api/spike/cli/npm?current=0.0.1-spike'
```

The registry has no uplink and permits anonymous publication only on these local test package patterns. Its body-size override is needed for the H5 native artifact. Do not reuse this configuration for a public registry.

### 3. Publish locally and install the older wrapper

```sh
cat > "$h3/npmrc" <<EOF
registry=http://127.0.0.1:4873/
@altimateai:registry=http://127.0.0.1:4873/
prefix=$h3/prefix
cache=$h3/npm-cache
audit=false
fund=false
EOF
: > "$h3/global.npmrc"
cat > "$h3/config/altimate-code/altimate-code.json" <<'EOF'
{"update":"disable"}
EOF

# Preserve this function and $h3 in the shell used for all subsequent steps.
h3env() {
  env -i PATH="$h3/prefix/bin:$PATH" TERM="${TERM:-xterm-256color}" \
    HOME="$h3/home" TMPDIR="$h3/tmp" \
    XDG_DATA_HOME="$h3/data" XDG_CONFIG_HOME="$h3/config" \
    XDG_CACHE_HOME="$h3/cache" XDG_STATE_HOME="$h3/state" \
    npm_config_userconfig="$h3/npmrc" npm_config_globalconfig="$h3/global.npmrc" \
    npm_config_registry=http://127.0.0.1:4873/ npm_config_prefix="$h3/prefix" \
    ALTIMATE_CLI_DISABLE_MODELS_FETCH=1 "$@"
}

# npm itself requires login even when Verdaccio permits anonymous publication.
# Create a disposable account on this localhost registry; never use a real registry login.
# Its local auth entry is stored only in $h3/npmrc.
h3env npm adduser --registry=http://127.0.0.1:4873 --auth-type=legacy

for version in 0.0.1-spike 0.0.2-spike; do
  h3env npm publish --registry=http://127.0.0.1:4873 --tag spike --access public \
    "$h3/dist-$version/altimate-code-darwin-arm64/altimate-code-darwin-arm64-$version.tgz"
  h3env npm publish --registry=http://127.0.0.1:4873 --tag spike --access public \
    "$h3/dist-$version/@altimateai/altimate-code/altimateai-altimate-code-$version.tgz"
done
h3env npm install --global --registry=http://127.0.0.1:4873 \
  @altimateai/altimate-code@0.0.1-spike
h3env "$h3/prefix/bin/altimate-code" --version
# Expected: altimate-code v0.0.1-spike
h3env "$h3/prefix/bin/altimate-code" service set port 57251
```

The prefix and registry environment must also reach the TUI and upgrade subprocess; otherwise a successful `npm install --global` could write to a different prefix. This clean environment excludes `NODE_PATH`, preload options, existing application state and provider credentials. Both wrappers and their exact optional platform dependency versions are served locally.

### 4. Exercise the real TUI check, refuse a wrong package, then upgrade

```sh
cd "$h3/project"
h3env "$h3/prefix/bin/altimate-code"
```

In the TUI enter **`/update`**. Expect `0.0.2-spike` available. The disabled automatic policy ensures this goes through `Updater.check()` instead of reusing an earlier background notification. Capture the dialog and `$h3/release.log`: it must show `/update/api/spike/cli/npm?current=0.0.1-spike`. Dismiss without applying and quit the TUI. There is no `upgrade --check` option.

Before installing, replace the mock manifest and verify a nonzero command result with both package names:

```sh
cat > "$h3/release.json" <<'EOF'
{"version":"0.0.2-spike","metadata":{"package":"@opencode/cli"}}
EOF
h3env "$h3/prefix/bin/altimate-code" upgrade 0.0.2-spike --method npm
# Must fail: returned @opencode/cli; expected @altimateai/altimate-code.
h3env "$h3/prefix/bin/altimate-code" --version
# Still altimate-code v0.0.1-spike. Registry logs must show no wrong-package install.
```

Optionally reopen the TUI and enter `/update` to see the same refusal in its real dialog, then quit. Restore the correct manifest and perform the upgrade:

```sh
cat > "$h3/release.json" <<'EOF'
{"version":"0.0.2-spike","metadata":{"package":"@altimateai/altimate-code"}}
EOF
h3env "$h3/prefix/bin/altimate-code" upgrade
# Must detect npm, report 0.0.1-spike -> 0.0.2-spike, and complete.
h3env "$h3/prefix/bin/altimate-code" --version
# Expected: altimate-code v0.0.2-spike
h3env npm list --global --depth=0 @altimateai/altimate-code
h3env "$h3/prefix/bin/altimate-code" debug paths
# Application paths must remain under this isolated environment's altimate-code roots.
h3env "$h3/prefix/bin/altimate-code" service restart
h3env "$h3/prefix/bin/altimate-code"
```

Confirm the restarted TUI displays the Altimate identity and `/update` reports up to date; the mock log now has `current=0.0.2-spike`. The explicit service restart ensures the background process also runs the new installed artifact. After quitting, optionally run `--altimate-artifact-smoke` from this installed wrapper to retain a native-delivery receipt for the new version.

Record version output before/after, npm's global package listing, TUI check/refusal/restart evidence, both local logs, and the final driver smoke. To finish, stop only the service in this isolated environment and the two listener PIDs created above:

```sh
h3env "$h3/prefix/bin/altimate-code" service stop
kill "$h3_release_pid" "$h3_registry_pid"
```

## Patch ledger

Counts are against starting HEAD; new files are counted against `/dev/null`. Upstream TypeScript/JavaScript changes carry `// altimate: ALT-F03`. H1/H2/H5 changes already in HEAD are excluded.

| File | Ownership | + | - |
| --- | --- | ---: | ---: |
| `packages/util/src/identity.ts` | upstream descriptor contract/defaults/validation | 77 | 0 |
| `packages/cli/src/services/updater.ts` | upstream updater | 98 | 36 |
| `packages/cli/script/publish.ts` | upstream wrapper/build seam | 27 | 10 |
| `packages/cli/script/postinstall.mjs` | upstream generic sidecar preservation | 3 | 0 |
| **Upstream production/build total** | | **205** | **46** |
| `packages/altimate/identity.json` | distribution configuration | 11 | 0 |
| `packages/util/test/identity.test.ts` | upstream tests | 18 | 0 |
| `packages/cli/test/updater-install.test.ts` | upstream tests | 302 | 28 |
| `packages/cli/test/publish.test.ts` | upstream tests, new | 146 | 0 |

| File | Ownership | + | - |
| --- | --- | ---: | ---: |
| `packages/altimate/H3-findings.md` | distribution documentation | 292 | 0 |
| `packages/altimate/evidence/h3/check.txt` | distribution evidence | 12 | 0 |
| `packages/altimate/evidence/h3/cli-typecheck.txt` | distribution evidence | 1 | 0 |
| `packages/altimate/evidence/h3/identity-tests.txt` | distribution evidence | 13 | 0 |
| `packages/altimate/evidence/h3/updater-tests.txt` | distribution evidence | 101 | 0 |
| `packages/altimate/evidence/h3/wrapper-artifact.json` | distribution evidence | 48 | 0 |

Documentation/evidence is excluded from code totals. The contract that could remove the production patch is an upstream-supported update-source descriptor plus local identity-aware wrapper packaging. The H3 production change is 251 changed upstream lines; that is separate from the plan's cumulative H1–H3 warning threshold.

The default work-vault copy cannot be written under this session's writable-root policy (approval is disabled). Canonical source: this file. Intended copy: `/Users/anandgupta/obsidian/altimate/Research/Branded host spike/H3 injectable updater and local upgrade recipe.md`.
