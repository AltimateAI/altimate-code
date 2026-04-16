---
name: dev-workflow
description: How to run altimate-code inside a harness sandbox pod — base image, clone, setup, start command, health check, exposed port.
user_invocable: false
---

# Dev Workflow — altimate-code

altimate-code is an open-source agentic data engineering tool (CLI + optional HTTP server) for dbt, SQL, and cloud warehouses. It is a TypeScript monorepo using Bun as the runtime and package manager, with Turbo for task orchestration. The main package is `packages/opencode` which produces the `altimate-code` CLI binary.

Running locally means cloning the repo, running `bun install` to fetch dependencies, then either running the CLI directly via `bun run dev` or starting a headless HTTP server via `bun run --cwd packages/opencode --conditions=browser src/index.ts serve`.

## Architecture

altimate-code is self-contained with no external service dependencies. It uses:

- **SQLite** (via drizzle-orm) for local session/state storage — embedded, no sidecar needed
- **Bun** as the runtime and package manager (version 1.3.10)
- **Hono** as the HTTP framework when running in server mode
- **tree-sitter** for code parsing (native binary addon)

There are no database sidecars, no Redis, no message queues. The tool operates as a standalone CLI or headless server. When running as a server (`serve` command), it uses Bun.serve and listens on a configurable port (defaults to trying port 4096, falls back to a random port).

The monorepo workspace packages are:
- `packages/opencode` — the main CLI/server (the one we build and run)
- `packages/plugin` — plugin system
- `packages/script` — build scripts
- `packages/util` — shared utilities
- `packages/sdk/js` — JavaScript SDK
- `packages/dbt-tools` — dbt integration tools
- `packages/drivers` — database driver adapters (optional deps)

## Two-phase sandbox lifecycle

| Phase | Marker file | What's available |
|---|---|---|
| **Phase 1: code-ready** | `/workspace/.code-ready` | Source code, `node_modules`, linters, `bun test` |
| **Phase 2: server-ready** | `/workspace/.server-ready` | Server on :4096, `curl /global/health`, hot reload active |

`harness spawn` returns at phase 1 (~10s with base image). Server starts with `bun --hot` for live module reloading — file changes reflect immediately without restart.

**Before running curl or verifying server behavior**, check phase 2:
```bash
test -f /workspace/.server-ready && echo "ready" || echo "still starting..."
```

## What happens on sandbox create

1. The init containers mint a GitHub token and clone the repo into `/workspace/altimate-code`.
2. The main container runs `bun install` (near-instant with base image pre-baking deps).
3. `.code-ready` is touched — the agent can now read/write code, run linters, run tests.
4. The server starts with `bun --hot` for live module reloading on file changes.
5. Once the server binds port 4096, `.server-ready` is touched.
6. Agent edits source → bun hot-swaps modules → `curl` shows updated response immediately.

## Sandbox Contract

```yaml
repo: altimate-code
repo_url: https://github.com/AltimateAI/altimate-code.git
base_image: altimateacr.azurecr.io/altimate-code-base:latest
working_dir: /workspace/altimate-code
port: 4096
health_path: /global/health

# altimate-code is a standalone tool — it does not expose services consumed
# by other sandboxes in the typical Altimate stack.
provides: []

# No upstream dependencies. altimate-code is a leaf in the sandbox DAG.
needs: []

sidecars: []

host_aliases: {}

setup_commands:
  - name: install-deps
    cmd: bun install

start_command: bun --hot run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096 --hostname 0.0.0.0
```

## Verification

Before creating a PR, verify in the running sandbox. Use the `verify-changes` skill for the full process.

### Always check

```bash
# 1. Run tests
cd /workspace/altimate-code/packages/opencode && bun test --timeout 30000
# Include output summary in PR body

# 2. Health endpoint
curl -sf localhost:4096/global/health
# Expected: {"healthy":true,"version":"local"}
```

### For server/API changes

```bash
# Make change → bun --hot reloads automatically (~1-3s)
# Then curl the affected endpoint
curl -sf localhost:4096/<endpoint>
# Include request + response in PR body
```

### For CLI changes

```bash
# Run the CLI command and capture output
cd /workspace/altimate-code
bun run --cwd packages/opencode --conditions=browser src/index.ts <command>
# Include output in PR body
```

### Test command

```bash
cd /workspace/altimate-code/packages/opencode && bun test --timeout 30000
```

## Troubleshooting

- **`bun install` hangs or fails**: The base image pre-bakes `node_modules` and the bun cache. If lockfile drift causes a full re-resolve, it may be slow. Rebuild the base image with the latest `bun.lock`.
- **tree-sitter native addon issues**: The base image includes the linux-x64 prebuilds. If you see `Cannot find module 'tree-sitter'`, the base image may need rebuilding for the correct platform.
- **Port conflict on 4096**: The server falls back to port 0 (random) if 4096 is taken. If the harness expects 4096, ensure no other process binds it first.
- **SQLite migration on first run**: On first launch, altimate-code runs a one-time SQLite migration. This is automatic and takes a few seconds. The server won't be ready until it completes.
- **`bun-pty` build failures**: This native addon requires build tools. The base image includes `build-essential` to handle this.
