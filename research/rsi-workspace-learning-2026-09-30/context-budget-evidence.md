# Evidence on the cost of more instructions/rules/memory in agent context

Research date: 2026-10-01. Method: fetched primary abstracts/pages (arXiv, vendor docs) via WebFetch; numbers below are as reported by the fetch tool's summary of each page. Items tagged [UNVERIFIED] came from secondary blogs/search snippets and were not checked against a primary source. [SUMMARY-ONLY] means I got the figure from a summarized abstract/page and did not read the table in the paper.

Caveat that applies to everything: most benchmarks (IFScale, ManyIFEval, CSE) use synthetic, always-applicable, independently checkable constraints (keywords, formatting). Real team rules are conditional ("when touching dbt incremental models, do X"), which AGENTIF shows is harder, but they are also mostly irrelevant to the current turn, which is a different failure (distraction) than simultaneous-satisfaction. No benchmark found measures "N always-on rules, only 1-3 relevant per task" in a data-engineering coding agent. That is the gap; our own eval would be needed.

---

## 1. Instruction-count scaling

**IFScale** (arXiv 2507.11538; https://arxiv.org/abs/2507.11538). 500 keyword-inclusion instructions inside a business-report writing task, density swept 10 to 500, 20 models/7 providers.
- Best frontier model reaches only 68% at 500 instructions (gemini-2.5-pro 68.9%).
- Per-model accuracy at 10 / 100 / 250 / 500: o3-high 100 / 99.6 / 97.8 / 62.8; gemini-2.5-pro 100 / 98.4 / 84.8 / 68.9; gpt-4.1 98 / 95.4 / 74 / 48.9; claude-3.7-sonnet 100 / 94.8 / 72.9 / 52.7; claude-opus-4 100 / 94.6 / 67.9 / 44.6; llama-4-scout 100 / 27.2 / 9.3 / 6.7; gpt-4o 94 / 49 / 22.2 / 15.4.
- Three decay shapes: threshold (o3, gemini-2.5-pro: near-perfect to ~150 instructions, then sharp drop with high variance); linear (gpt-4.1, claude-3.7-sonnet); exponential-to-floor (gpt-4o, llama-4-scout, floor 7-15%).
- Primacy bias peaks at 150-200 instructions (earlier instructions are satisfied more); at 500 it flattens toward uniform failure (ratio 1.0-1.5).
- Failure mode is omission, not distortion: omission:modification ratio at 500 is ~35 (llama-4-scout), ~32 (claude-3.5-haiku), ~6-7 (o3, gemini-2.5-pro). Rules are silently dropped.
- Reasoning models: latency o3 26s at 10 -> 220s at 250 instructions; non-reasoning flat.
- Note: the ~100 instruction level is already a 5% loss for Claude-family models (94.6-94.8%) and 50-70% loss for weak/older models. 10 instructions is ~100% for all but gpt-4o/gpt-4.1 (94-98%).

**ManyIFEval / "When Instructions Multiply"** (EMNLP 2025 Findings; https://arxiv.org/abs/2509.21051). Up to 10 verifiable instructions per prompt (text), up to 6 for code (StyleMBPP), ten LLMs.
- GPT-4o prompt-level (all instructions satisfied) accuracy 0.94 at 1 instruction -> ~0.15-0.21 at 10 (the two figures come from different summaries; paper abstract says ~15%).
- Success decays roughly exponentially with count; logistic regression on count predicts to ~10% error.
- Mitigation measured: iterative self-refinement lifts GPT-4o 15% -> 31%, Claude 3.5 Sonnet 44% -> 58% at 10 instructions. I.e. a verify-and-retry loop helps but does not restore.

**CSE, compositional constraint satisfaction** (arXiv 2608.12426; https://arxiv.org/html/2608.12426) [SUMMARY-ONLY]. 36 verifiable constraint types, 15 models, 369,753 checks.
- Per-constraint pass rate ~72.0% x 0.922^(k-1) (each extra constraint multiplies per-constraint pass rate by 0.922).
- At k=8 constraints: individual constraints pass ~41%, all eight simultaneously 5.7%. At k=12 near-zero.
- "Compositional half-life" k*: best model (GPT-5.5) k*=7, most models 2-4, worst 1. Structural constraints degrade 2.0x faster than lexical.

**AGENTIF** (NeurIPS 2025 D&B; https://arxiv.org/abs/2505.16944). 707 real agent system prompts from 50 agentic apps, avg 1,723 words (max 15,630), avg 11.9 constraints, 8,415 constraints total (46.5% semantic, 38.5% formatting, 15% tool).
- Best model (o1-mini in the paper's snapshot): 59.8% constraint success rate, 26.9% instruction (all-constraints) success rate; every model perfectly follows fewer than 30% of instructions.
- Conditional constraints (apply only if a condition triggers) account for >30% of errors; tool constraints are hardest. This is directly relevant: learned team rules are mostly conditional.
- Numbers are from an older model snapshot; frontier models in 2026 likely score higher [UNVERIFIED: no 2026 re-run checked].

**ComplexBench** (NeurIPS 2024 D&B; https://arxiv.org/abs/2407.03978). 4 constraint types, 19 dimensions, 4 composition types (And, Chain, Selection, Nested). Qualitative finding: significant deficiencies on composition, with nested/selection (conditional) structure hardest. I did not retrieve per-model numbers.

**Coding-agent-specific evidence**
- "Evaluating AGENTS.md" (arXiv 2602.11988; https://arxiv.org/abs/2602.11988): context files do not generally improve task success and raise inference cost by >20% on average; LLM-generated files reduced success ~3%, human-written improved ~4% (secondary summary of the paper, [SUMMARY-ONLY]); instructions ARE followed (more exploration/testing/reasoning), repo overviews unhelpful. Recommends only non-derivable instructions.
- "On the Impact of AGENTS.md on Efficiency" (arXiv 2601.20404; https://arxiv.org/abs/2601.20404): 10 repos, 124 PRs; with AGENTS.md median runtime -28.64%, output tokens -16.58%, comparable completion. Contradicts the above on cost; small sample. Net: a short, non-derivable file can help; an unbounded one does not.
- "Instruction Adherence in Coding Agent Configuration Files" (arXiv 2605.10039; https://arxiv.org/abs/2605.10039): 1,650 Claude Code CLI sessions, mostly Sonnet 4.6 (also Opus 4.6/4.7); file size, instruction position, file architecture, and adjacent-file contradiction had NO detectable effect after multiple-testing correction. Compliance dropped ~5.6% in odds per additional function the agent generated (OR 0.944): compliance decays within a session regardless of file layout. Important counter-evidence: modest file-size variation within their tested range did not matter; what matters is session length and task. Scope: two TypeScript repos, five tasks; their size range may be small [check the paper for the actual line range before relying on it].
- Claude Code docs (https://code.claude.com/docs/en/memory): "target under 200 lines per CLAUDE.md... longer files consume more context and reduce adherence"; instructions are "context, not enforced configuration"; delivered as a user message after the system prompt; must-happen behavior should be a hook/permission rule; MEMORY.md auto-loads only first 200 lines / 25KB; path-scoped rules via `paths:` globs load only when matching files are read; imports do NOT reduce context cost. These are vendor guidance, not an experiment.
- HumanLayer "Writing a good CLAUDE.md" (https://www.humanlayer.dev/blog/writing-a-good-claude-md): claims frontier models follow ~150-200 instructions "reasonably consistently" and Claude Code's system prompt uses ~50. This is an extrapolation from IFScale (which was keyword-inclusion on a different task) and the author concedes it is not rigorous. [UNVERIFIED as a rule of thumb for coding agents.]

**Reading across**: adherence loss is multiplicative per added simultaneous rule for hard/structural rules (~8% relative loss per rule in CSE) but near-flat for easy lexical rules up to ~100 on strong models (IFScale). Strong 2025 reasoning models hold to ~150 easy rules, then fall off a cliff with high variance (hard to detect in testing). Omission is silent.

---

## 2. Context rot / long-context degradation

- **Chroma "Context Rot"** (https://www.trychroma.com/research/context-rot): 18 LLMs incl. Claude Opus 4/Sonnet 4, GPT-4.1/4o, Gemini 2.5, Qwen3. Performance varies with input length even on simple tasks; lower needle-question semantic similarity => steeper degradation; even a single distractor lowers accuracy and distractors affect models non-uniformly; shuffled haystacks beat coherent ones (structure itself hurts); LongMemEval: Claude Opus 4 ~85% on focused prompt vs ~45% on full 113k-token context with irrelevant content (as summarized by the fetch; verify figure in the report). Claude models abstained most, GPT hallucinated most.
- **Context length alone hurts** (arXiv 2510.05381, EMNLP Findings 2025; https://arxiv.org/abs/2510.05381): even with perfect retrieval of the evidence, and even when irrelevant tokens are replaced with whitespace, performance drops 13.9% to 85% across 5 LLMs on math/QA/code. Mitigation: have the model recite retrieved evidence first (converts to short-context task), up to +4% on GPT-4o RULER. Implication: the cost is not only "distraction by irrelevant rules"; raw length costs accuracy.
- **NoLiMa** (ICML 2025; https://arxiv.org/abs/2502.05167): 13 models claiming >=128K; at 32K, 11 of 13 fall below 50% of their short-context baseline when lexical overlap is removed; GPT-4o 99.3% -> 69.7% at 32K. Implication: a rule whose wording does not lexically match the task is the one that gets missed in a long context, which is exactly what "learned rules" phrased abstractly look like.
- **RULER** (https://arxiv.org/abs/2404.06654): 17 models; all claim >=32K, only about half keep satisfactory performance at 32K.
- **Lost in the Middle** (TACL 2024; https://arxiv.org/abs/2307.03172): U-shaped accuracy; best at start/end, worst in the middle, also for long-context-trained models. (Dated models; newer models flatter but IFScale primacy shows position effects persist for instructions.)
- **Fiction.LiveBench** (via secondary summary, https://danjcleary.substack.com/p/do-long-context-windows-actually) [UNVERIFIED, leaderboard values change]: e.g. Claude Sonnet 4 (Thinking) 97.2 at 8k -> 91.7 at 32k -> 81.3 at 120k; GPT-5 100 -> 97.2 -> 96.9 -> 87.5 at 192k; DeepSeek v3.1 80.6 -> 63.9 -> 62.5. Most models start degrading 16k-64k on deep comprehension.
- **LLMs Get Lost in Multi-Turn** (https://arxiv.org/abs/2505.06120): average 39% drop vs single-turn over six tasks, >200k simulated conversations; mostly unreliability, and early wrong assumptions are not recovered from.
- Breunig's Gemini 2.5 Pokemon anecdote: beyond ~100k tokens the agent repeats history rather than planning; Llama 3.1 405B declined at ~32k (https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html; anecdotal, citing Google's report).

Relevance: a rule block of a few thousand tokens is well under the 16k-32k threshold where these effects appear on strong models. The risk from rules is mainly instruction-density and conflict (section 1), not raw rot, UNLESS the rules are on top of an already long agent trajectory (the 5.6%-per-function compliance decay in 2605.10039 is the relevant effect).

---

## 3. Context-engineering practice (vendor/engineering sources)

- **Anthropic, Effective context engineering** (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): context is a finite "attention budget"; goal is "the smallest set of high-signal tokens"; system prompt at the right "altitude" (not brittle if-else, not vague); just-in-time retrieval via lightweight identifiers (paths/queries) rather than preloading; compaction, structured note-taking, sub-agents returning ~1-2k token summaries; "if a human engineer can't definitively say which tool should be used, an agent can't either." No quantified rule-count threshold given.
- **Anthropic, Writing tools for agents** (https://www.anthropic.com/engineering/writing-tools-for-agents): consolidate tools, namespace, return high-signal output (25k token default cap), `response_format` concise vs detailed (~65% token cut in their example); eval-driven iteration; small description changes can give large gains.
- **Anthropic, Advanced tool use** (https://www.anthropic.com/engineering/advanced-tool-use): 58 tools/5 servers ~55k tokens up front; Tool Search Tool: ~85% token reduction; MCP-eval accuracy Opus 4 49% -> 74%, Opus 4.5 79.5% -> 88.1%. Best vendor-measured evidence that on-demand discovery beats always-on listing.
- **Anthropic, Agent Skills** (https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills): three-level progressive disclosure (name+description always loaded; full SKILL.md on relevance; bundled files on demand); recommends scripts for deterministic work rather than token generation.
- **Manus** (https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): KV-cache hit rate is the top production metric; avg input:output ~100:1; cached vs uncached $0.30 vs $3.00 per MTok (Claude Sonnet, 10x); keep prefix stable, no timestamps, append-only, deterministic serialization; mask tools via logit constraints rather than adding/removing them mid-run; file system as unbounded restorable memory; keep errors in context; recite goals (todo.md) to fight lost-in-the-middle. ~50 tool calls/task average.
- **Cognition, Don't build multi-agents** (https://cognition.com/blog/dont-build-multi-agents): share full traces; actions carry implicit decisions, conflicting decisions yield bad results; default to single-threaded linear agent; compression by a dedicated summarizer is "hard to get right". Relevance: rules applied by a sub-agent that does not see the main trace are a source of conflict; keep the rule layer in one place.
- **LangChain write/select/compress/isolate** (https://www.langchain.com/blog/context-engineering-for-agents): memory (procedural/semantic/episodic), rules files as procedural memory in Cursor/Windsurf; "select" via embeddings/knowledge graph; cites tool-selection accuracy "3-fold" improvement via semantic tool retrieval (that is RAG-MCP's number); warns of memory over-injection (ChatGPT injecting location from memory into an unrelated image request); Claude Code auto-compacts at 95%.
- **Breunig, How contexts fail** (https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html): poisoning, distraction, confusion, clash. Confusion example: quantized Llama 3.1 8B failed with 46 GeoEngine tools, succeeded with 19; BFCL shows all models do worse with more tools. Clash example: Microsoft/Salesforce sharded multi-turn prompts -39% average; o3 98.1 -> 64.1.
  - Mapping to learned rules: **poisoning** = a wrong rule learned once and reapplied forever; **clash** = two learned rules contradicting (Claude docs: "may pick one arbitrarily"); **confusion** = irrelevant rules influencing output; **distraction** = rules crowding out task reasoning.

---

## 4. Prompt-caching economics (vendor docs fetched 2026-10-01; prices are multipliers on base input price; re-verify before building cost models)

| Provider | Cache-hit price | Write price | Min cacheable prefix | TTL | Notes |
|---|---|---|---|---|---|
| Anthropic (https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | 0.1x base (0.05x Opus 5.5; 0.025x Fable 5.1/Mythos 5.1) | 1.25x (5-min), 2x (1-hour) | 512 tokens for newest models (Sonnet 5.5, Opus 5/5.5, Fable 5/5.1); 1,024 for Sonnet 5/4.x, Opus 4.8/4.1; 2,048 Opus 4.7, Haiku 3.5; 4,096 Opus 4.5/4.6, Haiku 4.5 | 5 min default, 1 h optional | Order tools -> system -> messages; a change at a level invalidates it and everything after. 20-block lookback; writes only at breakpoints. Changing tool defs, tool_choice, images, thinking settings, effort can invalidate. |
| OpenAI (https://developers.openai.com/api/docs/guides/prompt-caching) | 0.1x on most GPT-5.6+ (0.05x on one model); "up to 95%" discount | none stated | 1,024 tokens (GPT-5.6+) | >=30 min on GPT-5.6+; 5-10 min in-memory or up to 24 h on earlier | Longest-prefix match; "put stable developer instructions and shared reference material first; dynamic content at the end". |
| Gemini (https://ai.google.dev/gemini-api/docs/caching) | implicit savings passed through (rate not retrieved) | explicit-cache storage cost not retrieved | 2,048 (2.5 Flash/Pro); 4,096 (3.x Flash, 3.1 Pro preview) | not retrieved | "Put large and common content at the beginning; send similar-prefix requests close in time." |

How per-turn dynamic injection breaks caching: any text inserted before the end of the stable prefix (timestamps, per-turn retrieved rules placed in system prompt, reordering tools, editing earlier messages) changes the prefix hash, so everything after the edit point is written to the cache again at 1.25x/2x of the base input price (the write price replaces the normal input price; it is not added to it). Manus: 10x cost gap and ~100:1 input:output means prefix stability dominates cost. Recommended ordering (consistent across all three vendors): static tools, then static system/always-on rules, then slowly-changing project memory, then conversation; inject conditional/retrieved rules as append-only messages (or tool results) at the tail, never rewriting earlier content; keep tool set fixed and mask rather than add/remove.

Arithmetic (derived by me, not from a source): a 3,000-token always-on rule block with a 0.1x hit rate costs ~300 token-equivalents per turn after the first; the same block re-injected per turn at the front would be re-written each turn at 1.25x, about 3,750 token-equivalents, and so would every token after it. Cost of cached rules is small; the real cost is attention/adherence, not dollars. Caching makes always-on cheap but does not fix section 1.

---

## 5. Rule-to-check conversion

Evidence is mostly practice/vendor guidance, little controlled measurement.

- **Claude Code docs**: instructions are context, not configuration; use PreToolUse hooks/permission deny rules for must-hold behavior ("Settings rules are enforced by the client regardless of what Claude decides"). https://code.claude.com/docs/en/memory
- **Factory, Using linters to direct agents** (https://factory.com/news/using-linters-to-direct-agents): argues guidance is ambiguous, gives no guarantee, cannot verify cross-file structure; lint gives on-path enforcement and error messages the agent self-corrects against. Page contains no quantitative comparison (verified).
- Secondary claims "CLAUDE.md ~70-80% compliance vs hooks 100%" and "followed 0/524 without file, 67.7% with file" came from blog snippets (e.g. https://dev.to/minatoplanb/i-wrote-200-lines-of-rules-for-claude-code-it-ignored-them-all-4639, https://dotzlaw.com/insights/claude-hooks/) [UNVERIFIED, anecdotal]. The 100% for hooks is true by construction for what the hook can detect.
- **LLM-generated detection rules**: RuleLLM (arXiv 2504.17198; https://arxiv.org/html/2504.17198) generated 763 YARA/Semgrep rules; precision 85.2%, recall 91.8%; ablation: raw LLM 62.9% precision / 56.8% recall, adding compiler-feedback alignment 79.2/84.3, full pipeline 85.2/91.8. Lesson: LLM-drafted rules need a validation loop (compile/test against positive and negative examples) to be usable. Domain is malware, not style rules.
- "Executable Governance" (arXiv 2512.04408; https://arxiv.org/pdf/2512.04408): pipeline from policy text to atomic JSON rules with generated examples; I could not extract quantitative results [SUMMARY-ONLY, no numbers verified]. Also SemOpt (arXiv 2510.16384) and RulePilot (arXiv 2511.12224) generate Semgrep/SIEM rules with LLMs; not read in detail.
- Practitioner posts (Kinde, OpenTeams, Steve Kinney) describe the loop "same review comment three times -> LLM drafts ESLint/Semgrep rule -> run repo-wide -> fix". No measured results found. [UNVERIFIED]
- ManyIFEval's self-refinement result (15% -> 31%) is the closest controlled evidence that verify-then-repair, i.e. an external check feeding back errors, helps; but it still left 69% failing at 10 instructions with an LLM checker, whereas deterministic verifiers do not degrade with rule count.
- dbt/SQLFluff custom rules: I found no study on LLM-generated SQLFluff plugins or dbt tests as agent guardrails. [NOT FOUND]. Reasonable inference only: SQL/dbt conventions (naming, model layering, required tests/docs, `ref()` usage) map well to SQLFluff rules, dbt `dbt-checkpoint`/`dbt-project-evaluator`, and schema tests.

Rule-convertibility heuristic (my synthesis, not from a source): convert when the rule is (a) decidable from the diff/AST/manifest/SQL text, (b) has an unambiguous pass/fail, (c) violation cost is high or recurrence is high. Keep as prompt text when it needs judgment (naming for business concepts, "prefer simple models"), is about the user's intent, or is a style preference with no checker. Conditional rules (AGENTIF's hardest category) are exactly the ones a deterministic trigger+check handles best: the condition is evaluated in code, not by the model.

---

## 6. Retrieval precision for rules/tools

- **RAG-MCP** (arXiv 2505.03275; https://arxiv.org/abs/2505.03275): semantic retrieval of MCP tools before the LLM; tool-selection accuracy 43.13% vs 13.62% baseline (>3x), prompt tokens cut >50%. Baseline degrades as pool grows (to under 14%).
- **Less-is-More** (arXiv 2411.15399, DATE 2025): dynamically reducing tools cuts execution time up to 70% and power up to 40% with higher success on edge LLMs; fine-tuning-free.
- **Enterprise agent routing** (arXiv 2606.17519; https://arxiv.org/abs/2606.17519): 110 agents / 584 tools; routing F1 on under-specified requests drops 16-23 pp from 10 to 110 agents; two gaps: retrieval gap and a "confusion gap" (~10 pp lost even with perfect retrieval); embedding shortlisting recovers 10-11 pp; on 1,435 real utterances +10-17 pp but still 10-15 pp below benchmark. Message: retrieval helps but does not eliminate loss, and real utterances are worse than synthetic.
- **Tool-count thresholds**: Anthropic Tool Search numbers above (49% -> 74% Opus 4); BFCL/Llama example (46 vs 19 tools) via Breunig. Blog claims of "degrades past 30-50 tools", "Nebula 4 tools ~95% vs 46 tools ~71%", "HumanMCP 10 -> 100 tools ~10% drop", "ScaleMCP 7-85% drops at 49-741 tools" came from search snippets of secondary sources [UNVERIFIED]. They are consistent in direction.
- **Procedural memory retrieval** (arXiv 2511.21730; https://arxiv.org/abs/2511.21730; ALFWorld): embedding retrieval strong on familiar vocabulary but degrades considerably on novel contexts; LLM-generated procedural abstractions transfer better; enriching representation helps much less than corpus scale. Implication: learned rules should be stored with an LLM-written abstract/trigger description, not raw correction text, and matched on that.
- NoLiMa (section 2) is the mirror warning: low-lexical-overlap matches are where models fail, so trigger design should include explicit keywords/globs.
- Claude Code itself uses glob (`paths:`) activation for rules and description-based model routing for skills (docs above). Note: path rules fire "when Claude reads files matching", not on every tool use, so a rule relevant to a file only written (not read) may not load. No published precision comparison of glob vs embedding vs LLM routing for instructions was found. [NOT FOUND]
- Procedural/agent memory benchmarks (MemoryAgentBench arXiv 2507.05257; RECON arXiv 2607.16716; SWE Context Bench arXiv 2602.08316) exist; RECON snippet: best non-oracle 22.4% accuracy on compositional memory tracing and retrieval being 8-20x more token-efficient than full long context (64-70K vs 3-9K tokens/question) [search-snippet only, UNVERIFIED].

---

## Key quantitative results table

| Source | Setup | Finding | Number |
|---|---|---|---|
| IFScale 2507.11538 | 10-500 keyword instructions, 20 models | Best model at 500 | 68% (gemini-2.5-pro 68.9%) |
| IFScale | claude-opus-4 / sonnet-3.7 at 100 / 250 / 500 | linear decay | 94.6/67.9/44.6 ; 94.8/72.9/52.7 |
| IFScale | o3-high, gemini-2.5-pro | threshold decay after ~150 | o3 97.8% @250, 62.8% @500 |
| IFScale | omission:modification at 500 | silent drops dominate | 6-35 : 1 |
| IFScale | primacy bias peak | earlier rules favored | peaks at 150-200 instr. |
| ManyIFEval 2509.21051 | GPT-4o, 1 vs 10 instr. | all-satisfied rate | 0.94 -> ~0.15-0.21 |
| ManyIFEval | self-refinement at 10 instr. | partial recovery | GPT-4o 15->31%; Claude 3.5 S 44->58% |
| CSE 2608.12426 | 15 models, k constraints | per-constraint multiplier / all-k pass | x0.922 per extra; 5.7% all-pass at k=8 [SUMMARY-ONLY] |
| AGENTIF 2505.16944 | 707 real agent prompts, 11.9 constraints | best model ISR / CSR | 26.9% / 59.8% |
| AGENTIF | error analysis | conditional constraints share of errors | >30% |
| Evaluating AGENTS.md 2602.11988 | SWE-bench-style tasks | cost increase from context files | >20% avg; success ~-3% (LLM-gen) / +4% (human) |
| AGENTS.md efficiency 2601.20404 | 124 PRs, 10 repos | runtime / output tokens | -28.6% / -16.6% |
| Config adherence 2605.10039 | 1,650 Claude Code sessions | file size/position/structure effect | none detectable; OR 0.944 per generated function |
| Chroma Context Rot | 18 LLMs; LongMemEval | Opus 4 focused vs full 113k | ~85% vs ~45% |
| Context length alone 2510.05381 | 5 LLMs, perfect retrieval | degradation from length only | 13.9%-85% |
| NoLiMa 2502.05167 | 13 models | below 50% of baseline at 32K | 11 of 13; GPT-4o 99.3 -> 69.7 |
| RULER 2404.06654 | 17 models | keep performance at 32K | ~half |
| Multi-turn 2505.06120 | 200k+ conversations | avg drop vs single-turn | 39% |
| Anthropic advanced tool use | 58 tools, ~55k tokens | Tool Search accuracy, tokens | Opus 4 49->74%; Opus 4.5 79.5->88.1%; -85% tokens |
| RAG-MCP 2505.03275 | MCP tool pool | retrieval vs all-in-prompt | 43.13% vs 13.62%; >50% fewer tokens |
| Enterprise routing 2606.17519 | 110 agents/584 tools | F1 loss 10->110; embedding shortlist recovery | -16 to -23 pp; +10-11 pp |
| Breunig/BFCL | Llama 3.1 8B, GeoEngine | 46 tools fail, 19 tools succeed | 46 vs 19 |
| Manus | production agent | cached vs uncached input; ratio | $0.30 vs $3 /MTok (10x); ~100:1 |
| Anthropic prompt caching docs | all current models | hit / 5m write / 1h write | 0.1x (0.05x/0.025x some) / 1.25x / 2x |
| RuleLLM 2504.17198 | LLM-generated YARA/Semgrep | raw LLM vs full pipeline | 62.9/56.8 -> 85.2/91.8 (P/R %) |
| Claude Code docs | CLAUDE.md | recommended size; MEMORY.md load cap | <200 lines; 200 lines/25KB |

---

## Implications for a bounded rule budget

What the evidence supports firmly:
1. Always-on instruction count has a real, model-dependent cost. Easy lexical rules are near-lossless to ~100 on current Claude-class models (IFScale ~94-95% at 100) but weaker/older/smaller models collapse by 100 (gpt-4o 49%, llama-4-scout 27%). Hard, structural, or conditional rules decay multiplicatively and much sooner (CSE k* of 2-4 for most models; AGENTIF all-constraints success under 30% at ~12 constraints).
2. Failure is silent omission, with primacy bias, and the cliff has high variance for the best models. You cannot detect saturation from average behavior; needs an eval that measures per-rule adherence.
3. Vendor guidance converges: keep always-on files short (Anthropic: <200 lines), scope rules by path, load procedures on demand, use hooks/permissions for must-hold behavior.
4. Dollar cost of always-on text is small with caching (0.1x hits) if the prefix is stable; dynamic injection at the front destroys that. So the budget is driven by adherence/attention, not by price.
5. Retrieval/on-demand loading reliably beats listing everything when the pool is large (tools: 49->74%, 13.6->43%), but retrieval is imperfect, loses 10 pp+ on real utterances, and embedding retrieval is weak on novel vocabulary.

Concrete recommendations (the numbers are my synthesis from the evidence above, flagged as heuristics to validate with your own eval; the evidence does not give a single threshold for coding agents):
- **Always-on tier: cap at about 20-30 rules / ~1,000-1,500 tokens, hard ceiling ~50 rules.** Rationale: Claude-family models are ~95% per-rule at 100 easy rules, but real team rules are conditional/structural (AGENTIF, CSE), the harness already consumes ~50 instruction-equivalents (HumanLayer, UNVERIFIED), and a CLAUDE.md-style budget of <200 lines is vendor guidance. Admit a rule to this tier only if it applies to most tasks (global invariants: never touch prod schemas, always run `dbt build --select state:modified+`, project vocabulary). Do not rely on an a priori "150-200" figure.
- **Conditional tier: retrieve on trigger, inject 0-5 rules per turn (~500 tokens max) as append-only tail content, never into the cached prefix.** Use deterministic triggers first (file glob, dbt resource type, SQL dialect/warehouse, tool being called) because they are predictable, free, and cache-safe; fall back to embedding match over an LLM-written one-line "applies when..." description (procedural-memory retrieval evidence: abstractions transfer better than raw text) only for rules without a structural trigger. Keep the top-k small; the routing paper shows a residual ~10 pp confusion loss even with perfect retrieval, and NoLiMa shows low-overlap matches fail in long contexts, so put the trigger keywords in the injected text. Retrieval at k=3-5 is a heuristic; the evidence gives no optimum. LLM-routing of rules is not supported by any measurement I found; skip it until you can evaluate it.
- **Deterministic tier: convert any rule that can be decided from the diff/AST/manifest into a check (SQLFluff/custom lint, dbt-project-evaluator/dbt-checkpoint/tests, Semgrep/ast-grep, PreToolUse hook), and feed the failure message back to the agent.** These consume 0 context permanently, do not decay with rule count or session length (the within-session compliance decay of ~5.6% odds per function applies to prompt rules, not to checks), and make the conditional-rule problem (30% of AGENTIF errors) disappear. Generate the check with an LLM but validate it against positive/negative examples (RuleLLM: validation loop moved precision 62.9 -> 85.2). Self-refinement with an LLM judge alone only reached 31-58% at 10 instructions, so prefer code checkers as the judge.
- **Leave the prompt text only for the judgment residue.** After conversion, ask: has this rule actually been violated in recorded sessions? If never, demote/expire it (the AGENTS.md study suggests unneeded content costs >20% tokens with no success gain; only non-derivable instructions help; also skip anything the agent can derive from the repo).
- **Governance of learned rules** (poisoning/clash from Breunig and Claude docs): require each learned rule to carry a trigger, an owner/source, a created date, and a conflict check against existing rules at write time; auto-learned rules are a risk (LLM-generated context files reduced success ~3%, human-written improved ~4%). Gate promotion from "learned" to always-on on repeated evidence.
- **Cache hygiene**: static tools -> static system + always-on rules -> slowly-changing project memory -> conversation -> retrieved conditional rules appended at the tail. Do not add/remove tools mid-session; do not rewrite earlier messages; treat any change to the always-on block as a cache-invalidating deploy event (batch edits). Check the minimum cacheable length: the always-on block alone is below Anthropic's 1,024/2,048/4,096-token minimum on many models, so cache the combined tools+system prefix, not the rules alone.
- **Position**: put the highest-priority always-on rules first (IFScale primacy) and consider restating the two or three critical invariants near the tail/at a task-start recap (lost-in-the-middle, Manus recitation) [recitation benefit is Manus practice, not a controlled result].

Where the evidence does NOT support a number:
- No source gives a validated always-on rule limit for coding agents; 20-30/50 above is a conservative extrapolation, and a 150-200 figure is not established for conditional rules.
- No controlled comparison of glob-trigger vs embedding vs LLM routing for instruction selection was found.
- No published measurement of lint/hook enforcement vs prompt rule compliance in coding agents with numbers (only anecdotes); no dbt/SQLFluff-specific study.
- IFScale and ManyIFEval use older models (up to Claude Opus 4 / 3.7 Sonnet, GPT-4o); 2026 models (Claude 5.x, GPT-5.x) are likely better, but CSE (2608.12426) suggests multi-constraint composition is still hard (k* up to 7 for the best model).
- Recommend running a local eval: N in {10, 25, 50, 100} always-on rules x your real tasks, measuring per-rule adherence and task success on the actual model, plus an irrelevant-rule distractor condition; that would replace the heuristics above with measured thresholds.
