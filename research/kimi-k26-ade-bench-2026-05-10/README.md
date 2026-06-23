# Kimi-K2.6 on ADE-Bench — 2026-05-10

Behavioral analysis of the Moonshot Kimi-K2.6 model running inside altimate-code's agent loop against the ADE-Bench analytics/data-engineering benchmark.

- **Headline:** 61 / 75 = 81.3% pass rate (canonical re-tally across all per-trial directories: 59 / 78 = 75.6%)
- **Total cost:** $14.91 across ~9.6 hours of wall clock
- **Source:** [`findings.md`](./findings.md)

Read [`findings.md`](./findings.md) for the full writeup — tool usage distribution, wall-clock anatomy (~89% of time is the model thinking), prompt-cache amplification (85.8% cache hit), per-failure-class taxonomy, and what would be needed to recover the remaining 14–19 failures.

Trace data referenced throughout lives under `experiments/ade-bench-upstream/experiments/2026-05-10__*__none/`. The post is blog-ready; cite or extract sections as needed.
