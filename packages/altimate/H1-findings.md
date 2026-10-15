# H1 findings: branded host identity (ALT-F01)

Date: 2026-10-15. Checkout: `altimate-code-v2-host`, existing branch `spike/v2-branded-host`, OpenCode 2.0.29. Implemented with Bun 1.4.2. All changes are unstaged; nothing was committed. H2–H5 were not implemented.

The requested host surfaces now consume one identity descriptor. Offline checks pass with the exclusions below; live coexistence and the filesystem trace remain unverified. This is not a claim that the entire distribution has no remaining OpenCode paths: the plugin instruction adapter still has a known upstream-root fallback, listed below.

## Mechanism and use

`packages/util/src/identity.ts` has no imports, I/O, or runtime environment reads. It exports the upstream `defaults`, a `Descriptor` type, a build-boundary validator, and `Identity`. The guarded `globalThis.__OPENCODE_IDENTITY__` define selects a complete descriptor before any consumer initializes. There is no post-startup setter or automatic identity-file environment override.

`packages/altimate/identity.json` is the distribution-owned descriptor. The CLI build accepts `--identity=<path>`, validates the JSON, and embeds it using Bun's `define`. A source-only, explicitly selected `packages/altimate/script/identity-preload.ts` imports that JSON and assigns the global before loading host modules. Its descriptor type import is erased; importing the runtime identity module from the preload would initialize it too early. Explicit preloads survive source managed-server spawning, including when the CLI changes into a requested project directory.

From the checkout root, for source development:

```sh
export PATH=/private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/a3ba8813-c4f4-4234-9efe-d5c7103ee560/scratchpad/bun142/bun-darwin-aarch64:$PATH
bun --cwd packages/cli --preload /Users/anandgupta/codebase/altimate-code-v2-host/packages/altimate/script/identity-preload.ts src/index.ts
```

The CLI working directory loads its existing Solid JSX preload from `bunfig.toml`.

From `packages/cli`, when building the distributable in H5:

```sh
bun run script/build.ts --single --identity=../altimate/identity.json
```

The full distributable build was not run here. The offline smoke test used a real `Bun.build` define and executed its JavaScript bundle. A bare source `--define` is useful for isolated tests but is not the documented managed-service development path; use the preload so spawned source processes retain identity. Existing `dev:live` discovers the installed `opencode` service and is not an Altimate coexistence launcher.

| Surface | Upstream default | Altimate descriptor |
| --- | --- | --- |
| App / XDG directory / tmp basename | `opencode` | `altimate-code` |
| Display / home title | `OpenCode` | `Altimate Code` |
| User-agent product | `opencode` | `altimate-code` |
| Env prefixes, preferred first | `OPENCODE_` | `ALTIMATE_CLI_`, `OPENCODE_` |
| Config descriptor basenames, primary first | `opencode` | `altimate-code`, `opencode` |
| Service discovery directory | `opencode` | `altimate-code` |
| latest/dev/beta/next port | `0xc0de` (49374) | `0xa17e` (41342) |
| local channel port | `0xc0df` (49375) | `0xa17f` (41343) |
| Named preview port seed | channel | `altimate-code:<channel>` |
| Session/plugin title prefix | `OC` | `Altimate Code` |
| Binary / target directory / generated package | `opencode` / `cli-darwin-arm64` / `@opencode/cli-darwin-arm64` | `altimate-code` / `altimate-code-darwin-arm64` / `altimate-code-darwin-arm64` |

Global data/cache/config/state roots and tmp use `Identity.app`; the existing node and workerd root calculators already accept that argument and needed no edits. Flock receives the selected state root during import. The stock user-agent format remains `opencode/<channel>/<version>/<client>`; branded uses `altimate-code/...`. The version/channel and internal package names, protocol IDs, basic-auth username, plugin IDs, and schema URLs remain unchanged.

The wide logo is copied verbatim from v1 `packages/tui/src/logo.ts` (ALTIMATE + CODE). The very narrow mark is an A, replacing the upstream O. Width thresholds derive from the selected wordmark while retaining upstream 22/44-column thresholds for stock. Home, unnamed/session, named-session, plugin and mini terminal-title paths are routed; title-clearing behavior is unchanged. ACP `agentInfo.name` uses the display name. ACP's separate terminal-auth command still advertises `opencode`; that was outside the requested agent-info change and needs a later product decision.

## Environment routing and v1 comparison

v2 has no v1-style `Flag` namespace. `cli/src/server-process.ts` assembles the server's environment-derived options; `cli/src/env.ts` owns Effect-backed password resolution and environment filtering. Added `util/src/env.ts` (`Env.keys` and `Env.get`) and used it at the central server option assembly and the CLI/updater/global/config entry boundaries. The prefix array comes from the identity descriptor; existing canonical `OPENCODE_*` names remain in call sites and are mapped centrally. Non-OpenCode names remain literal. No process-wide environment normalization is performed.

The default identity reads only `OPENCODE_*`, preserving undefined and empty strings. The Altimate identity checks `ALTIMATE_CLI_*` first, accepts any nonempty string (including `false`), and falls back to `OPENCODE_*` when the primary is undefined or empty. This matches v1 `packages/core/src/flag/flag.ts:documentedAlias/env`. Existing consumers retain their own parsing (`true`/`1` for boolean switches).

| Case | Primary | Fallback | Selected value for CONFIG, DISABLE_AUTOUPDATE, SERVER_PASSWORD, EXPERIMENTAL_DISABLE_FILEWATCHER | v1 match |
| --- | --- | --- | --- | --- |
| primary only | `primary` | unset | `primary` | yes |
| fallback only | unset | `fallback` | `fallback` | yes |
| both | `primary` | `fallback` | `primary` | yes |
| empty primary | empty | `fallback` | `fallback` | yes |
| false primary | `false` | `true` | `false` | yes |

The experimental row tests generic environment selection, **not a functioning v2 experimental option**: v2.0.29 has no `OPENCODE_EXPERIMENTAL_*` consumer in Core/CLI/TUI. Its current watcher switches are `FILEWATCHER_DISABLE` / `DISABLE_FILEWATCHER`; `FILEWATCHER_DISABLE` is also covered by the matrix. No legacy experimental behavior was invented.

Server passwords continue to use Effect ConfigProviders and `Redacted`, rather than escaping to direct process environment reads. Within each prefix, v2's `PASSWORD` name precedes legacy `SERVER_PASSWORD`; configured prefixes are ordered first, so an Altimate legacy server password also beats an upstream new-name password. Empty primary namespace values fall back. Both password names in both configured namespaces are stripped from session environments. Standalone children receive their generated lease credential under all configured `PASSWORD` names; stdio mode removes all those credential names before tool execution. Auth protocol username `opencode` remains unchanged.

CLI enforced `PRINT_LOGS` and ACP `CLIENT` writes target the primary identity prefix, so inherited primary aliases cannot mask those settings. Mini theme discovery, the DB migration memory guard, and the default TUI handler's client/channel now use the same reader.

## Environment bypass inventory

Exhaustive direct `OPENCODE_*` process-environment reads remaining under `packages/{cli,core,tui,util,client,server}/src` (tests excluded):

| File | Names remaining | Reason/status |
| --- | --- | --- |
| `cli/src/index.ts`; `cli/src/ssh-askpass.ts` | `SSH_ASKPASS_PORT`, `SSH_ASKPASS_TOKEN` | Internal SSH helper IPC; unchanged |
| `cli/src/server-process.ts` | `PTY_HANDOFF` | Internal restart handoff, paired with client serializer; unchanged |
| `cli/src/mini-host.ts` | `DIRECT_TRACE`, `SHOW_TTFD` | Developer tracing/timing; direct read, no Altimate alias |
| `tui/src/app.tsx` | `DRIVE`, `STORY`, `ROUTE`, `FAST_BOOT` | Developer/story controls; direct read, no Altimate alias |
| `tui/src/plugin/builtins.ts` | `STORY` | Story plugin registration; direct read, no Altimate alias |
| `tui/src/editor-zed.ts` | `ZED_DB` | Editor integration override; direct read, no Altimate alias |
| `tui/src/context/editor.ts` | `EDITOR_SSE_PORT` | Editor integration IPC; direct read, no Altimate alias |
| `tui/src/attention-sounds.node.ts` | `NODE_ASSETS_DIR` | Node distribution artifact path |
| `core/src/repository.ts` | `REPO_CLONE_GITHUB_BASE_URL` | Clone integration/test override; direct read, no Altimate alias |
| `core/src/pty/pty.node.ts` | `NODE_PTY_PATH` | Node native artifact path |
| `core/src/image/photon-wasm.node.ts` | `PHOTON_WASM_PATH` | Node native artifact path |
| `core/src/shell/parser-wasm.node.ts` | `TREE_SITTER_WASM_PATH`, `TREE_SITTER_BASH_WASM_PATH`, `TREE_SITTER_POWERSHELL_WASM_PATH` | Node native artifact paths |
| `core/src/filesystem/watcher-binding.ts` | `PARCEL_WATCHER_PATH` | Native artifact path |
| `core/src/persistent-pty/{binary.bun.ts,binary.node.ts,daemon.ts}` | `PTY_BIN` | Persistent terminal helper artifact path |
| `core/src/plugin/provider/opencode.ts` | `API_KEY` | OpenCode provider credentials; explicitly separate product decision in spike plan |

Internal exports also intentionally retain their protocol identifiers: `client/src/pty-handoff.ts` writes `OPENCODE_PTY_HANDOFF`; `core/src/worktree.ts` exports `OPENCODE_WORKTREE_BASE/PATH`; `core/src/{pty.ts,shell.ts}` exports `OPENCODE_TERMINAL`; `core/src/tool/plugin/shell.ts` exports `OPENCODE_SESSION_ID`. Core config variable expansion (`core/src/config/variable.ts`) reads literal user-selected variable names and does not alias arbitrary `{env:...}` expressions.

Outside that host runtime scope, build/release knobs in `packages/script`, CLI build/publish scripts, the npm launcher `OPENCODE_BIN_PATH`, Node artifact bootstrap `cli/vite.node.config.ts`, Desktop/WSL/enterprise/web build and e2e controls remain unchanged. At audit time, the distribution plugin `altimate/src/instructions.ts` and `drivers/src/resolve.ts` also read upstream flags directly; the plugin defaults to an `opencode` config directory. This remains a known H2 integration gap: route those paths/flags or supply explicit instruction options before claiming a no-OpenCode-root trace with the plugin active.


## Config compatibility with v1

Compared directly against v1 `packages/opencode/src/config/config.ts`, `config/paths.ts`, and the MCP command implementation. File orders below are low to high precedence. Basename ordering follows the actual v1 code, including its inconsistent hidden-directory behavior; broader v2 scope/write conventions are retained and called out explicitly. The ancestor and MCP rows are deviations from full v1 compatibility, not exact parity.

| Area | v1 | H1 branded host |
| --- | --- | --- |
| Global config merge | `config.json`, `opencode.json`, `opencode.jsonc`, `altimate-code.json`, `altimate-code.jsonc` | Same basename precedence; v2 does not restore legacy `config.json` support |
| Direct project config | Discovers only `opencode.json` / `.jsonc` | Adds `altimate-code.json` / `.jsonc` after upstream files; Altimate wins |
| Files inside hidden / managed directories | `altimate-code.json`, `altimate-code.jsonc`, `opencode.json`, `opencode.jsonc` | Preserved exactly: OpenCode wins in this scope |
| Hidden directories at one project level | `.altimate-code`, then `.opencode` | Preserved; `.opencode` can override `.altimate-code` |
| Hidden ancestor walk | Nearest to ancestors | Retains v2 ancestors to nearest; does not reproduce v1 ancestor precedence |
| Fresh MCP write | Local `.altimate-code/altimate-code.jsonc`; global `altimate-code.jsonc` (v1's comment claiming JSON is stale) | Retains v2 direct-before-hidden and JSON-before-JSONC targeting; fresh `<selected-directory>/altimate-code.json` |
| Existing MCP write | v1-specific candidate selection | Direct primary JSON/JSONC, direct fallback JSON/JSONC, then hidden primary/fallback roots; existing upstream file remains writable |
| Core config update | Separate v1 path | Existing highest-priority global file, or fresh `altimate-code.jsonc` |
| TUI plugin settings | Different v1 architecture | `cli.json` in the identity-specific global config directory; filename remains `cli.json` |
| TUI local plugins | v1-specific discovery | Global `plugins`, `.altimate-code/plugins`, existing `.opencode/plugins`; primary project directory remains a discovery/watch target even before it exists |
| System / macOS preferences | Different v1 managed architecture | `/etc/altimate-code`, `/Library/Application Support/altimate-code`, `%ProgramData%/altimate-code`; `ai.altimate-code.managed.plist` |

Thus this is basename compatibility, not a complete v1 configuration migration. Unmodified identity retains stock filenames, candidate order, roots and title/logo strings. Explicit `CONFIG_DIR` or config-file overrides can intentionally point anywhere, including an upstream directory.

## Offline verification

All commands ran from package directories with the supplied Bun 1.4.2 first on PATH, using installed dependencies. No new fixture needs a listener. The canonical repository-root `bun run check` finished successfully: 37/37 tasks, lint with warnings and no errors. Astro/Wrangler reported sandbox-denied log-directory writes but returned success. Focused util, core, CLI, TUI, client and Altimate typechecks also passed. `git diff --check` passed.

| Suite | Result | Coverage / exclusions |
| --- | --- | --- |
| Util source tests + global roots/global/session-title/identity/env tests | 99 pass, 1 filtered | All util tests except the network retry case and the separately omitted OTLP listener file |
| Core app | 1 pass | Existing user-agent formatting |
| Core config | 227 pass, 15 filtered | Includes 2 new stock/branded tests of real config loading/writes; excludes listener/native watcher groups |
| CLI config + new identity config | 20 pass | Actual MCP target selection, TUI discovery, CLI config env precedence |
| CLI env + updater unit/install | 44 pass, 5 pre-existing skips | Real Effect password provider matrix, credential filtering, updater regression tests |
| CLI service offline selection | 14 pass, 10 filtered | Ports/config/registration; service listeners excluded |
| TUI discovery/theme/config | 51 pass | Existing discovery, custom/theme and config behavior |
| TUI mini runtime/splash/renderer | 38 pass | Existing runtime behavior and title clearing; does not execute branded title writes |
| Client service decision + contract identity | 6 pass | No listeners |
| Altimate host identity | 3 pass | Stock/Altimate ports/discovery/logo/title values; source child identity after cwd change; actual Bun define smoke |

The util env matrix covers 25 combinations: the requested four suffixes plus v2's current `FILEWATCHER_DISABLE`. CLI password tests separately exercise the actual Effect ConfigProvider, old/new password names, primary precedence and session-env filtering. Identity tests acquire the real Global layer under isolated HOME/XDG/TMPDIR and assert paths and user agents for both identities. They do not replace `fs_usage` or an HTTP echo check.

Known failing/excluded upstream tests:

- An initial unfiltered util run had 99 passes and 2 blocked listener failures (retry and OTLP). The deliberate offline selection above is the final result.
- An initial broader core config run had 231 passes, 1 listener filtered, 10 native-watcher failures and a timeout error. A representative `loads skills when .agents appears after startup` timeout reproduced with original HEAD versions of both touched core config files supplied through a temporary Bun onLoad overlay. No tracked source was reverted for this check.
- `client/test/import-boundaries.test.ts` still fails its expectation that the Effect service eagerly loads Protocol. A diagnostic Bun build substituting original HEAD `service-probe.ts` also reported `protocolInputs: []` (231 inputs). This establishes the same missing dependency condition with the original probe; it was not a full rerun of the baseline test suite. No unrelated boundary-test change was made.
- `cli/test/standalone.test.ts`, service listener cases, ACP wire initialization and `tui/test/app-lifecycle.test.tsx` require listeners and remain live work. Descriptor title values are tested; actual branded title writes and rendering are not claimed as offline-verified.

Reproduce the successful checks (after setting PATH above; each block's comment states its working directory):

```sh
# packages/util
bun test src test/global-roots.test.ts test/global.test.ts test/session-title-fallback.test.ts test/identity.test.ts test/env-identity.test.ts --test-name-pattern '^(?!.*retries a real network failure)' --only-failures

# packages/core (use isolated XDG roots as in the fixtures)
bun test test/app.test.ts
XDG_DATA_HOME=/private/tmp/h1-config-suite2/data XDG_CONFIG_HOME=/private/tmp/h1-config-suite2/config XDG_CACHE_HOME=/private/tmp/h1-config-suite2/cache XDG_STATE_HOME=/private/tmp/h1-config-suite2/state bun test test/config --only-failures --test-name-pattern '^(?!.*(keeps the last resolved wellknown config across failures and restarts until its source is removed|config plugin reloads|native watcher|keeps watching a deleted config file so recreating it reloads))'

# packages/cli (isolated XDG_* roots were also set for config tests)
XDG_DATA_HOME=/private/tmp/h1-cli-suite/data XDG_CONFIG_HOME=/private/tmp/h1-cli-suite/config XDG_CACHE_HOME=/private/tmp/h1-cli-suite/cache XDG_STATE_HOME=/private/tmp/h1-cli-suite/state bun test test/config.test.ts test/identity-config.test.ts --only-failures
bun test test/env.test.ts src/services/updater.test.ts test/updater-install.test.ts --timeout 30000 --only-failures
bun test test/service.test.ts --test-name-pattern 'managed service ports|service disabled|service remote accepts|remote access route|reading a config|local channel stores|service config manages|service filenames|service config migrates|preview registration migration|deleting a managed service registration|corrupting a managed service registration|replacing a managed service registration|service registration replaces'

# packages/tui (isolated XDG_* roots were also set for config tests)
XDG_DATA_HOME=/private/tmp/h1-tui-suite/data XDG_CONFIG_HOME=/private/tmp/h1-tui-suite/config XDG_CACHE_HOME=/private/tmp/h1-tui-suite/cache XDG_STATE_HOME=/private/tmp/h1-tui-suite/state bun test test/plugin-discovery.test.ts test/theme.test.ts test/config.test.tsx test/config-v2.test.tsx --only-failures
bun test test/mini/runtime.test.ts test/mini/splash.test.ts test/util/renderer.test.ts

# packages/client
bun test test/service-decision.test.ts test/contract-identity.test.ts

# packages/altimate
bun test test/host-identity.test.ts

# repository root
bun run check
```

## Patch ledger

Counts are from `git diff --numstat` against the checkout's starting HEAD. New unstaged files use `git diff --no-index --numstat /dev/null <file>` so they are counted without staging. Existing plugin spike patches are inherited and excluded. Every TypeScript upstream diff hunk contains `// altimate: ALT-F01`; new upstream files carry it at the top. Strict JSON `packages/client/package.json` is the one non-comment-capable exception. The lockfile's new dependency has the marker.

Upstream production (including new util modules, excluding lockfile): 32 files, +364/-104.

| File | + | - |
| --- | ---: | ---: |
| `packages/cli/script/build.ts` | 15 | 5 |
| `packages/cli/src/acp/service.ts` | 4 | 1 |
| `packages/cli/src/commands/handlers/acp.ts` | 4 | 1 |
| `packages/cli/src/commands/handlers/default.ts` | 6 | 2 |
| `packages/cli/src/commands/handlers/mcp/add.ts` | 7 | 6 |
| `packages/cli/src/config/config.ts` | 5 | 3 |
| `packages/cli/src/database-path.ts` | 6 | 3 |
| `packages/cli/src/env.ts` | 20 | 5 |
| `packages/cli/src/framework/runtime.ts` | 4 | 1 |
| `packages/cli/src/index.ts` | 6 | 2 |
| `packages/cli/src/server-process.ts` | 24 | 18 |
| `packages/cli/src/services/service-config.ts` | 7 | 3 |
| `packages/cli/src/services/standalone.ts` | 6 | 2 |
| `packages/cli/src/services/updater.ts` | 7 | 2 |
| `packages/cli/src/util/process.ts` | 20 | 1 |
| `packages/client/package.json` | 1 | 0 |
| `packages/client/src/service-probe.ts` | 4 | 1 |
| `packages/core/src/app.ts` | 6 | 2 |
| `packages/core/src/config.ts` | 14 | 6 |
| `packages/core/src/config/discovery.ts` | 26 | 12 |
| `packages/core/src/database/v1-migration.bun.ts` | 4 | 1 |
| `packages/tui/src/app.tsx` | 10 | 4 |
| `packages/tui/src/component/logo.tsx` | 5 | 2 |
| `packages/tui/src/logo.ts` | 4 | 8 |
| `packages/tui/src/mini/runtime.lifecycle.ts` | 5 | 2 |
| `packages/tui/src/mini/theme.ts` | 4 | 1 |
| `packages/tui/src/plugin/discovery.ts` | 4 | 1 |
| `packages/tui/src/util/config-directories.ts` | 17 | 4 |
| `packages/util/src/env.ts` | 19 | 0 |
| `packages/util/src/global.ts` | 9 | 3 |
| `packages/util/src/identity.ts` | 85 | 0 |
| `packages/util/src/observability/logging.ts` | 6 | 2 |

Upstream tests and fixtures: 7 files, +426/-0.

| File | + | - |
| --- | ---: | ---: |
| `packages/cli/test/env.test.ts` | 42 | 0 |
| `packages/cli/test/fixture/identity-config.ts` | 35 | 0 |
| `packages/cli/test/identity-config.test.ts` | 54 | 0 |
| `packages/core/test/config/identity.test.ts` | 59 | 0 |
| `packages/core/test/fixture/config-identity.ts` | 84 | 0 |
| `packages/util/test/env-identity.test.ts` | 55 | 0 |
| `packages/util/test/identity.test.ts` | 97 | 0 |

`bun.lock` already had +48/-223 when work began. It now has +50/-223: H1 adds only the client workspace dependency and its marker (+2/-0); the pre-existing changes are retained. Including that addition, H1 upstream production is **470 changed lines** (366 added, 104 removed), below the plan's 600-line warning for all of H1–H3. Tests and distribution-owned code are excluded from that threshold. H2/H3 still need their own budgets. A potential upstream contract is a dependency-free `HostIdentity` plus ordered environment/config namespaces, provided before module initialization. The new client→util package dependency is pure at the identity import but pulls util's wider package dependencies into a published client installation; measure distribution impact in H5.

Distribution-owned additions are `packages/altimate/identity.json`, `script/identity-preload.ts`, `test/host-identity.test.ts`, `test/fixtures/host-identity.ts`, and this findings file. No internal packages were renamed and no Protocol/HttpApi schema changed, so client generation was not required.

## Still to verify live

1. Run stock and branded services simultaneously with isolated HOME/nondefault XDG roots. Verify default/local ports, registration files, stop/restart independence, source child identity and installed artifact discovery. Preview channels use a namespaced hash, which avoids identical seeds but is not a mathematical port-collision guarantee.
2. Capture `fs_usage` while starting, opening the TUI, running a scripted prompt and exiting. Check all reads and writes, including flock/database/cache/config/state/tmp. Separate intentional project `.opencode` compatibility probes from unintended upstream global roots. With the plugin active, first address its known instruction adapter fallback; no clean trace is claimed yet.
3. Capture logo at very narrow (<32), stacked (32–49), and wide (50+) terminal widths and with short terminal heights. Capture home, fallback session, named session, plugin and mini titles, including title clearing and title-disabled behavior. Compare v1 wordmark appearance through the real terminal renderer.
4. Check built `--version`, outbound user agent using a local echo server, and ACP initialize agent info. Decide whether ACP's separate terminal-auth executable/label should follow identity in a follow-up.
5. Exercise real standalone/server auth with primary/fallback/empty/false values and verify generated child credentials and session-env stripping. Repeat native-watcher reload cases outside the sandbox.
6. H5 must build and run the actual darwin-arm64 distributable, verify binary/output package names and identity, and measure client dependency/artifact size. H1 only tested define substitution in a small bundle.

The requested work-vault copy could not be written: `/Users/anandgupta/obsidian/altimate/Research/` is outside the session's writable roots and approval is disabled. The canonical copy is this file; intended vault destination is `Research/Branded host spike/H1 identity, paths, env and coexistence.md`.
