# S7: native dependency delivery through stock `opencode plugin add`

Date: 2026-10-15. Result: **P (works with zero upstream changes) on darwin-arm64.**

## What ran
1. Local Verdaccio registry (config `s7-probe/verdaccio.yaml`, uplink to npmjs).
2. Published `@altimateai/v2-spike-probe@0.0.1` (`s7-probe/`): a minimal v2 server plugin whose
   `setup` imports `@duckdb/node-api@1.4.4-r.1`, runs `select 42` and writes the result to `$S7_PROBE_OUT`.
3. Installed the **stock** CLI from npm: `npm install @opencode/cli@2.0.29` (binary wrapper, `opencode v2.0.29`).
4. Isolated HOME/XDG dirs with an `.npmrc` pointing the `@altimateai` scope at the local registry.
5. `opencode plugin add @altimateai/v2-spike-probe@0.0.1` → added to `~/.config/opencode/opencode.json`.
6. `opencode serve` + `POST /api/session` for a project directory to activate instance plugins.

## Evidence (`evidence/s7-probe-out.json`)
`{"ok":true,"rows":[[42]],"resolved":".../.cache/opencode/npm/@altimateai/v2-spike-probe@0.0.1/<ts>/node_modules/@duckdb/node-api/lib/index.js","runtime":"bun 1.4.2"}`

- Install ran with lifecycle scripts disabled (`packages/util/src/npm.ts:225`, Arborist `ignoreScripts: true`).
  `@duckdb/node-api` resolves its native binary through the platform optional dependency
  `@duckdb/node-bindings-darwin-arm64`, which installed without scripts.
- The module was loaded from the plugin's own install directory, not from any workspace or global path
  (isolated HOME; resolved path above).
- The legacy `duckdb` npm package would NOT work here: it downloads its binary in an install script
  (S1 finding). **Drivers must use packages with prebuilt platform binaries.**
- Registry selection honors standard npm config (`.npmrc` scope/registry) via `NpmConfig.load`.

## Caveats / not verified
- First server start: the plugin did not activate within ~40 s after creating a session; after a server
  restart it activated immediately. Not root-caused (possibly first-run cache/inventory timing). Worth a
  repro before relying on first-boot behavior.
- Only darwin-arm64 was tested. Linux x64/arm64 and Windows need the same run (DuckDB publishes
  bindings for each; other drivers must be checked individually — e.g. `oracledb`, `snowflake-sdk`
  native parts).
- Probe is a minimal plugin, not the full spike package; bundling the full package (workspace deps
  `@opencode/plugin` as peer, `@altimateai/drivers` bundled) is still to do.
