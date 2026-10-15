# fix(plugin): stop silently dropping directory plugins with package exports

Local draft only. Upstream duplicate search still needs to be done; network access was unavailable. The report below targets v2.0.29. The reduced reproduction is derived from an observed directory-loading failure and source inspection; it has not been run separately.

### Description

A plugin configured by directory path is silently omitted when its server entry is declared only through `package.json` exports. For example, `"./server": "./src/server.js"` works with package-name resolution, but directory resolution only tries root-level `server` and `index` entries. The plugin never reaches setup, and there is no warning about the missing entrypoint. A root-level server shim makes it load.

Expected: honor the package's exports for directory plugins, or report why the configured plugin cannot load. This makes local development of a package with sources under `src/` difficult to diagnose.

Verified source references, all against **v2.0.29**:

- `packages/plugin/src/host.ts:17-43`: `Host.resolve` uses package specifiers when `name` is supplied; otherwise it resolves absolute `server`, `index`, `tui`, and `rpc` paths without reading exports.
- `packages/core/src/config/plugin/source.ts:159-167`: the configured directory is resolved without a package name, then `if (!entrypoints.server) return []` drops it without logging.
- `packages/core/src/plugin/module.ts:112-119`: the later missing-entrypoint error and loading log are never reached for a directory already filtered out.

### Plugins

Only the local `path-plugin-repro` fixture below; no dependencies or TUI entrypoint are needed.

### OpenCode version

v2.0.29.

### Steps to reproduce

1. In an otherwise empty project, create `path-plugin/package.json`:

   ```json
   {
     "name": "path-plugin-repro",
     "version": "1.0.0",
     "type": "module",
     "exports": {
       ".": "./src/server.js",
       "./server": "./src/server.js"
     }
   }
   ```

2. Create `path-plugin/src/server.js`:

   ```js
   export default {
     id: "path-plugin-repro",
     setup() {
       console.error("path-plugin-repro setup reached")
     },
   }
   ```

3. Create the project's `opencode.json`:

   ```json
   { "plugins": [{ "package": "./path-plugin" }] }
   ```

4. Start `OPENCODE_PRINT_LOGS=1 opencode --standalone . 2>plugin-repro.log` with v2.0.29 and open a session to activate the project's plugins. Inspect `plugin-repro.log`: the setup marker is absent, with no diagnostic explaining the omission. The environment flag enables child-server stderr, which is otherwise ignored (`packages/cli/src/services/standalone.ts:29`, v2.0.29).
5. Add `path-plugin/server.js` containing `export { default } from "./src/server.js"`. Restart with the same command and open a session. The setup marker now appears in `plugin-repro.log`. This shim is the workaround; optional TUI/RPC entries need corresponding root shims if used.

### Screenshot and/or share link

None; this is a plugin discovery/logging issue.

### Operating System

Observed on macOS arm64 with Bun 1.4.2; the OS version was not recorded.

### Terminal

Observed in tmux; terminal emulator/version was not recorded.

### Open questions for maintainers

- Should directory plugins follow package exports, or is the root-entry convention intentional?
- Either way, should an explicitly configured directory with no server entry produce a warning?
