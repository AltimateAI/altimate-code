# Real-model spend tracker ($50 hard cap). Append one line per real-model batch.
# Only PHASE 4 spends. Stop spawning real-model runs when cumulative >= $45 (leave $5 buffer).
total_spent_usd: 0.00

## Real-model paths validated (2026-06-23 night):
- FREE: local Ollama qwen3-coder-next @ http://100.123.226.52:11434/v1 (Tailscale) — USE FOR BULK e2e, $0.
- CHEAP/REAL: Azure (key in config.json provider.azure.options.apiKey, 32ch) gpt-4o-mini + gpt-5.5 (resource altimate-prod-gpt4).
- Vertex via gcloud ADC (project altimate-models): vertex-deepseek DeepSeek-V4-Pro.
- OpenRouter: config uses {env:OPENROUTER_API_KEY} not set non-interactively — SKIP, not needed.
STRATEGY: bulk e2e on FREE Ollama; sample quality runs on Azure gpt-4o-mini (cheap). Reserve $50 for Azure/Vertex; Ollama keeps spend ~$0.
- 23:07:05 e2e-retry Azure gpt-4o-mini, ~$0.01 est (trivial write task)
- 11:37 codex verify runs using azure/gpt-4o-mini (run "hi" repros, ~$0.01-0.05 total est)
- 11:55 my verify: azure/gpt-4o-mini run repro (~$0.01)
