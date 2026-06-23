# Reproducing altimate-code on ADE-Bench

This folder contains everything you need to plug altimate-code into [ADE-Bench](https://github.com/dbt-labs/ade-bench) (dbt Labs's Analytics & Data Engineering benchmark) and reproduce the **81.3% pass rate** reported in [`../../research/kimi-k26-ade-bench-2026-05-10/findings.md`](../../research/kimi-k26-ade-bench-2026-05-10/findings.md).

It deliberately does **not** ship the trace files, the per-trial result JSONs, the seed DuckDB databases, or the prebuilt 130 MB tarball — those are either large binaries or run outputs. Everything here is source code + scripts + 4 short patches against upstream ade-bench. Run the steps below and you'll get equivalent data.

## What's in this folder

```text
benchmark/ade-bench/
├── README.md                              ← you are here
├── altimate_code_agent/                   ← drop-in agent module for ade-bench
│   ├── __init__.py
│   ├── altimate_code_agent.py             ← the AltimateCodeAgent class
│   ├── altimate-code-setup.sh             ← installs altimate-code inside the trial container
│   └── build-local-tarball.sh             ← builds the linux/x64+arm64 tarball from source
└── patches/                               ← 4 small patches to upstream ade-bench
    ├── 01-agent_name.py.patch
    ├── 02-agent_factory.py.patch
    ├── 03-installed_agents_init.py.patch
    └── 04-agent_setup.py.patch
```

The agent module is ~280 lines of Python + ~80 lines of shell. The 4 patches add a total of ~12 lines across the upstream tree. Nothing here is benchmark-targeted — the agent module just wires altimate-code into ade-bench's pluggable `--agent` mechanism the same way the upstream `claude`, `codex`, `gemini`, and `macro` agents are wired in.

## Prerequisites

- **Docker Desktop** ≥ 4.0, configured with **≥ 8 GiB memory** (12 GiB recommended for concurrency=6). Lower than 6 GiB causes `npm install` inside the trial container to OOM-swap and trip the setup timeout.
- **macOS, Linux, or WSL2.** Apple Silicon is fine — the tarball builder produces both linux/amd64 and linux/arm64 binaries so the container runs natively on either host arch.
- **bun ≥ 1.3** on the host (`brew install oven-sh/bun/bun` or [bun.sh](https://bun.sh)) for building the altimate-code tarball.
- **Python ≥ 3.10** and [`uv`](https://docs.astral.sh/uv/getting-started/installation/) for the ade-bench harness.
- **`gh` CLI** authenticated to GitHub (used to download ade-bench's shared seed databases).
- **An OpenRouter API key** (`OPENROUTER_API_KEY`). Any LLM provider altimate-code supports will work; the published results use `moonshotai/kimi-k2.6-20260420` via OpenRouter, baseURL `https://openrouter.ai/api/v1`.

## End-to-end reproduction (~30 min setup + ~1–2 h benchmark)

```bash
# === 0. Clone altimate-code (this repo) and ade-bench side by side ===
mkdir -p ~/ade-bench-repro && cd ~/ade-bench-repro
git clone https://github.com/AltimateAI/altimate-code
git clone https://github.com/dbt-labs/ade-bench
cd ade-bench

# === 1. Wire altimate-code into ade-bench ===
# a) Drop the agent module in:
cp -r ../altimate-code/benchmark/ade-bench/altimate_code_agent \
      ade_bench/agents/installed_agents/altimate_code

# b) Apply the 4 small patches that register the agent + route AGENTS.md to it:
for p in ../altimate-code/benchmark/ade-bench/patches/*.patch; do
  git apply "$p"
done

# === 2. Install the ade-bench harness ===
uv venv && source .venv/bin/activate
uv pip install -e .

# === 3. Download the shared seed databases ===
mkdir -p shared/databases/duckdb
gh release download databases --repo dbt-labs/ade-bench \
  --pattern "*.duckdb" --dir shared/databases/duckdb

# === 4. Build the altimate-code tarball from source ===
# Produces ade_bench/agents/installed_agents/altimate_code/altimate-code-local.tgz
# (~130 MB, contains linux/amd64 + linux/arm64 binaries + skills + dbt-tools)
./ade_bench/agents/installed_agents/altimate_code/build-local-tarball.sh

# === 5. Run the benchmark ===
export OPENROUTER_API_KEY=sk-or-v1-...
export DEFAULT_AGENT_TIMEOUT_SEC=1800     # 30 min wall cap per trial
export SETUP_TIMEOUT_SEC=300              # 5 min cap on dbt-deps + altimate-code install
export DEFAULT_TEST_TIMEOUT_SEC=120       # test-phase cap

ade run all \
  --db duckdb \
  --project-type dbt \
  --agent altimate \
  --model openrouter/moonshotai/kimi-k2.6-20260420 \
  --no-rebuild \
  --n-concurrent-trials 6 \
  --max-episodes 80
```

After the run, `ade view` opens the local HTML dashboard with per-trial detail (transcript, file diffs, dbt test output, cost & token counts).

## How the agent module works

`altimate_code_agent.py` defines `AltimateCodeAgent(AbstractInstalledAgent)`, which:

1. **`_install_agent_script`** returns the path to `altimate-code-setup.sh`. ade-bench copies the script into `/installed-agent/install-agent.sh` inside each trial container and sources it.
2. **`perform_task`** (overridden) also copies the locally-built tarball to `/installed-agent/altimate-code-local.tgz` before invoking the install script. Inside the container, `altimate-code-setup.sh` does `npm install -g /installed-agent/altimate-code-local.tgz`, picks the right per-arch binary (`uname -m`), and writes `~/.config/altimate-code/altimate-code.json` with the OpenRouter provider config.
3. **`_run_agent_commands`** emits `altimate-code run --format json --yolo --model <model_id> --max-turns 80 <task_prompt>` and tee's the JSON event stream so the harness can parse per-step token counts, cost, and tool usage.
4. **`AltimateCodeParser`** reads `step_finish` events out of the JSON stream and aggregates per-trial cost, runtime, turn count, input/output/cache token totals.
5. **`AltimateCodeLogFormatter`** renders a human-readable transcript for the per-trial HTML dashboard.

The 4 patches register `AgentName.ALTIMATE_CODE = "altimate"` and route the shared `AGENTS.md` baseline config (the same file Codex receives) into the container — putting altimate-code on equal footing with the other benchmarked agents.

## Knobs

Most behavior comes from environment variables read by the ade-bench harness and altimate-code's setup script. The relevant ones:

| Variable | Default | What it controls |
|---|---|---|
| `OPENROUTER_API_KEY` | (required if `--model openrouter/...`) | OpenRouter API key. Baked into `~/.config/altimate-code/altimate-code.json` at container setup time. |
| `OPENROUTER_MODEL_ID` | `moonshotai/kimi-k2.6-20260420` | Override only if you want a different OpenRouter-routed model. The `--model` flag must match: `openrouter/<this-id>`. |
| `AZURE_RESOURCE_NAME` + `AZURE_API_KEY` | unset | Optional. If both are set, an `azure-foundry` provider is also registered against `https://<resource>.services.ai.azure.com/openai/v1`. Lets you A/B against an Azure-hosted Kimi or other Foundry deployment. |
| `AZURE_DEPLOYMENT_NAME` | `Kimi-K2.6` | Azure Foundry deployment name (used only if Azure env vars are set). |
| `DEFAULT_AGENT_TIMEOUT_SEC` | 180 (upstream); set to **1800** for these runs | Wall-clock cap per trial. Kimi-K2.6 spends ~89% of wall time reasoning; lower caps will cause hard tasks to time out. |
| `SETUP_TIMEOUT_SEC` | 120 (upstream); set to **300** | Cap on the install phase. With ≥ 8 GiB Docker memory you rarely need more than 60 s; 300 s gives a margin under concurrent load. |
| `DEFAULT_TEST_TIMEOUT_SEC` | 30 (upstream); set to **120** | Cap on the post-agent dbt-test phase. A few tasks have ~15 sub-tests that exceed 30 s on the first run. |

`--n-concurrent-trials 6` was the sweet spot for a 12 GiB Docker / 8 CPU host. Higher concurrency works on a beefier host but `npm install` inside each container is the main bottleneck — 6 simultaneous installs comfortably finish in ~30 s; 10 starts to thrash.

## Troubleshooting

- **`agent_setup_timeout` on most trials.** Bump Docker memory. Symptom is `npm install -g /installed-agent/altimate-code-local.tgz` swapping for minutes. Anything below 6 GiB will do this.
- **`Error response from daemon: 500 ...` from Docker.** Container created during memory pressure. Same fix: bump Docker memory + restart Docker Desktop.
- **`Cannot find package @altimateai/altimate-code-linux-arm64` during npm install.** You're running an older copy of `altimate-code-setup.sh` that expected the per-arch optionalDependencies layout. Re-copy the script from `altimate_code_agent/altimate-code-setup.sh` — it uses the cached-binary trick that ships both archs inside one tarball.
- **`OSError: [Errno 63] File name too long: 'tasks/airbnb007 airbnb009 ...'`** when re-running specific tasks. Caused by shell-quoting in some setups; pass each task ID as a separate argv item, not a single space-separated string.
- **Pass rate noticeably lower than 81.3% on a fresh run.** First check: did the agent actually call OpenRouter (not a stale Azure config)? Inside one of the trial containers, `cat ~/.config/altimate-code/altimate-code.json | jq '.provider | keys'` should list `openrouter`. Second: are you using `--n-concurrent-trials 1` against the original Azure deployment by mistake? That hit 100 K TPM throttling in early runs.

## What's intentionally NOT in this folder

- **Trace data / `results.json` / `agent.log`** — those live under `experiments/` after a run. Re-run to regenerate.
- **The 130 MB built tarball (`altimate-code-local.tgz`)** — rebuild with `build-local-tarball.sh` (~5–10 min the first time, ~30 s on subsequent builds while bun cache is warm).
- **Seed databases (`*.duckdb`)** — pulled from `dbt-labs/ade-bench` GitHub releases by step 3 above. They're large (300–500 MB total).
- **Per-task ground-truth seeds and test SQL** — those live in upstream ade-bench's `tasks/<id>/` and are never sent to the agent during a run.

## Pointers

- The behavioral analysis of the run: [`../../research/kimi-k26-ade-bench-2026-05-10/findings.md`](../../research/kimi-k26-ade-bench-2026-05-10/findings.md)
- altimate-code source: this repository
- ade-bench source: https://github.com/dbt-labs/ade-bench
- OpenRouter Kimi-K2.6 model card: https://openrouter.ai/moonshotai/kimi-k2.6-20260420
