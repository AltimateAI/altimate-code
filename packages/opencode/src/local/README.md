# Certified local data agent (`altimate local`)

## Purpose

Phase 1 manages one pinned, OpenAI-compatible `llama-server` for Altimate Code. It detects supported laptop hardware, downloads and verifies the selected GGUF, locates or installs the pinned llama.cpp runtime, health-gates startup, certifies the endpoint, and wires the user config.

The module is intentionally single-model and single-user. It does not integrate Ollama or LM Studio, and the datacenter/vLLM tier only prints deployment guidance.

## Commands

- `altimate local` — select a recipe, fetch verified artifacts, start the server, certify it, and update the user config.
- `altimate local status` — print managed process and endpoint state.
- `altimate local stop` — send `SIGTERM`, wait, and use `SIGKILL` only if the managed process does not exit.
- `altimate local doctor [--show]` — force all certification checks to run again; `--show` prints the certificate JSON.
- `altimate local update` — refresh a hash-pinned recipe snapshot and fall back to the bundled copy on any error.

Power options on the root command mirror the recipe fields: `--ctx`, `--parallel`, `--kv`, `--mtp/--no-mtp`, `--effort`, `--temperature`, and preferred `--port`.

## State and trust boundaries

Runtime state lives under `~/.local/share/altimate-code/local/` (or `$XDG_DATA_HOME/altimate-code/local/`):

- `state.json`, `server.pid`, and `server.log` describe the managed child.
- `models/` and `downloads/` contain GGUFs and runtime archives.
- `bin/b10516/` contains the extracted llama.cpp release.
- `certificates/<key>.json` is keyed by model sha256, runtime version, and server-flags hash.
- `environment.json` enables the recipe's lexical tool retrieval on later CLI launches.

Every downloaded model and runtime archive must have a 64-character sha256. The bundled snapshot deliberately uses clearly named `TODO_*` placeholders where the upstream checksum was unavailable during implementation; those values fail closed before a network request. A verified remote recipe can replace them.

Set both variables to test the Phase 1 recipe refresh stub:

```sh
export ALTIMATE_LOCAL_RECIPES_URL=https://example.com/recipes.json
export ALTIMATE_LOCAL_RECIPES_SHA256=<sha256-of-exact-response-bytes>
altimate local update
```

`ALTIMATE_LOCAL_HF_BASE_URL` changes the Hugging Face-compatible artifact base. `ALTIMATE_LOCAL_LLAMA_SERVER` selects an existing executable. `ALTIMATE_LOCAL_RUNTIME_URL` and `ALTIMATE_LOCAL_RUNTIME_SHA256` provide a pinned runtime mirror pair.

## Module map

- `recipes.ts` / `recipes.json` — schema-v1 validation, bundled snapshot, and pinned refresh.
- `hardware.ts` — macOS unified-memory and Linux NVIDIA/RAM probes plus tier matching.
- `fetch.ts` — resumable HTTP Range downloads and sha256 verification.
- `runtime.ts` — runtime discovery and b10516 archive installation.
- `server.ts` — port selection, detached process state, health polling, and safe shutdown.
- `certify.ts` — tool-call round trip, reasoning render, 8K prefill, and certificate cache.
- `wire.ts` / `environment.ts` — provider/agent JSONC updates and persistent tool-retrieval default.
- `command.ts` — CLI orchestration only.

## Tests

Focused tests live in `test/local/` and use temporary files, loopback sockets, and mocked HTTP responses. They never download model or runtime artifacts.
