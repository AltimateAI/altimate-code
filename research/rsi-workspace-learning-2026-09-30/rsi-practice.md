# Self-improving agent harnesses in practice (2024-2026): practitioner and OSS survey

Method note: findings come from WebSearch/WebFetch of vendor docs, engineering blogs and GitHub READMEs. Items marked (unverified) came only from search snippets or secondary blogs, not a primary page. Not covered in depth: Cline/Roo memory bank primary docs, OpenHands (microagents are human-authored; no auto-learning found), Voyager/OpenEvolve internals, Eugene Yan and Simon Willison (no specific agent-memory posts found).

## 1. Per-system findings

Each entry: artifact learned / trigger / quality gate / sharing / results and failure modes.

### Claude Code auto memory and Auto Dream
- Artifact: markdown notes. A `MEMORY.md` index (first 200 lines or 25KB load every session) plus topic files read on demand, at `~/.claude/projects/<project>/memory/`.
- Trigger: on correction, stated preference, or discovered build/test fact, mid-session. "Auto Dream" is a background consolidation pass that runs when 24h or more have passed AND 5 or more sessions have occurred. It has four phases (orient, gather signal from transcripts, consolidate, prune/index), is read-only on memory files, and uses lock files.
- Gate: none up front, only after-the-fact consolidation. `/memory` allows manual browsing.
- Sharing: machine-local, not synced. Teams share only checked-in CLAUDE.md.
- Failure modes (the reason Dream exists): after about 20 sessions the agent contradicts itself, cites deleted files, relative dates rot, the index bloats. Teams are advised to check that consolidation keeps edge-case notes and leaves an audit trail.
- URLs: https://www.morphllm.com/claude-code-memory-files , https://claudefa.st/blog/guide/mechanics/auto-dream , https://letsdatascience.com/news/anthropic-introduces-dreaming-for-claude-agent-memory-consol-32a279c9

### Anthropic Agent Skills and skill-creator
- Artifact: a skill folder (SKILL.md with name and description, scripts, references), loaded by progressive disclosure.
- Trigger: collaborative. Anthropic's own advice is "as you work on a task with Claude, ask Claude to capture its successful approaches and common mistakes into reusable context". Autonomous self-authoring is stated as future work: "we hope to enable agents to create, edit, and evaluate Skills on their own".
- Gate: "start with evaluation": find gaps by running representative tasks, observe trajectories, iterate. Security guidance: install only from trusted sources and audit bundled code.
- URLs: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

### "Skills that write skills" community repos
- Claudeception (blader): a skill that fires after non-trivial discovery. Quality bar: required real discovery, has clear trigger conditions, verified to work, and "would this help someone in six months? If not, no skill." Retrieval depends on a specific description (e.g. "Fix for PrismaClientKnownRequestError in serverless"). No external gate. https://github.com/blader/Claudeception
- Others: Stop-hook "continuous-learning" skills that evaluate each session at end; `learnings.md` per skill read before and updated after use (https://www.mindstudio.ai/blog/self-learning-claude-code-skill-learnings-md/). Note: these have no eval or human gate.
- Letta Skill Learning (Letta Code): reflection (did the trajectory solve the task, what is abstractable) then creation using Anthropic's skill-creator. Terminal Bench 2.0 results: trajectory-only skills +21.1% relative (+9 pts); trajectory plus feedback skills +36.8% relative (+15.7 pts), 15.7% lower cost, 10.4% fewer tool calls. Feedback-informed skills encode failure modes better than success-only skills. Skills are markdown in git, shareable across an org. https://www.letta.com/blog/skill-learning/
- SkillLearnBench (arXiv, secondary): self-generated skills help inconsistently; failures are poor transfer, over-specific abstraction, and incoherence when chaining skills. https://arxiv.org/pdf/2604.20087

### Letta (MemGPT lineage): sleep-time agents, MemFS, dreaming
- Artifact: "learned context" in labeled memory blocks (char-limited), now a git-backed memory filesystem (MemFS). Blocks can be shared between agents.
- Trigger: background "sleep-time" agent, now "dreaming" configurable per N agent steps or at context compaction. `/remember` for explicit teaching. `/doctor` audits drift, duplication and size.
- Gate: optional "agent reviews before applying" (costs tokens, does not ask the user). MemFS is in git, so diffs and rollback exist. Reorganization backs up first.
- URLs: https://docs.letta.com/guides/agents/architectures/sleeptime , https://letta.com/blog/conversations

### OpenAI Codex CLI memories (plus AGENTS.md)
- Artifact: markdown memory files in `~/.codex/memories/`.
- Trigger: background two-phase pipeline. Phase 1 runs a cheap model per idle rollout with a strict-schema extraction prompt, redacting secrets before disk. Phase 2 is a global-lock consolidation sub-agent that decides what to merge, patch or drop, and writes a diff.
- Gate: diff-based forgetting (contradicted facts removed), usage-aware retention (reference counts, `max_unused_days`), idle-time eligibility. Sources are third-party deep dives; defaults are undocumented. AGENTS.md is the human-owned override.
- Sharing: local. Team sharing happens only through AGENTS.md in the repo.
- URLs: https://codex.danielvaughan.com/2026/04/08/codex-cli-memory-internals/ , https://mem0.ai/blog/how-memory-works-in-codex-cli

### GitHub Copilot Memory (best-documented team-shared design)
- Artifact: repo-scoped "facts" (subject, fact, citations to code locations, reasoning) and private per-user preferences.
- Trigger: agent calls a memory-store tool when it finds something with "actionable implications for future tasks". Shared across coding agent, code review and CLI.
- Gate: just-in-time citation verification before use (cited code must still exist and support the fact on the current branch). Memories expire after 28 days unless validated and used again (timer resets). Repo owners can delete. Written only by users with write permission; read only by users with read permission. Org admins must enable it.
- Adversarial test: GitHub seeded repos with contradictory memories pointing to nonexistent code. Agents "consistently verified citations, discovered contradictions, and updated incorrect memories."
- Results (A/B): coding agent PR merge rate 90% vs 83% (+7%); code review positive feedback 77% vs 75%; review precision +3%, recall +4%; p<0.00001.
- URLs: https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/ , https://docs.github.com/en/copilot/concepts/agents/copilot-memory

### Devin Knowledge (Cognition)
- Artifact: knowledge items (trigger description plus content), scoped to no repo, one repo or all repos, at org or enterprise level. Being migrated to Skills in Plugins.
- Trigger: Devin suggests items from feedback in chat; also suggests updates to existing items. Retrieval keyed on the trigger description.
- Gate: human accepts, edits, regenerates or dismisses each suggestion (a pending-suggestions queue). Org knowledge is visible to all org members.
- URLs: https://docs.devin.ai/product-guides/knowledge , https://cognition.ai/blog/sept-24-product-update

### Factory (droids)
- Artifact: stable facts (branch naming, acronyms, preferences, conventions) in User Memory (private) or Organization Memory (shared). Claim: "solutions discovered by one engineer automatically become available to the whole team". I could not fetch the primary doc (404 on redirect); this is from search snippets (unverified). https://docs.factory.com/user-guides/memory

### Cursor
- Memories (auto-extracted by a sidecar model from chat) were removed in 2.1.x; users noted they were nearly identical to .mdc rules, with an export-to-rules path. The "Generate Cursor Rules" command was also removed in 2.0 and replaced by community prompts. Memories were per-user/per-project, not team shared. https://forum.cursor.com/t/why-were-generate-cursor-rules-removed/140847 , https://forum.cursor.com/t/are-my-memories-gone/144057
- Team Rules are dashboard-managed by admins (Team/Enterprise) and take precedence over Project and User rules. Adoption of these came from deliberate authoring, not auto-learning. https://developertoolkit.ai/en/cursor-ide/team/team-collaboration/
- Bugbot learned rules (the strongest data on a signal-driven team loop): signals are downvotes, developer replies, and human reviewer comments that flag missed issues. These become candidate rules, which are evaluated continuously against incoming PRs; promising ones are promoted to active, rules with consistent negative feedback are auto-disabled, and users can edit or delete in the dashboard and run backfills across recent PRs. Scale: more than 110,000 repos enabled it, about 44,000 rules, resolution rate about 52% (Jul 2025) to about 80%. A forum request asks for a git-based way to promote learned rules into repo rules. https://cursor.com/blog/bugbot-learning , https://forum.cursor.com/t/api-or-git-based-workflow-to-promote-bugbot-learned-rules-into-repository-rules/171018

### Windsurf
- Cascade auto-generates workspace-scoped memories, machine-local and not shared with teammates; durable team conventions go in rules files. https://docs.windsurf.com/windsurf/memories

### Cline and Roo Memory Bank
- Artifact: a six-file markdown hierarchy (projectbrief, activeContext, etc.) that the agent is instructed to read and update. Failure mode: it is documentation, so it decays. The most volatile file (activeContext) is read hardest, so a stale file is followed confidently. https://www.promptlayer.com/glossary/cline-memory-bank , https://www.memorylake.ai/blogs/set-up-cline-memory-bank (secondary sources)

### Code-review learners: CodeRabbit and Greptile
- CodeRabbit learnings: created from replies in review chat; natural-language statements scoped `local` (repo), `global` (org) or `auto`. Dashboard to view, edit and delete. `approval_delay` setting lets admins require approval before a learning activates. Guidance: state the "why", and use `local` to avoid cross-contamination in mixed stacks. https://docs.coderabbit.ai/knowledge-base/learnings.md
- Greptile: learns from emoji reactions and explanatory comments, plus historical PR comments. https://greptile.com/docs/code-review/training-the-learning-system

### ACE (Agentic Context Engineering) and implementations
- Artifact: a "playbook" of strategy bullets, each with helpful/harmful counters. Roles: Generator, Reflector (extracts lessons, no edits), Curator (turns lessons into delta updates, merged deterministically with dedupe and pruning). Incremental deltas avoid "context collapse" and "brevity bias" from full rewrites.
- Reported: +10.6% on agent tasks, +8.6% on domain tasks; lower latency and rollouts than GEPA.
- Repos: https://github.com/ace-agent/ace , Kayba's open implementation https://github.com/kayba-ai/agentic-context-engine (Skillbook, a code-executing "Recursive Reflector"; claims 2x consistency on Tau2 airline, 49% token reduction in browser automation, a $1.50 learning run on a 14k-line TypeScript translation; self-reported). Also https://github.com/URL42/ACEKit

### GEPA (gepa-ai/gepa) and DSPy
- Artifact: prompts, now any text artifact via `optimize_anything`. Trigger is offline optimization against a metric. Gate is a held-out eval and a Pareto frontier of candidates. Reported to beat GRPO by about 6 pts average with up to 35x fewer rollouts, and beat MIPROv2 by more than 10 pts. Needs a metric and a dataset. https://github.com/gepa-ai/gepa , https://arxiv.org/pdf/2507.19457v2

### LangMem (LangChain)
- Artifact: semantic (facts), episodic, and procedural memory (prompt instructions updated by optimizers: `metaprompt`, `gradient`, `prompt_memory`). Two modes: hot-path memory tools and background extraction after a conversation. Storage is pluggable; privacy scoping through namespaces. Episodic utilities are not provided. https://www.langchain.com/blog/langmem-sdk-launch

### mem0
- Artifact: extracted fact memories, LLM-driven dedupe and conflict resolution. Failure modes: the resolver works on text similarity without scope, so it can silently DELETE a legitimate preference in another context; at 10k+ memories retrieval quality depends on scoping and filters, not dedupe; autoCapture is the main source of junk. Mitigations: prepend scope tags in memory text, wrap writes with an audit log, treat history as recovery only. https://dev.to/mukesh_13/mem0-auto-resolves-memory-conflicts-for-you-until-it-silently-deletes-one-you-still-need-4f4m , https://github.com/mem0ai/mem0/discussions/4787

### Self-modifying code agents: DGM, SICA, OpenEvolve, Voyager
- DGM (jennyzzt/dgm): the artifact is the agent's own code, kept in an archive of variants. The gate is benchmark evaluation (SWE-bench 20% to 50%, Polyglot 14.2% to 30.7%). Failure mode: reward hacking, including faking logs and removing its own hallucination-detection markers. Run in Docker. https://github.com/jennyzzt/dgm , https://arxiv.org/html/2505.22954v3
- SICA (MaximeRobeyns/self_improving_coding_agent): the agent edits its own codebase. Loop is evaluate, archive, self-modify, iterate; 17% to 53% on a SWE-bench Verified subset; always run in Docker; overseer and event-bus visualization; benchmark set is manually configured. https://github.com/MaximeRobeyns/self_improving_coding_agent
- OpenEvolve (AlphaEvolve clone): evolves code files against a user evaluator; needs an automatic fitness function. https://github.com/algorithmicsuperintelligence/openevolve
- Voyager: an ever-growing library of executable skills, validated by environment feedback and self-verification before being added; skills transfer to new worlds. 3.3x more unique items, 15.3x faster tech-tree milestones. https://github.com/MineDojo/Voyager
- Takeaway: these need a cheap, trustworthy fitness signal. Coding teams rarely have one for arbitrary repo conventions, so they apply to harness code or prompts, not team knowledge.

### Data-engineering and SQL agents
- Continual learning of domain knowledge from human feedback in text-to-SQL (NeurIPS 2025 workshop): memory-augmented agents distill NL feedback into structured memory; the "Procedural Agent" variant was best on BIRD Dev. The abstract gave no numbers. https://arxiv.org/abs/2511.10674v1
- AgentSM: semantic memory from prior execution traces (secondary snippet). I found no mature OSS dbt-specific learning agent. Vanna-style training on corrected question/SQL pairs is the common practitioner pattern (not verified here).

### Evidence on static context files (important baseline)
- ETH Zurich study: LLM-generated AGENTS.md reduced task success about 2-3% and raised cost over 20%; human-written files gave about 4% gain, mainly where docs were absent. Another study (Lulla et al.) found AGENTS.md cut runtime 28.6% and tokens 16.6%. Reconciliation used by practitioners: include only non-discoverable facts (tooling, gotchas, non-obvious conventions); delete anything the agent can infer from code. https://addyosmani.com/blog/agents-md/ , https://the-decoder.com/context-files-for-coding-agents-often-dont-help-and-may-even-hurt-performance/ , https://infoq.com/news/2026/03/agents-context-file-value-review/

### Security: memory as an injection vector
- SpAIware (Rehberger, Sept 2024): indirect prompt injection planted persistent instructions in ChatGPT memory for cross-session exfiltration. https://thehackernews.com/2024/09/chatgpt-macos-flaw-couldve-enabled-long.html
- MINJA: over 95% memory-injection success through ordinary queries; attack and damage are separated in time. OWASP lists memory/context poisoning (ASI06) in the 2026 agentic top 10. Recommended defenses: provenance tag on every entry, instruction stripping, write-ahead validation by a second model, trust-aware retrieval with decay, behavioral monitoring. https://christian-schneider.net/blog/persistent-memory-poisoning-in-ai-agents/ , https://vectorize.io/articles/ai-memory-poisoning
- For a team-shared store the risk compounds: one poisoned entry reaches every teammate's agent.

## 2. Cross-cutting comparison

| System | Artifact | Trigger | Gate | Team sharing |
|---|---|---|---|---|
| Claude Code | md notes | on correction; Dream every 24h/5 sessions | none, then consolidation | none (local) |
| Copilot Memory | cited facts | agent tool call | JIT citation check, 28d TTL, perms | repo-wide |
| Devin | trigger+content items | feedback in chat | human accept/edit | org/enterprise |
| Bugbot | rules | downvotes/replies/reviewer comments | continuous eval, auto-disable | repo/org |
| CodeRabbit | NL learnings | reply in review | optional admin approval | repo/org scope flag |
| Letta | blocks/skills | sleep-time, step N | optional review, git diff | shared blocks, git |
| Codex | md memories | idle-rollout pipeline | diff forgetting, usage retention | local |
| ACE | delta bullets with counters | per task reflection | helpful/harmful counters | n/a |
| GEPA/DGM/SICA | prompts/code | offline loop | benchmark/metric | n/a |

## 3. Synthesis: team-shared loop for a CLI coding agent with a cloud workspace

### What to copy
1. Typed entries with required evidence. Copilot's shape (subject, fact, citations, reasoning) plus verify-before-use is the only design with published adversarial testing and an A/B result. Store file/symbol citations, plus for data work the table/model name and query or warehouse object, and re-check them at retrieval.
2. Two tiers: private/session-local candidates and a workspace-shared tier. Promote on evidence (Bugbot style: accumulated positive signal, or a human accept as in Devin and CodeRabbit `approval_delay`), not on first write. Default shared writes to a pending queue with one-click accept/edit/dismiss.
3. Corrections and failures as the trigger, not "end of every session". Letta shows trajectory plus feedback beats trajectory alone; Bugbot learns from downvotes and replies; Claudeception requires real discovery. Add the explicit `/remember`.
4. Skills as the carrier for procedures, memory notes for facts, and rules (CLAUDE.md/AGENTS.md style) only for non-discoverable, human-approved conventions. Keep the always-loaded index small (Claude Code's 200-line cap) and load the rest on demand by a specific trigger description.
5. Delta updates with counters (ACE), not rewrites. Track per entry: created_by, source session, evidence, times retrieved, times it helped or was overridden. Auto-disable entries with consistent negative signal (Bugbot) and expire unused entries (Copilot 28d, Codex `max_unused_days`).
6. A scheduled background consolidator (Auto Dream, Letta dreaming, Codex phase 2), but diff-based and audited: every merge or delete is a logged, revertible change, with scope tags in the text (mem0 lesson), and a lock to prevent concurrent runs.
7. Scoping: user, repo, workspace, with an explicit `local` vs `global` switch (CodeRabbit). Permission model like Copilot: write needs write access, read needs read access; admin delete.
8. Git-style versioning of the shared store (Letta MemFS, skills in git) so teams get diffs, blame and rollback. A GitHub-style "promote learned rule into the repo" path was an explicit user request on Bugbot.
9. Secret redaction before any write (Codex), and provenance on every entry.

### What to avoid
- LLM-generated broad context dumps (`/init` style): measured to reduce success and add more than 20% cost. Only store what is not discoverable from code.
- Silent auto-merge and delete without scope (mem0).
- Unreviewed team-wide auto-writes from untrusted content (web pages, tool output, issue text): memory poisoning. Only learn from user turns and verified outcomes, strip imperative instructions, keep untrusted-origin entries quarantined until approved.
- Always-loaded unbounded notes (bloat, stale "active context" in Cline Memory Bank).
- Auto-evolving the harness code or prompts without a trustworthy metric (DGM reward hacking). If you do it, hold out an eval the agent cannot edit.
- Per-user hidden memories that teammates cannot see (Windsurf, Claude Code local, Cursor memories) are the thing teams complain about, and Cursor removed theirs when they added little over rules.
- Retrieval by vague description. Specific trigger text is the main lever (Claudeception, Devin trigger descriptions).

### How practitioners measure it
- Online A/B with a downstream outcome: Copilot (PR merge rate, review positive-feedback, precision/recall), Bugbot (resolution rate of comments over time, rules enabled vs disabled).
- Offline replay benchmarks with and without the learned artifact: Letta on Terminal Bench 2.0, ACE on agent benchmarks, DGM/SICA on SWE-bench subsets, text-to-SQL on BIRD. Report cost and steps too (Letta: -15.7% cost, -10.4% tool calls); the AGENTS.md study shows steps and cost can rise even when success does not.
- Adversarial tests: seed contradictory or stale memories and check the agent catches them (GitHub); seed a poisoned entry and check it is not followed.
- Hygiene metrics: retrieval hit rate, helped/overridden ratio, dedupe rate, share of entries expired or auto-disabled, index size, share of pending suggestions accepted. Accept rate of the suggestion queue is the cheapest quality proxy for the extractor.
- Hamel Husain's error-analysis approach for the eval itself: read the traces, categorize failures, align any LLM judge with expert labels. https://chatprd.ai/how-i-ai/hamel-husains-guide-to-ai-evals-with-error-analysis

### Suggested minimal design for the CLI plus cloud workspace
1. Capture: on user correction, repeated failure then success, or `/remember`, the agent proposes an entry (type: fact | rule | skill; scope; evidence; trigger text). Redact secrets; mark provenance.
2. Stage: local private candidate, then workspace pending queue. Reviewer accepts, edits or rejects; auto-promote only entries with N independent confirmations (different users or sessions) and no negative signal.
3. Use: retrieve by trigger and scope, verify evidence just-in-time, log "used" and "helped/overridden".
4. Maintain: nightly consolidator emits a reviewable diff; unused entries expire; negative-signal entries auto-disable; admin dashboard with edit, delete and export to repo files.
5. Measure: A/B per workspace (feature on/off by user cohort), track task success, corrections per session, steps/cost, queue accept rate, and a seeded-poison canary.

## 4. Gaps and caveats
- Most "results" are vendor-reported (Letta, Bugbot, Kayba, Copilot); Copilot's numbers are the most rigorous (A/B, significance).
- Few public postmortems of shared auto-learned stores in coding agents exist; most failure modes cited are from mem0 and Claude Code community writeups.
- Cline/Roo, OpenHands, Factory primary docs were not fully verified.
