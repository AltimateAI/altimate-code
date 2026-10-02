# How coding-agent harnesses bound persistent knowledge without bloating context

Date: 2026-10-01. Scope: Claude Code, Cursor, Windsurf, Copilot, Codex CLI, Devin, Cline, Aider, Amp, Augment, Continue, Kiro, plus evidence on pull-based reliability.
Convention: [P] = verified from primary vendor docs fetched this session. [S] = secondary (blog/forum/search snippet). [U] = unverified.

## 1. Comparison table

| Product | Storage unit | Loading modes | Push vs pull | Size limits | Eviction / consolidation | Sharing / review |
|---|---|---|---|---|---|---|
| Claude Code: CLAUDE.md / rules | Markdown files; hierarchy managed > user > project > local; `.claude/rules/*.md` | Launch: all ancestor CLAUDE.md + unscoped rules + `@imports` (max 4 hops). Subdir CLAUDE.md and `paths:`-scoped rules load when Claude Read()s a matching file | Harness-pushed (the on-read triggers are harness-fired too, not model-chosen) | Target <200 lines/file; hard skip >4 MiB; startup warning when files exceed length or combined limit; imports do NOT reduce cost | None automatic; `/doctor prompt-audit` finds stale/conflicting; `/doctor` proposes trims; HTML comments stripped before injection | Project files in git; managed policy file via MDM; `claudeMdExcludes`; rules dir symlinkable [P: code.claude.com/docs/en/memory] |
| Claude Code: auto memory | `~/.claude/projects/<repo>/memory/`: `MEMORY.md` index + topic files with frontmatter `type` (user/feedback/project/reference), `modified` timestamp | `MEMORY.md` first 200 lines or 25KB pushed at session start; topic files read on demand by model | Hybrid: index pushed, bodies pulled | 200 lines / 25KB on index. Near limit: harness injects reminder to shorten. Over limit: write succeeds but returns error telling model to rewrite index | Model-driven rewrite forced by harness reminders; "Auto Dream" background consolidation [S] | Machine-local, not shared across machines; shared across worktrees [P] |
| Claude Code: Skills | `SKILL.md` + bundled files | Name+description listing always in context; body loads on invoke (model or `/name`); `paths:` frontmatter; `disable-model-invocation` | Listing pushed, body pulled by model | Listing budget default 1% of context window (`skillListingBudgetFraction`); per-skill description+when_to_use cap 1,536 chars; least-used descriptions dropped on overflow; after compaction re-attach first 5,000 tokens per invoked skill, 25,000 shared | `/skill-doctor` reports cost and never-invoked skills (v2.1.252+) | Plugins / project `.claude/skills` [P: code.claude.com/docs/en/skills] |
| Anthropic memory tool (API) | Client-side `/memories` directory; commands view/create/str_replace/insert/delete/rename | API auto-adds system prompt "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE" | Pull, but forced by protocol prompt | None built in; docs advise cap file size, cap `view` output (tool truncates text view >16,000 chars), page with `view_range` | App-owned: "periodically delete files not accessed in a long time"; pair with context editing/compaction | App-defined storage [P: platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool] |
| Anthropic context editing | Server-side edit of message history | `clear_tool_uses_20250919` trigger default 100,000 input tokens, keep 3 tool uses, `exclude_tools`, `clear_at_least`; `clear_thinking_20251015` | Harness-pushed | n/a | Clears old tool results; clearing invalidates prompt cache | Beta header `context-management-2025-06-27` [P: platform.claude.com/docs/en/build-with-claude/context-editing] |
| Cursor rules | `.cursor/rules/*.mdc` (frontmatter `description`, `globs`, `alwaysApply`); AGENTS.md (nested) | Always Apply; Apply Intelligently (description only shown, agent pulls); Apply to Specific Files (globs); Apply Manually (@mention) | Always/globs: push. Intelligently/manual: pull | Guidance "<500 lines" per rule; split into composable files | None automatic | Team Rules via dashboard (Team/Enterprise), highest precedence [P: cursor.com/docs/context/rules] |
| Cursor Memories | Project-scoped facts proposed by background model | Injected as context | Push | [U] | User approval required before save (1.2 changelog); feature reportedly removed in 2.1.x [S: forum.cursor.com threads; P for the 1.2 approval line: cursor.com/changelog/1-2] | Per-project, user-approved |
| Windsurf / Devin Desktop Cascade | Rules: `.windsurf/rules/*.md` (or `.devin/rules/`), global_rules.md; Memories auto-generated, `~/.codeium/windsurf/memories/`, workspace-scoped | Rule modes: `always_on` (full content every message), `model_decision` (description always shown, body fetched on demand), `glob`, `manual` | always_on/glob push; model_decision/manual pull | Global rules 6,000 chars; workspace rule 12,000 chars per file; memories do not consume credits | None documented [U] | Enterprise system rules in `/etc/devin/rules/` read-only to users [P: docs.devin.ai/desktop/cascade/memories] |
| GitHub Copilot instructions | `.github/copilot-instructions.md`; `.github/instructions/*.instructions.md` with `applyTo` glob (+`excludeAgent`); AGENTS.md/CLAUDE.md/GEMINI.md; personal and org instructions | Repo-wide always; path-specific when matching files; all applicable sets sent together | Push | "no longer than 2 pages" (guidance for generated repo-wide instructions); code review reads only first ~4,000 chars [U: not confirmed in fetched pages] | None | Org-level instructions; priority personal > repo > org [P: docs.github.com custom instructions pages] |
| GitHub Copilot Memory | Repo-level facts with code citations; user preferences with user quotes | Retrieved at session creation for the billing org; facts validated against current branch before use ("Only validated facts are used") | Harness-pushed retrieval, validation gate | n/a | Unused entries auto-deleted after 28 days; timer resets when validated and applied | Repo owners can review/delete; enterprise admins export/delete; created only from activity by users with write access [P: docs.github.com/en/copilot/concepts/agents/copilot-memory] |
| OpenAI Codex CLI: AGENTS.md | `AGENTS.md`/`AGENTS.override.md`, global in `~/.codex` plus Git-root-to-cwd walk | Concatenated root-down, closer overrides; first non-empty file per directory | Push | `project_doc_max_bytes` 32 KiB combined; discovery stops at limit | None | Git [P: learn.chatgpt.com/docs/agent-configuration/agents-md] |
| Codex memories | `~/.codex/memories/`: `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, `rollout_summaries/`, `skills/` | Disabled by default (`[features] memories = true`); `use_memories` injects into future sessions | Push of summary; details on disk | Per-rollout summary max 125 chars [S]; summary injection token cap not disclosed [U] | Phase 1: per-rollout extraction after idle. Phase 2: one serialized consolidation sub-agent (no network) ranks by usage count then recency, diffs add/retain/remove; drops entries unused beyond `max_unused_days` | Local generated state, secrets redacted [P: learn.chatgpt.com/docs/customization/memories; S: codex.danielvaughan.com deep dive] |
| Devin Knowledge | Item = trigger description + short content (+ optional `!macro`) in folders; org/enterprise scope | Pin to no repo (retrieved only when contextually relevant), a repo (always applied in that repo), or all repos (always) | Retrieved by trigger (harness/model hybrid, mechanism undocumented); pins push | Guidance: "targeted, granular items", content a handful of sentences | Auto-suggested from chat feedback, user edits/dismisses before save; being migrated into Skills in Plugins | Org to enterprise promotion [P: docs.devin.ai/product-guides/knowledge] |
| Cline | `.clinerules/` or `.cline/rules/`; Memory Bank = 6 core md files | Rules always, or conditional on `paths:` globs matched against open/edited/mentioned files; Memory Bank requires model to read ALL files at the start of EVERY task | Rules push; Memory Bank pull-by-instruction | No limits; "Rules consume context tokens" | Per-rule toggles; "update memory bank" manual | Rules in repo [P: docs.cline.bot] |
| Aider | `CONVENTIONS.md` via `--read` or `.aider.conf.yml` `read:` | Always loaded, read-only, prompt-cached | Push | None stated | None | Git [P: aider.chat/docs/usage/conventions.html] |
| Augment | Rules (Always / Manual / Auto-by-description), User guidelines, AGENTS.md walk-up, agent memories [S] | Always attached; Auto = agent picks by description | Always push; Auto/manual pull | User guidelines 24,576 chars; workspace guidelines + rules combined 49,512 chars; overflow dropped by priority (manual first, then always/auto) | Memory entries carry source field (agent-proposed vs developer-correction) [S] | Workspace rules in repo [P: docs.augmentcode.com/setup-augment/guidelines] |
| Continue | `.continue/rules` md with `globs`, `regex`, `description`, `alwaysApply` | alwaysApply true/false; false = glob match, or agent picks by description; default = applies if no globs or globs match | Mixed | None stated | None | Repo files [P: docs.continue.dev] |
| Kiro steering | `.kiro/steering/*.md` (product.md, tech.md, structure.md foundation), global `~/.kiro/steering/`, AGENTS.md | `always`, `fileMatch`, `manual` (`#name`), `auto` (by description, "similar to skills") | always/fileMatch push; auto/manual pull | None stated; "keep files focused" | None | MDM/central repo distribution; "maintain like code through reviews" [P: kiro.dev/docs/steering/]. fileMatch reportedly broken for global steering [S: kirodotdev/Kiro#9176] |
| Amp | AGENTS.md, Skills | Docs page not retrievable | [U] | [U] | [U] | [U] |

## 2. Concrete numbers

- Claude Code CLAUDE.md: target <200 lines per file; hard skip at 4 MiB; imports max depth 4; imports still load at launch (no savings). Path-scoped `paths` budget: 1,000 expanded patterns / 4 MiB. [P]
- Claude Code auto memory `MEMORY.md`: first 200 lines or 25KB loaded each session; topic files never loaded at startup. Write-time check warns near limit, errors over limit. [P]
- Claude Code skills: listing 1% of context window default; 1,536 char per-skill description cap; post-compaction 5,000 tokens/skill, 25,000 total; skill listing is NOT re-injected after /compact (only invoked skill bodies). [P: skills doc, context-window doc]
- Project-root CLAUDE.md is re-read from disk after /compact; nested CLAUDE.md and path-scoped rules reload only as matching files are read again. [P]
- Anthropic context editing: trigger 100,000 input tokens, keep 3 tool uses. Memory tool `view` truncates text over 16,000 chars. [P]
- Cursor: <500 lines per rule. [P]
- Windsurf: global rules 6,000 chars; workspace rule 12,000 chars per file. [P]
- Augment: user 24,576 chars; workspace 49,512 chars (note: a search snippet said 49,400; the doc page says 49,512). [P]
- Codex: AGENTS.md `project_doc_max_bytes` 32 KiB. [P]
- Copilot Memory: 28-day expiry of unused entries; validated against current branch before use. [P]
- Copilot repo instructions: ~2 pages recommended. [P]. Code-review 4,000 char cutoff: [U].
- Auto Dream: gates at >=24 h and >=5 sessions since last consolidation; four phases (orient, gather, consolidate, prune/index) targeting MEMORY.md under 200 lines. NOT documented in the official memory page I fetched; sources are third-party blogs and the article itself says it is unannounced. [S/U: claudefa.st, wmedia.es]
- Codex memories: per-rollout summary 125 chars, usage-count then recency ranking, `max_unused_days` forgetting, 9 tunables in `[memories]`. [S]

## 3. Evidence on pull-based reliability

1. Vercel eval (Next.js 16 APIs absent from training data): baseline 53%; skill with default behavior 53% (no gain); skill plus explicit "use it" instruction 79%; 8KB compressed pipe-delimited docs index in AGENTS.md 100% (build/lint/test 100/100/100). In 56% of cases the skill was never invoked even though available. Instruction wording was fragile: "invoke first" missed project config, "explore project first, then invoke" worked better. Original docs 40KB compressed to 8KB (80% cut) with no loss. [P: vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals] Caveat: single vendor, single framework, evaluates reference docs rather than action workflows; Vercel itself concludes skills fit vertical action workflows.
2. Skill activation hooks (Scott Spence, Haiku 4.5, synthetic API calls, 5 prompt types x 10 runs): simple instruction hook 20%, forced-eval hook (model must state YES/NO per skill) 84%, LLM-eval hook 80%; variance 0-100% by prompt type. Caveat: the author flags synthetic calls, not the real Claude Code binary. [S: scottspence.com/posts/how-to-make-claude-code-skills-activate-reliably] A "650 trials" post exists (medium, ivan.seleznov1) but returned 403, so its numbers are unverified. [U]
3. SkillsBench (87 tasks, 8 domains): curated skills raise pass rate 33.9% to 50.5% (+16.6pp), software engineering only +4.5pp; model self-generated skills lowered pass rate 8.1-11.5pp. Relevant to self-improvement loops: unreviewed auto-learned procedures can hurt. [S: alphaxiv/emergentmind summaries of arXiv 2602.12670; not read in full]
4. IFScale (arXiv 2507.11538): instruction-following degrades as simultaneous instructions grow; best frontier model ~68% at 500 instructions; bias toward earlier instructions. Supports a hard cap on always-on rule count. [S: arXiv abstract via search]
5. Anthropic's own docs concede CLAUDE.md is "context, not enforced configuration," recommend hooks for must-run behavior, and say shorter/specific files get better adherence; conflicting rules get picked arbitrarily. [P: code.claude.com/docs/en/memory]
6. Anthropic's memory-tool design compensates for pull unreliability by forcing the pull with a system-prompt protocol ("ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE"). [P]
7. Not found: any vendor-published activation rate for Cursor "Apply Intelligently", Windsurf `model_decision`, Kiro `auto`, Augment Auto or Devin trigger retrieval. [U]

## 4. Patterns worth copying (for a bounded, push-first learned-conventions loop)

1. Two-tier store: a tiny always-pushed index (one line per convention, hard cap in lines AND bytes, e.g. Claude's 200 lines/25KB) plus on-demand detail files. Make the harness, not the model, enforce the cap: after each write, measure and inject a "shorten/merge/drop" reminder near the limit; reject or error over the limit. [Claude Code auto memory]
2. Harness-pushed scoping beats model-pulled retrieval: trigger injection on file read/edit globs (Claude `paths:`, Cursor globs, Copilot `applyTo`, Cline `paths:`, Kiro fileMatch). For a data-engineering agent, the analogous triggers are touched path (models/staging/**, *.sql, dbt_project.yml), warehouse/dialect, tool being called, and task type. The model never has to decide to retrieve.
3. Compress rather than link: Vercel's 8KB index with 100% pass rate suggests a dense one-line-per-rule pipe/terse index in the always-on slot outperforms "see skill X". Budget it explicitly (token budget, not just lines).
4. Always-on only for rules that apply nearly every turn; everything else glob/trigger-scoped. Windsurf `model_decision` and Kiro `auto` still need the model to fetch the body; if you use them, always show the description line (the cheap push) and keep descriptions capped (Claude: 1,536 chars each, 1% total, drop least-used first).
5. Citation + validation gate before use (Copilot Memory): store each learned fact with a pointer to the evidence (file/line, PR, correction quote) and re-validate against the current tree before injecting; skip stale ones silently.
6. TTL by non-use (Copilot 28 days; Codex `max_unused_days` plus usage-count ranking): track last-injected/last-applied per entry, reset on successful use, delete or demote when idle. Cheap, deterministic, no model needed.
7. Separate extraction from consolidation (Codex two phases; Auto Dream gates [S]): cheap per-session extraction into a raw log, then a serialized background consolidation pass (lock, diff of add/retain/remove, merge duplicates, resolve contradictions, absolutize dates, rebuild the index) triggered by thresholds (sessions and elapsed time) so it runs rarely.
8. Human review gate and provenance: Cursor Memories required user approval before save; Devin suggestions are edited/dismissed by the user; Augment records proposer vs correction source; Copilot lets owners delete. SkillsBench's negative result for self-generated skills argues for a promotion step (candidate in a local/raw tier, reviewed into team-shared rules via git PR).
9. Keep hard rules out of the prompt: anything that must happen should be a hook/lint/check, not a learned instruction (Anthropic's explicit advice). Learned conventions that are mechanically checkable should graduate into linters/sqlfluff rules/tests rather than staying as prose.
10. Preserve across compaction deliberately: re-inject the index from disk after compaction (Claude does this for project CLAUDE.md); note that skill listings and lazily loaded nested rules are NOT automatically restored.
11. Measure cost and use: `/skill-doctor` style telemetry (context cost per entry, last used, never used) drives eviction decisions with data.
12. Layered scopes with precedence (managed > user > project > local; Cursor Team Rules; Copilot personal > repo > org) so team conventions and personal preferences do not collide; flag conflicts in an audit (`/doctor prompt-audit`).

## 5. Gaps / unverified

- Auto Dream is not on Anthropic's official memory page as of the fetch; treat triggers and phases as third-party reporting. Anthropic may have shipped it behind a flag.
- Cursor Memories current status (removed in 2.1.x) rests on forum posts. Cursor's own docs on size limits for memories not found.
- Copilot code-review 4,000-char cutoff, Amp loading semantics, Codex memory injection token cap, Windsurf eviction: not confirmed from primary sources.
- Vercel eval and hook-activation numbers are small, vendor/blog-run, on specific tasks and models; treat as directional.

## Sources
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/context-window
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- https://claudefa.st/blog/guide/mechanics/auto-dream
- https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals
- https://scottspence.com/posts/how-to-make-claude-code-skills-activate-reliably
- https://cursor.com/docs/context/rules ; https://cursor.com/changelog/1-2
- https://docs.devin.ai/desktop/cascade/memories (Windsurf docs redirect)
- https://docs.github.com/en/copilot/concepts/agents/copilot-memory
- https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
- https://learn.chatgpt.com/docs/agent-configuration/agents-md ; https://learn.chatgpt.com/docs/customization/memories
- https://codex.danielvaughan.com/2026/04/18/codex-built-in-memory-system-deep-dive/
- https://docs.devin.ai/product-guides/knowledge
- https://kiro.dev/docs/steering/
- https://docs.cline.bot/features/memory-bank ; https://docs.cline.bot/customization/cline-rules
- https://aider.chat/docs/usage/conventions.html
- https://docs.augmentcode.com/setup-augment/guidelines
- https://docs.continue.dev/customize/deep-dives/rules
- https://arxiv.org/abs/2507.11538 ; https://www.alphaxiv.org/abs/2602.12670
