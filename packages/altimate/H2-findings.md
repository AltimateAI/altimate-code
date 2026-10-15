# H2 findings: built-in Altimate plugin (ALT-F02)

Date: 2026-10-15. Checkout: `altimate-code-v2-host`, branch `spike/v2-branded-host`, starting with ALT-F01 at HEAD. Bun 1.4.2. Changes are unstaged; no commit was made.

The branded host now composes the production Altimate server and TUI plugins without plugin configuration. Offline tests execute `warehouse_add` and `sql_execute` on the first prompt, call the real RPC transport, and register the production `/warehouse` command through the real TUI plugin provider. Stock hosts have no Altimate contribution. Live terminal and full distributable acceptance remain H5/manual work.

## Composition mechanism

`@opencode/plugin/host-contributions` is a small typed contract: separate `server` and `tui` arrays of `{ id, protected, plugin: async loader }`. It has type-only imports and empty stock defaults. There is no Altimate import in Core, Server, TUI, or the generic CLI build code.

The distribution owns `packages/altimate/host.ts`, containing lazy imports of `src/server.ts` and `src/tui.tsx`, both with ID `altimate` and `protected: true`. The server entry registers `src/rpc.ts`; the TUI imports that same contract. No separate RPC bootstrap is needed.

- **Source:** the existing `script/identity-preload.ts` selects identity first, then installs the lazy host definitions in `globalThis.__OPENCODE_HOST_PLUGINS__` before the application imports. This keeps identity-sensitive modules and TUI/native dependencies out of preload initialization. H1's source-child command forwarding retains the explicit preload.
- **Compiled build:** `identity.json` names the sibling module with `"hostPlugins": "./host.ts"`. `build.ts --identity=...` resolves it relative to the descriptor before changing cwd. A small Bun `onLoad` plugin replaces the generic contract module with a static re-export of that distribution module. Bun can therefore bundle both lazy entries. Stock builds omit this build hook and retain empty definitions.
- **Server:** `PluginInternal.pre` adapts contributed Promise plugins using `PluginPromise.fromPromise`. They precede SDK, instance, and config plugins in every Location and are reported as builtins. The existing supervisor performs duplicate-ID rejection. Protected IDs are included in `guarded`.
- **TUI:** `loadBuiltins()` merges contributions into its independent builtin list. Reconciliation carries protection metadata through reload and registration. It does not rely on the server's builtin inventory, which the TUI intentionally does not discover as external plugins.

The contract is process/build initialization, not a mutable configuration API. Use the preload for source runs and `--identity` for builds; an identity-only raw `--define` does not install the companion composition module. The SDK tests use the same generic Core bootstrap without explicitly passing Altimate as an SDK plugin.

```sh
export PATH=/private/tmp/claude-501/-Users-anandgupta-codebase-altimate-code/a3ba8813-c4f4-4234-9efe-d5c7103ee560/scratchpad/bun142/bun-darwin-aarch64:$PATH

# Source, from checkout root; CLI bunfig supplies the Solid preload.
bun --cwd packages/cli --preload /Users/anandgupta/codebase/altimate-code-v2-host/packages/altimate/script/identity-preload.ts src/index.ts

# Distributable build, from packages/cli (not executed as a full build in H2).
bun run script/build.ts --single --identity=../altimate/identity.json
```

## Protection policy and evidence

| Case | Implemented behavior | Offline test |
| --- | --- | --- |
| Fresh config, first prompt | Builtin setup completes before prompt execution; both warehouse tools are advertised in the first scripted model request and execute real DuckDB SQL returning `42`. | `altimate/test/h2-host.test.ts`: `fresh` |
| RPC | `AltimateRpc.listWarehouses` and `lastResult` work through the SDK's real in-process HTTP router; no listener or direct RPC-handler invocation. | H2 `fresh`, `collision`, `lifecycle`; existing S8 RPC suite |
| TUI registration | Real `PluginProvider` registers the production `altimate` builtin and `altimate.warehouse` command with no plugin config. | `tui/test/host-contributions.test.ts`: `branded`; existing S8 component tests render production panel |
| SDK/user plugin with same ID | Host builtin wins; later definition is reported as failed with `Duplicate plugin ID`. Replacement setup does not execute. | H2 `duplicate` |
| Server-config plugin with same ID | Same first-definition policy for a real local directory configured in `altimate-code.json`; configured replacement setup does not execute. | H2 `config-duplicate` |
| TUI-config plugin with same ID | Replacement is rejected with a failed plugin entry identifying the protected ID. `/warehouse` remains registered. | TUI `branded`, real loaded duplicate module |
| Another plugin adds `sql_execute` or `warehouse_add` | Registration is rejected and logged as an error. Tool transforms capture plugin ownership; replay preserves the original protected tool. No namespacing. | H2 `collision` runs both tools, asserts DuckDB result and that neither replacement executor ran; `core/test/plugin/host-protection.test.ts` exercises both names and replay |
| Server exact and wildcard disable | `-altimate` and `-*` cannot remove it. The wildcard fixture reenables ordinary host/model plugins so the scripted prompt can run. | H2 `exact`, `wildcard`, using actual config |
| TUI exact/wildcard selectors and manual disable | Protected contribution ignores matching removal selectors; manual `deactivate("altimate")` rejects with a clear error. Internal teardown is retained for reload/shutdown. | TUI `branded`: `-altimate`, `-*`, `-altimate.*`, manual deactivate. The last selector is a namespace selector and does not itself match bare `altimate`. |
| `plugin list --builtin` | Server builtin appears from actual server inventory; CLI also lists the contributed TUI entry as `builtin (tui)`. Normal listing hides those builtin rows. | H2 server inventory assertion; `cli/test/plugin-host-contributions.test.ts` formatter with actual branded preload. Full CLI list transport needs a live server. |
| `plugin remove altimate` | Prints `Plugin "altimate" is a protected host builtin and cannot be removed`; does not edit server or TUI config. | Actual CLI subprocess under branded preload, with existing config checked unchanged |
| Server setup throws | Logs an Error naming the protected plugin, retains the original cause in failed plugin inventory, and blocks readiness/prompt execution. No scripted model calls occur. | H2 `throw` uses a throwing host definition; Core test verifies failure and recovery |
| TUI setup/import throws | Logs and shows an explicit error toast naming the protected plugin and original failure. It cannot silently disappear. Other UI infrastructure can remain available. | TUI `throw` and `load-throw` |
| Reload | Server supervisor reactivation and tool-state replay retain the builtin. TUI config reconciliation and structural generation changes retain/reinstall the protected builtin and command. | H2 `lifecycle` uses SDK registration to trigger the real supervisor; Core replay test; TUI `branded` adds/removes another plugin |
| Second Location | Independently bootstraps Altimate with isolated warehouse state. | H2 `lifecycle`, real RPC call in another directory |
| Restart | Closing/recreating the in-process SDK host reactivates the builtin, restores registered warehouses, and runs another real query. | H2 `lifecycle`; managed-service/process restart remains live verification |
| Stock identity | Empty contributions, no warehouse tools/RPC, no Altimate TUI registration. Ordinary unprotected tool overwrite semantics remain unchanged. | H2 `stock`, TUI `stock`, Core stock-overwrite test, stock compiled fixture |

Protection is against configuration removal and accidental name collisions, not malicious plugin isolation. Tool `editor.update` and `editor.remove`, arbitrary hooks, and competing RPC registrations retain upstream semantics; they are not a security boundary. The task's conflicting **add** case is protected and executed in tests.

The server failure is clear in host logs and plugin inventory. The existing Promise HTTP client still exposes a sanitized `UnexpectedStatus: 500` for a prompt blocked by this defect; this change does not add a public error schema or regenerate the client. A future API improvement could return a declared unavailable/error response. The host does not proceed without mandatory tools.

## Identity gap fixed

`altimate/src/instructions.ts` uses `Env.get` for `TEST_HOME`, `CONFIG_DIR`, `DISABLE_PROJECT_CONFIG`, `DISABLE_CLAUDE_CODE`, and `DISABLE_CLAUDE_CODE_PROMPT`, and `Identity.app` for the default global config directory. `drivers/src/resolve.ts` uses `Env.get` for `TEST_HOME`; its driver storage was already under `altimate-code`. Both packages now declare their `@opencode/util` dependency, mirrored in `bun.lock`.

The new instruction identity subprocess matrix executes the actual SDK instruction hooks for stock and branded runs: default roots, primary/fallback precedence, empty primary fallback, `false` primary overriding `true` fallback, both Claude switches, and driver home resolution. Existing instruction tests continue to pass. This closes the named H1 gap; it does not replace the planned live filesystem trace or remove intentional upstream config-basename compatibility probes.

## Validation

All tests use installed dependencies and the supplied Bun 1.4.2. No listener-dependent success is claimed. The host tests use the in-process SDK; TUI tests mount the real provider/command registration with the existing test transport/context fixtures. They do not establish terminal keyboard dispatch. Build tests verify the actual server/TUI/RPC source graph and execute a miniature compiled stock/branded artifact without a preload. Native dependency packaging and the full CLI artifact remain H5.

The canonical root **`bun run check` passes, 37/37 tasks** (lint warnings, no lint/type errors). Wrangler printed sandbox-denied writes to its external log directory but returned success. `git diff --check` passes. No public Protocol or Server HttpApi definition changed, so client generation is not required.

| Package/check | Final result | Scope and receipt |
| --- | --- | --- |
| Altimate complete suite | **63 pass, 1 existing live-test skip, 0 fail** | Nine H2 server scenarios, both instruction identity subprocess matrices, all existing S1–S8 tests; [receipt](evidence/h2-altimate-tests.txt) |
| Core plugin/tool offline selection | **304 pass, 1 filtered, 0 fail** | 42 files; exact file list/command in [receipt](evidence/h2-core-tests.txt) |
| TUI relevant offline suites | **128 pass, 1 filtered, 0 fail** | Host contribution, discovery/source, markdown/model/select/composer/dialog, config, runtime; [receipt](evidence/h2-tui-tests.txt) |
| CLI relevant offline suites | **32 pass, 0 fail** | Host contributions/build, CLI list/remove, config/env/identity, import boundaries; [receipt](evidence/h2-cli-tests.txt) |
| CLI help/target rerun with isolated HOME/XDG | **9 pass, 22 filtered, 0 fail** | Previously unwritable default-HOME cases; [receipt](evidence/h2-cli-help-tests.txt) |
| Util existing offline selection | **99 pass, 1 filtered, 0 fail** | Identity/env/roots and source tests; [receipt](evidence/h2-util-tests.txt) |
| Plugin complete suite | **9 pass, 0 fail** | [Receipt](evidence/h2-plugin-tests.txt) |
| Repository lint/typecheck | **37/37 tasks pass** | [Receipt](evidence/h2-check.txt) |

Drivers has no package test/typecheck script. Its changed behavior is exercised by the instruction identity subprocess tests; the repository check also typechecks its Altimate consumers.

Broader existing suites were run, not reported as clean: Core's unfiltered plugin run had 362 pass, 101 fail, and 1 error from listener fixtures and a native-watcher timeout. The final Core selection excludes ten listener fixture files and filters `watches creation of an external helper`. Full TUI had 1380 pass, 2 skips, and 92 failures: 90 blocked listeners, one real-watcher atomic-save timeout, and one cross-client session-tab propagation timeout. Full CLI had 238 pass, 9 skips, and 98 failures: 84 direct listener failures, two TCP-listen `EPERM`s, three service/standalone child listener startup failures, and nine default-HOME log-write failures. Those nine pass unchanged with writable HOME/XDG roots. The watcher and cross-client cases remain live verification; H2 does not claim a clean full TUI suite. Unfiltered diagnostic logs are retained at `/private/tmp/altimate-h2-{core-broad,tui-suite,cli-suite}.log`.

Reproduce after selecting Bun 1.4.2 (working directories shown):

```sh
# packages/altimate
bun test --only-failures

# packages/plugin
bun test --only-failures

# packages/util
bun test src test/global-roots.test.ts test/global.test.ts test/session-title-fallback.test.ts test/identity.test.ts test/env-identity.test.ts --test-name-pattern '^(?!.*retries a real network failure)' --only-failures

# packages/tui
bun test --timeout 30000 --only-failures test/host-contributions.test.ts test/plugin-discovery.test.ts test/plugin-source.test.ts test/plugin-markdown.test.tsx test/plugin-model.test.tsx test/plugin-select.test.tsx test/plugin-composer.test.tsx test/cli/tui/plugins-dialog.test.tsx test/config.test.tsx test/config-v2.test.tsx test/runtime.test.tsx --test-name-pattern '^(?!real watchers observe)'

# packages/cli, with HOME and XDG_* set to writable temporary roots
bun test --timeout 30000 --only-failures test/plugin-host-contributions.test.ts test/host-contributions.test.ts test/config.test.ts test/env.test.ts test/identity-config.test.ts test/import-boundaries.test.ts

# repository root
bun run check
```

Core's complete selected command is the first line of its receipt; run it from `packages/core` with isolated HOME/XDG roots. The source fixture environment sets its own temporary auxiliary roots. No new test opens a listener.

## Patch ledger

Counts are relative to the starting HEAD (`git diff --numstat`); new unstaged files are counted with `git diff --no-index --numstat /dev/null <file>`. Inherited H1/ALT-P01/ALT-P02 changes are excluded. Upstream TypeScript hunks carry `// altimate: ALT-F02`; no new markers are inserted in JSON or lockfiles.

Upstream production: **13 files, +243/-20 = 263 changed lines**.

| File | + | - |
| --- | ---: | ---: |
| `packages/cli/script/build.ts` | 9 | 0 |
| `packages/cli/script/host-contributions.ts` | 17 | 0 |
| `packages/cli/src/commands/handlers/plugin/list.ts` | 14 | 1 |
| `packages/cli/src/commands/handlers/plugin/remove.ts` | 11 | 0 |
| `packages/core/src/plugin.ts` | 26 | 5 |
| `packages/core/src/plugin/internal.ts` | 32 | 3 |
| `packages/core/src/plugin/service.ts` | 2 | 0 |
| `packages/core/src/tool.ts` | 29 | 3 |
| `packages/plugin/src/host-contributions.ts` | 22 | 0 |
| `packages/tui/src/plugin/builtins.ts` | 23 | 0 |
| `packages/tui/src/plugin/context.tsx` | 50 | 8 |
| `packages/tui/src/plugin/host-error.ts` | 3 | 0 |
| `packages/util/src/identity.ts` | 5 | 0 |

The distribution-owned driver adjustment is `drivers/src/resolve.ts` +4/-1 and `drivers/package.json` +2/-1. `bun.lock` adds two workspace dependency lines. Other distribution changes are `altimate/host.ts`, descriptor/preload glue, instruction routing, fixtures/tests, and this report. Upstream tests are separate from the production budget: **6 files, +551/-0**.

H1 reported 470 changed upstream production lines including its lockfile addition. H2 adds 263 (plus two lockfile lines): the combined total is approximately **735**, already beyond the plan's 600-line warning before H3. This is a warning, not a pass/fail threshold. The candidate upstream contract is typed host contributions with immutable protection metadata, coupled to builtin activation/readiness and registration ownership; most policy code could then disappear from the downstream patch queue.

## Manual/live verification remaining

1. Start the branded source TUI from fresh HOME/nondefault XDG roots using the documented preload, with no plugin config. In a new session invoke `warehouse_add` and `sql_execute("SELECT 42")`, then `/warehouse`. Check narrow/wide layout, refresh, full screen, close, and terminal keyboard dispatch.
2. Against that branded service, run `plugin list --builtin`; confirm both `altimate ... builtin` and `altimate ... builtin (tui)`. Run `plugin remove altimate` and confirm the protected message. Offline tests already execute remove; list's real service connection still needs this check.
3. Restart the managed service/process and enter a second project/Location. Reconfirm tools and `/warehouse`. SDK close/recreate and second-Location tests are supplementary.
4. With a throwing distribution server/TUI entry, inspect the actual server log and TUI error presentation. Server prompt HTTP errors remain generic 500 even though the log/inventory identifies the cause.
5. H5: build/copy the entire distributable to an unrelated directory with no source/dependency overrides; verify lazy DuckDB resolution and native sidecars, RPC/panel first use, size and startup budgets. A compiled loader fixture is not full packaging acceptance.
6. Repeat H1's filesystem trace with the plugin active. Intentional project compatibility discovery may still inspect upstream basenames; default plugin instruction and driver roots now follow the selected identity.

The requested Obsidian work-vault copy cannot be written in this session: `/Users/anandgupta/obsidian/altimate/Research/` is outside the writable roots and approval is disabled. This file is canonical; intended copy: `Research/Branded host spike/H2 built-in Altimate plugin.md`.
