# Local mode (`altimate local`)

Run Altimate Code against a local model — no API key, no data leaving your
machine. One command detects your hardware, downloads a verified model and
runtime, starts an OpenAI-compatible server, certifies it end-to-end, and wires
your config so the agent uses it.

```bash
altimate local          # detect, fetch, serve, certify, wire
altimate                # then use the CLI as normal
```

## What you get

- A pinned open 27B coding model in a quantization chosen for your hardware,
  with every artifact SHA-256 verified against a signed recipe.
- A pinned `llama-server` runtime (Metal on Apple Silicon; Vulkan on
  Linux/Windows, which covers NVIDIA, AMD, and Intel GPUs alike).
- Speculative decoding (MTP) enabled where it measurably helps.
- A certification pass before the config is touched: the server must answer
  health, completion, multi-turn, and tool-call probes — if any fail, nothing
  is wired and the reason is printed.

## Supported hardware

| Tier | Hardware | Context | Notes |
|---|---|---|---|
| `laptop-24gb` | Apple Silicon / unified memory, 24GB+ | 131K | the default certified tier |
| `mac-64gb-unified` | Apple Silicon, 64GB+ | 131K | same recipe, more headroom |
| `gpu-24gb-discrete` | discrete NVIDIA/AMD/Intel 22GB+ VRAM (RTX 3090/4090-class) | 49K | certified end-to-end on NVIDIA L4 (Vulkan); context sized so weights + KV fit VRAM alone |
| `dgx-spark-128gb` | NVIDIA DGX Spark (GB10) | 131K | managed: runs the digest-pinned SGLang NVFP4+EAGLE container (~4× llama.cpp); needs Docker + nvidia-container-toolkit |
| `datacenter-80gb` | 80GB+ NVIDIA (A100/H100) | — | prints BF16/FP8 server deployment guidance |

Windows (x64, Vulkan) is wired but **experimental** — the runtime asset is
pinned and unpacked, but we have not yet certified it on physical hardware.
`altimate local doctor` reports certification state honestly on every platform.

Before anything is downloaded, `altimate local` runs a preflight against the
matched tier and prints each check: accelerator memory floor, free disk,
Vulkan loader (Linux), and — for the DGX tier — Docker daemon,
`nvidia-container-toolkit`, and free memory. A fatal check aborts with the
fix spelled out; nothing is fetched or installed until preflight passes.

## Commands

- `altimate local` — full flow. Power flags: `--model`, `--ctx`, `--parallel`,
  `--kv`, `--mtp/--no-mtp`, `--effort`, `--temperature`, `--port`,
  `--no-egress-guard`.
- `altimate local models` — list the model registry and which entry matches
  this machine. The registry is multi-model; more models will be added over
  time, and `--model <id>` selects one explicitly.
- `altimate local status` — managed process + endpoint state, plus the
  effective egress-guard rules.
- `altimate local stop` — graceful stop (SIGKILL only as a last resort).
- `altimate local doctor [--show]` — re-run all certification checks;
  `--show` prints the certificate JSON.
- `altimate local update` — refresh the hash-pinned recipe snapshot
  (falls back to the bundled copy on any error).

## Performance expectations (measured)

| Hardware | Config | Throughput |
|---|---|---|
| MacBook (M-series, 40-core class) | Q4 + MTP | ~19 tok/s |
| DGX Spark (GB10) | SGLang NVFP4 + EAGLE (guidance tier) | ~15–18 tok/s |
| 2× H100 (datacenter guidance) | SGLang FP8 + EAGLE | 270–290 tok/s |

Numbers are single-stream, agent workloads, measured on the pinned revisions —
not vendor benchmarks. Your throughput scales with memory bandwidth.

## Trust model

- Recipes ship inside the CLI and are hash-pinned; `altimate local update`
  only accepts a snapshot whose SHA-256 matches the published pin.
- Model and runtime downloads verify SHA-256 before use; partial downloads
  resume and re-verify.
- The local server binds `127.0.0.1` only. Nothing is exposed to the network.
- **Egress guard** (on by default): wiring local mode adds `ask` rules for the
  web tools (`websearch`, `webfetch`, `codesearch`), so a local-first session
  escalates to the internet only with your per-step approval. Your own
  permission settings are never overwritten, and `--no-egress-guard` removes
  exactly the rules the guard added (nothing else). Scope note: this is a
  *web-tool* guard — shell commands are governed separately by the bash
  permission rules, which default to `ask` for anything not explicitly
  allowlisted.
- Internal machinery stays local too: compaction follows the session model,
  and `small_model` (title generation) is pinned to the local provider when
  you haven't set it — no background step silently calls a cloud model.
- No telemetry is added by local mode; the agent's normal settings apply.

## Troubleshooting

- **"No Phase 1 recipe matches this machine"** — your usable memory is below
  the smallest tier. The message states the floor. Discrete GPUs need ≥22GB
  VRAM; unified-memory machines need ≥20GB free.
- **Server unhealthy after start** — run `altimate local doctor --show` and
  check the failing probe; the most common cause is another process holding
  the port (pass `--port`).
- **Slow first token on long prompts** — prefill is compute-bound on laptops;
  the cache reuses your session prefix, so subsequent turns are much faster.
- **Linux: `llama-server` fails to start** — install your distro's Vulkan
  loader (`libvulkan1`/`vulkan-loader`) and, for NVIDIA, a driver ≥ 535.
