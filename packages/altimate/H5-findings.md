# H5: shipped artifact and offline first use (ALT-F05)

2026-10-15. Checkout `altimate-code-v2-host`, branch `spike/v2-branded-host`, starting HEAD `11b5ebe815701ab34958e397dfe2e2fd465544d4`. Bun **1.4.2 (744846f84)**, darwin-arm64. Changes are unstaged; no commit was made.

**Build and offline artifact acceptance pass.** The complete branded distribution, copied to an unrelated temporary directory, reports its branded version, activates the production built-in Altimate plugin, executes `warehouse_add` followed by `sql_execute("SELECT 42 AS answer")`, and returns `[[42]]` through the production RPC router. Both the DuckDB JavaScript API and native binding come from the copied distribution. No listener is opened. The live managed-server/TUI first-use and timing checks remain for the user.

## Build commands and web assets

```sh
export PATH=/private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/a3ba8813-c4f4-4234-9efe-d5c7103ee560/scratchpad/bun142/bun-darwin-aarch64:$PATH
cd /Users/anandgupta/codebase/altimate-code-v2-host/packages/cli

# First attempt, stock identity, before any H5 changes.
OPENCODE_VERSION=0.0.0-spike OPENCODE_CHANNEL=spike \
  bun run script/build.ts --single --outdir=/private/tmp/altimate-h5/stock

# Successful stock baseline, still before H5 changes.
TMPDIR=/private/tmp OPENCODE_VERSION=0.0.0-spike OPENCODE_CHANNEL=spike \
  bun run script/build.ts --single --skip-install --outdir=/private/tmp/altimate-h5/stock

# Successful branded build with H5 packaging.
TMPDIR=/private/tmp OPENCODE_VERSION=0.0.0-spike OPENCODE_CHANNEL=spike \
  bun run script/build.ts --single --skip-install --identity=../altimate/identity.json \
  --outdir=/private/tmp/altimate-h5/branded
```

The initial stock command stopped in the existing `bun install --os="*" --cpu="*" ...` step with `bun is unable to write files to tempdir: EPERM`. The successful builds use the existing `--skip-install` flag and already-installed, locked dependencies, plus writable `TMPDIR`. No package manifests or lockfile were changed by installation. A machine without those dependencies needs a dependency installation first; this is not a claim that a clean dependency install works offline.

**Embedded web assets stayed on:** no `--skip-web-ui`. The existing app build ran locally for stock and branded builds, including the PWA service worker; no prebuilt web directory or downloaded web archive was substituted. The generated archive is **24,163,795 bytes**, with **1,691 entries**, including `index.html`. Its complete bytes occur in both executables; see [web evidence](evidence/h5/web-assets.json). Installed dependencies were sufficient for this web build; no network fetch was needed. Existing Vite CSS/chunk warnings did not fail the builds.

Build logs remain at `/private/tmp/altimate-h5/stock-build.log`, `stock-build-skip-install.log`, and `branded-build-final.log`. Both successful builds also passed the existing simulation-graph, native-architecture and forbidden-artifact-content checks.

## Distributable layout

The deliverable is the **whole directory** `/private/tmp/altimate-h5/branded/altimate-code-darwin-arm64`, not just its executable:

```text
altimate-code-darwin-arm64/
  package.json
  bin/altimate-code
  lib/altimate/drivers/node_modules/@duckdb/
    node-api/
      package.json, LICENSE
      lib/index.js                  # bundled/minified CommonJS API
    node-bindings/
      package.json, LICENSE, duckdb.js
    node-bindings-darwin-arm64/
      package.json, LICENSE
      duckdb.node
      libduckdb.dylib                # arm64 slice
```

There are no symlinks to checkout dependencies in the copied distribution. Keep `bin` and `lib` as siblings when moving/installing it. Stock remains `/private/tmp/altimate-h5/stock/cli-darwin-arm64` with `bin/opencode` and its package manifest.

All three DuckDB packages are **1.4.4-r.1**. The npm dylib is universal: 110,271,216 bytes. `lipo -thin arm64` produces 52,599,536 bytes, saving 57,671,680 bytes without modifying installed source packages. `duckdb.node` is 392,792 bytes. Its `otool -L` dependency is `@rpath/libduckdb.dylib`, and its `LC_RPATH` is `@loader_path`, so the two native files must stay adjacent. The build hook explicitly rejects targets other than darwin-arm64; other platforms and signing/notarization remain out of scope.

## Changes and resolution contract

- The identity descriptor selects an optional, descriptor-relative **build plugin**. The upstream build loads it per target; upstream code does not import Altimate. Stock descriptors omit it.
- Distribution-owned `script/build-plugin.ts` bundles `@duckdb/node-api` JavaScript, copies the binding loader/manifests/licenses and native files, thins the dylib, sets a compile-time artifact flag, and selects the distribution entrypoint. The pre-existing PTY/watcher substitutions remain intact.
- `drivers/src/resolve.ts` checks the flag before its existing computed optional-driver import. For DuckDB it resolves only under `<directory of realpath(process.execPath)>/../lib/altimate/drivers/node_modules`. A missing API package or failed API load does not fall back through the driver's managed-storage, wrapper, `NODE_PATH`, cwd or checkout search roots. The shipped binding loader retains ordinary package-relative transitive resolution; the clean-environment runtime proof verifies that its dependencies also come from the artifact. Readiness uses that same API location. Source and stock behavior are unchanged. Resolution-only readiness still does not certify native loading; the smoke executes a query to do that.
- The original `@duckdb/node-bindings` loader is shipped unchanged. A small default-settings Bun compile probe initially failed bare transitive resolution; the exact host compile setting **`autoloadPackageJson: true`** makes it work. This was reproduced with the other autoload switches false. The full host already had that setting, so no relative-import rewrite was retained.
- Distribution-owned `artifact-entry.ts` adds hidden `--altimate-artifact-smoke` dispatch and otherwise loads the normal CLI. `artifact-smoke.ts` uses the embedded SDK and real Core/Server router. Existing `run` and the investigated server-facing debug handlers resolve a server connection, so they do not provide this listener-free acceptance path.

The smoke supplies a deterministic in-process model, disables model-catalog fetching, filesystem watchers/FFF, snapshots, title generation, project configuration and the dynamic provider loader. It does **not** supply the Altimate plugin via SDK options: it comes from the same compiled host contributions as ordinary first use. The first prompt invokes both production tools, checks active builtin inventory, calls `listWarehouses` and `lastResult` over the SDK's actual in-process RPC transport, and checks the loaded API/binding paths in `require.cache`. It asserts the TUI contribution is declared but does not mount the TUI or render `/warehouse`.

## Isolated proof and provenance

The final proof copies only the complete distributable to a new `/private/tmp/altimate-h5-isolated-*` directory. Cwd is a separate, empty directory. Each smoke scenario gets fresh HOME, XDG data/config/cache/state and TMPDIR. The environment is constructed from scratch with only these paths and the system PATH; `NODE_PATH`, package overrides, preload flags, provider credentials and existing caches are absent. The positive native trace additionally sets `DYLD_PRINT_LIBRARIES=1`.

Reproduce against the built artifact, without Bun or checkout packages on PATH:

```sh
proof=$(mktemp -d /private/tmp/altimate-h5-manual.XXXXXX)
cp -R /private/tmp/altimate-h5/branded/altimate-code-darwin-arm64 "$proof/artifact"
mkdir -p "$proof/home" "$proof/tmp" "$proof/elsewhere"
cd "$proof/elsewhere"

env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  HOME="$proof/home" TMPDIR="$proof/tmp" \
  XDG_DATA_HOME="$proof/data" XDG_CONFIG_HOME="$proof/config" \
  XDG_CACHE_HOME="$proof/cache" XDG_STATE_HOME="$proof/state" \
  "$proof/artifact/bin/altimate-code" --version

env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  HOME="$proof/home" TMPDIR="$proof/tmp" \
  XDG_DATA_HOME="$proof/data" XDG_CONFIG_HOME="$proof/config" \
  XDG_CACHE_HOME="$proof/cache" XDG_STATE_HOME="$proof/state" \
  DYLD_PRINT_LIBRARIES=1 \
  "$proof/artifact/bin/altimate-code" --altimate-artifact-smoke

otool -L "$proof/artifact/lib/altimate/drivers/node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node"
```

The [branded receipt](evidence/h5/branded-metrics.json) contains exact paths, per-file sizes, SHA-256 hashes, timings, smoke JSON and filtered DYLD output. The positive trace names both `duckdb.node` and `libduckdb.dylib` beneath the copied artifact. `require.cache` additionally names the artifact's `node-api/lib/index.js` and binding loader. This is runtime provenance; `otool` alone would establish only the link layout.

Two negative scenarios use the same copied executable with fresh environments:

1. Rename only its `duckdb.node`: smoke exits 1 and has no SQL RPC result.
2. Move its `node-api` package out of the artifact, then deliberately set `NODE_PATH` to the checkout's drivers `node_modules`: smoke still exits 1 and has no SQL RPC result.

Restoring the files makes a fresh smoke pass again. The full-host negative output is an assertion that the SQL result is absent; it does not expose the underlying driver-load diagnostic. The separate focused resolver probe also verifies the missing-artifact diagnostic. No checkout directories were hidden or modified for these tests, and no listener was used.

## Sizes and startup

<!-- h5-measurements:start -->
| Measure | Stock | Branded |
| --- | ---: | ---: |
| Executable bytes | 187,420,914 (178.74 MiB) | 187,635,570 (178.94 MiB) |
| Sidecars, excluding top-level manifest | 0 | 53,143,980 (50.68 MiB) |
| Complete distribution bytes | 187,421,161 (178.74 MiB) | 240,779,797 (229.63 MiB) |
| Complete size / stock | 1.000× | **1.285× — passes <1.5×** |
| First measured `--version` wall time | 4.989 s | 1.773 s |
| Subsequent `--version`, median of 4 | 45.8 ms | 47.8 ms |

Both version commands exit 0: `opencode v0.0.0-spike` / `altimate-code v0.0.0-spike`. Final positive smoke takes **0.926 s wall**, including **812 ms** inside the SDK/tools/RPC probe. After the negative tests and restoration it takes 0.715 s wall with another fresh application environment. Final relocated artifact: `/private/tmp/altimate-h5-isolated-bdbl7sqt/artifact`. The stock baseline receipt is [here](evidence/h5/stock-metrics.json).
<!-- h5-measurements:end -->

Sizes sum logical file bytes, including manifests and licenses; they are not compressed download sizes or allocated disk blocks. The budget includes the hidden smoke entrypoint and its embedded SDK dependencies. Without thinning the universal dylib, the additional 57,671,680 bytes would exceed the 1.5× budget.

“Cold” above means the first measured invocation of the newly built/copied executable with fresh application directories. OS filesystem caches were not evicted, and macOS first-execution validation was not separately measured. Stock ran before branded, so these samples do not establish a branded speedup. Repeat samples are fresh processes against the same executable/application directories. Total smoke time is not a separate plugin-ready metric or TUI first-paint measurement.

## Verification and patch ledger

Canonical root `bun run check`: **37/37 tasks successful**, lint warnings, no lint/type errors. Wrangler emitted its existing denied external-log-write message without failing the check. Focused package tests: util `test/identity.test.ts` **4 pass**; Altimate `test/host-identity.test.ts test/h2-host.test.ts` **12 pass**. No Protocol or Server HttpApi changed, so client generation was not needed. `git diff --check` passes.

The new scripts also pass supplemental `bun typecheck --project /private/tmp/altimate-h5/tsconfig-scripts.json` from `packages/altimate`. That temporary config extends Altimate's tsconfig, includes `script/*.ts` plus CLI's existing `src/virtual.d.ts`, uses the repository as `rootDir`, and disables declaration generation because the smoke bundles the CLI rather than publishing its inferred types. Initial checks without that CLI declaration / with declaration generation exposed missing virtual-module and inferred-declaration portability errors; neither required a production-code fix. The package's normal include list does not cover every script, hence this extra check.

Receipts: [repository check](evidence/h5/check.txt), [util tests](evidence/h5/util-tests.txt), [Altimate tests](evidence/h5/altimate-tests.txt), [scripts typecheck](evidence/h5/scripts-typecheck.txt). An independent final code review found no blocking issue.

Counts are against starting HEAD, with new files counted against `/dev/null`; nothing was staged. Existing H1/H2/plugin-spike changes are excluded. All upstream TypeScript hunks carry `// altimate: ALT-F05`.

| File | Ownership | + | - |
| --- | --- | ---: | ---: |
| `packages/cli/script/build.ts` | upstream build hook | 13 | 0 |
| `packages/util/src/identity.ts` | upstream descriptor validation | 5 | 0 |
| `packages/altimate/identity.json` | distribution | 1 | 0 |
| `packages/drivers/src/resolve.ts` | distribution-owned fork drivers | 28 | 0 |
| `packages/altimate/script/build-plugin.ts` | distribution | 45 | 0 |
| `packages/altimate/script/artifact-entry.ts` | distribution smoke dispatch | 7 | 0 |
| `packages/altimate/script/artifact-smoke.ts` | distribution acceptance probe | 145 | 0 |
| **Production/build/probe total** | **18 upstream + 226 distribution** | **244** | **0** |

| File | Ownership | + | - |
| --- | --- | ---: | ---: |
| `packages/altimate/H5-findings.md` | distribution documentation | 164 | 0 |
| `packages/altimate/evidence/h5/altimate-tests.txt` | distribution evidence | 22 | 0 |
| `packages/altimate/evidence/h5/branded-metrics.json` | distribution evidence | 95 | 0 |
| `packages/altimate/evidence/h5/check.txt` | distribution evidence | 15 | 0 |
| `packages/altimate/evidence/h5/scripts-typecheck.txt` | distribution evidence | 1 | 0 |
| `packages/altimate/evidence/h5/stock-metrics.json` | distribution evidence | 39 | 0 |
| `packages/altimate/evidence/h5/util-tests.txt` | distribution evidence | 12 | 0 |
| `packages/altimate/evidence/h5/web-assets.json` | distribution evidence | 7 | 0 |

This findings file and the text/JSON receipts are documentation, excluded from the code totals. No generated client, dependency lockfile, build output or `.gitignore` change is needed. Binaries/sidecars live outside the repository. Existing ignore rules cover `packages/app/dist`, CLI `dist`, and CLI `.cache`; `git status` contains no generated web assets, native files or smoke databases. The separately appearing `packages/altimate/evidence/h2-live/` belongs to concurrent work and was left untouched; it is excluded from this ledger.

## User's live run still required

1. Copy the **whole final distribution** to the intended unrelated install directory. Use another fresh HOME/XDG set with no package-path overrides and start a fresh managed server from this artifact. The spike channel has a preview-channel service port; do not assume the release channel's default port or reuse an existing source/stock service.
2. On the first prompt, without restart, invoke `warehouse_add` then `sql_execute("SELECT 42 AS answer")`; open `/warehouse` and verify the same warehouse/result through the real RPC and rendered panel. Check narrow and wide terminal sizes and actual keyboard dispatch. The offline SDK router result does not establish this UI/managed-server path.
3. Measure first paint and plugin-ready separately, with an agreed process-start time origin. The acceptance target is **plugin ready under 5 seconds cold**, independently of first paint. Capture when the builtin becomes active/tools become available and when the terminal first renders. Neither live timing was measured here, and the S7 first-boot delay is not declared fixed by the isolated SDK smoke.
4. Check `plugin list --builtin`, normal managed-server shutdown/restart, and that the managed server executes this copied artifact with its sidecar directory. No live server or session was touched during this task.

The requested work-vault copy is blocked by the session's writable-root restriction: `/Users/anandgupta/obsidian/altimate/Research/` is outside permitted writes and approval is disabled. This file is canonical. Intended copy: `/Users/anandgupta/obsidian/altimate/Research/Branded host spike/H5 shipped artifact and offline first use.md`.
