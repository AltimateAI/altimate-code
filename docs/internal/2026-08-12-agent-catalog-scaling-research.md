# Scaling Agent Catalogs Without Losing TUI Speed

## Executive Summary

- **Hybrid Selection**: Claude Code, OpenCode, Cursor, Codex, and Cline all expose a user-facing agent that can delegate bounded work to specialists, while also offering explicit ways to invoke or configure specialists. Claude Code uses description-based routing plus explicit `@` selection, and OpenCode uses automatic invocation plus `@` mentions. [16] [16] [5] [5] -> Keep automatic delegation, but always provide an explicit picker and mention syntax.
- **Primary/Subagent Separation**: A primary agent owns the conversation and delegates; a subagent is a focused worker with a narrower context or tool set. Claude Code can also run a custom subagent as the main session with `--agent`, which demonstrates that the same definition can support both roles. [5] [16] -> Give every altimate-code agent a default role and an optional promotion path to primary.
- **Search Beats Cycling**: Tab cycling is a good fast path for four stable top-level modes, but it becomes a linear, low-discoverability interaction as the catalog grows. The documented products increasingly use typeahead, slash commands, mentions, or automatic routing instead of requiring users to cycle through every specialist. Claude Code's plugin agents appear in scoped `@` typeahead, while Cline uses slash commands and Goose uses custom recipe commands. [16] [16] [31] [25] -> Keep Tab for a small pinned set and add a fuzzy catalog palette before adding more tabs.
- **Markdown Boundary**: Claude Code, GitHub Copilot, VS Code, and Goose expose human-editable definitions as Markdown or YAML/JSON-adjacent files. Claude Code uses YAML frontmatter followed by a Markdown system prompt; GitHub Copilot custom agents use Markdown with YAML frontmatter; Goose recommends YAML and also accepts JSON. [16] [2] [25] -> Use Markdown plus frontmatter for authoring, then compile it into a typed, signed runtime manifest.
- **Repository Distribution**: GitHub Copilot distributes organization custom agents through a dedicated repository and gives repository, organization, and enterprise levels precedence rules. Claude Code distributes extensions through plugin marketplaces and supports organization-managed settings. [2] [18] [15] -> Treat a SaaS catalog as an authenticated, versioned package channel, not as an arbitrary prompt download.
- **Permission Inheritance**: Agent definitions do not safely grant authority merely by declaring tools. Claude Code combines permission rules with OS-level sandboxing, and its managed settings cannot be overridden by lower-precedence user or project settings. GitHub Copilot supports explicit tool lists, including `tools: []` to disable tools. [8] [8] [8] [2] [2] -> A customer-uploaded definition may request capabilities, but the client and tenant policy must decide whether those capabilities are actually available.
- **Versioned Runtime**: LangSmith separates an assistant's configuration from graph logic and maintains configuration history with promotion and rollback. Its deployment runtime is designed for durable execution, streaming, and horizontal scaling. [39] [39] [3] -> Resolve and pin an immutable agent bundle when a session starts, and support staged rollout and rollback.
- **Trust Tiers**: Prompt-only definitions, tool-enabled definitions, MCP connectors, and executable plugins have very different risk profiles. OpenCode's permission keys include read, edit, bash, task, web fetch, and web search, while Claude plugin subagents do not accept some privileged frontmatter fields such as `mcpServers` and `permissionMode`. [5] [16] -> Start third-party uploads as prompt-only or read-only; require explicit approval and stronger isolation for tools, network access, secrets, MCP, and executable code.

## Selection UX: Why Linear Tabs Stop Scaling Beyond Five Agents

There are five distinct selection patterns, and they should not be treated as interchangeable.

| Pattern | Best use | Strength | Failure mode beyond approximately five agents | Recommendation for altimate-code |
|---|---|---|---|---|
| Tab cycling | A small set of stable primary modes | Very fast after learning; visible state | Linear navigation, weak discovery, no room for descriptions or capabilities | Keep for four to six pinned primary lanes |
| Command palette | A catalog of many user-invocable agents | Fuzzy search, categories, recent items, keyboard-first interaction | Requires good labels, descriptions, and ranking | Make this the default catalog surface |
| `@` mention | Selecting a specialist inline in a request | Explicit, composable, works in a terminal prompt | Names must be memorable; poor for unknown agents | Support `@agent-name` with typeahead and aliases |
| Slash command | Short, repeatable workflows or recipes | Discoverable command vocabulary and argument syntax | Commands become a second catalog if every specialist gets one | Reserve for workflows, not every agent |
| Automatic delegation | Routing routine work to specialists | Lowest interaction cost and preserves the main context | Misrouting, hidden cost, and loss of user control | Use confidence thresholds, explanations, and opt-out |

The strongest pattern is hybrid: automatic routing for routine specialist work, explicit typeahead for intentional selection, and a small persistent primary set. Claude Code makes the distinction particularly clear. Its main agent can delegate based on the task, subagent description, and context; an `@` mention forces a chosen subagent; and `--agent` runs that definition as the main session. [16] [16] [16] That is a better scaling model than turning every specialist into a peer mode.

OpenCode follows the same architectural split. Primary agents handle the main conversation, while subagents are specialized assistants that the primary can invoke automatically or through an `@` mention. Its Markdown and JSON definitions expose descriptions, modes, models, prompts, and permissions, which gives the catalog enough metadata for search and routing. [5] [5] [5] The implication is important for altimate-code: the description is not documentation only; it is a routing index and should be written as a concise routing rule.

A command palette should therefore display more than a name. Each result should include a one-line purpose, category, trust badge, read/write badge, estimated cost or model, and whether it is user-invocable, model-invocable, or both. A recent/favorites section and project-local filtering will make dozens of agents manageable without forcing users to learn every name.

## What the Named Tools Reveal About Primary and Delegated Agents

| Product | Primary/user-facing mechanism | Specialist/delegation mechanism | Definition or catalog structure | Scaling lesson |
|---|---|---|---|---|
| Claude Code | Main session; `claude agents` opens agent view; `--agent name` makes a custom agent the main session | Automatic description routing, `@` typeahead, parallel subagents | User and project `.claude/agents`; plugin agents use scoped names such as `my-plugin:review:security` | Mature hybrid: palette/typeahead plus automatic delegation and explicit promotion to primary [16] [16] [16] [26] |
| OpenCode | Primary agents own the main conversation | Automatic invocation or `@` mention | Global or project Markdown agents; JSON `opencode.json`; explicit permissions | Closest precedent for altimate-code: keep primary lanes small and make specialists addressable [5] [5] [5] |
| Cursor | Agent is the user-facing assistant | Official docs describe automatic subagent use and creation of `.cursor/agents` custom subagents | Project-local agent files and Agent Skills | Automatic delegation is the center of gravity; do not assume a large manually cycled mode list [29] [29] |
| Codex CLI | Main Codex thread | User can ask for parallel subagents; project or skill instructions may also trigger delegation; subagent threads can be inspected | Built-ins plus TOML files under `~/.codex/agents/` or `.codex/agents/` | Separate worker threads and summaries protect the main context; use this for read-heavy work [20] |
| Charm Crush | One terminal coding assistant | No mature multi-agent UX is established in the retrieved official material | Agent Skills are supported; the official subagent request remains open | Skills are not the same as a selectable agent catalog; do not copy a feature gap as a design precedent [21] [32] |
| Aider | One pair-programming session with chat modes | Architect proposes changes and an editor applies them; `/code`, `/architect`, `/ask`, and `/help` switch modes | Mode-oriented command vocabulary, not a many-agent catalog | Good example of a small mode set, but not a model for dozens of specialists [42] |
| Goose | Main Goose session | Recipes, subrecipes, and custom slash commands package and invoke repeatable workflows | Recipes are reusable configurations; YAML is recommended and JSON is also accepted | Distinguish a workflow recipe from a persistent agent identity [30] [25] |
| Cline | Main Cline task | Slash commands and skills; subagents run focused research in parallel with separate prompts and contexts | Skills and subagent tasks | Use subagents for bounded research, not as dozens of permanent top-level modes [27] [31] |
| GitHub Copilot CLI | Main Copilot session | Custom agents can be automatically chosen or manually invoked, with invocation controls | `.agent.md` profiles, skills, MCP tools, and organization repositories | `user-invocable` and `disable-model-invocation` are useful policy fields to copy [2] [2] |

The contrast cases are valuable. Aider's architect/editor split is effective because the modes are few and semantically broad. Goose's recipe model is effective for repeatable workflows, but a recipe may include instructions, extensions, parameters, and subrecipes without being a new conversational persona. [30] Cline similarly frames subagents as parallel context-bounded research workers rather than a flat list of permanent personas. [27]

Crush provides a useful failure case for product maturity. Its repository exposes Agent Skills, but the official issue requesting configurable subagents and per-subagent models is still open. [32] [21] This suggests that adding a skill packaging standard does not automatically solve selection, lifecycle, or orchestration. Those concerns need separate product primitives.

The emerging 2025-2026 consensus is therefore not one universal control. It is a layered model: a small primary mode set, search or typeahead for explicit specialist choice, slash commands for workflows, and description-driven delegation for routine work. The design must make automatic routing observable because hidden delegation can surprise users with cost, latency, permissions, or changes to files.

## Runtime Definitions: Markdown for Authors, Typed Manifests for Execution

The file formats show convergence at the authoring boundary, not at the execution boundary.

| Product/platform | Authoring format | Runtime/distribution model | Important controls |
|---|---|---|---|
| Claude Code | Markdown body with YAML frontmatter | Local user/project directories, session definitions, or plugin marketplace packages | Description, prompt, tools, disallowed tools, model, permission mode, MCP, hooks, max turns, isolation, and invocation behavior; plugin agents have limitations [16] [16] |
| OpenCode | Markdown with frontmatter or JSON under `opencode.json` | Global or project configuration plus plugins | `description`, `mode`, `model`, `prompt`, `temperature`, `steps`, `hidden`, and per-tool `allow`, `ask`, or `deny` permissions [5] [5] |
| GitHub Copilot | Markdown agent profile with YAML frontmatter | Enterprise, organization, repository, and user scopes; CLI can use the same profile concept | Level precedence, manual/model invocation controls, tool list, MCP servers, and Git commit-based profile versioning [2] [2] [2] [2] |
| VS Code | `.agent.md` custom-agent files | Workspace/user discovery plus installable Agent Plugins and extension marketplaces | Agent tools, handoffs, approvals, workspace trust, and sandbox controls [40] [59] |
| Goose | `.yaml` or `.yml` recommended; `.json` accepted | Reusable recipes, included subrecipes, and slash-command invocation | Instructions, settings, extensions, parameters, and subrecipe composition [25] |
| LangSmith | Application graph plus separately managed assistant configuration | Agent Server and LangSmith Deployment; assistants can specialize the same graph | Configuration history, version promotion, rollback, durable execution, streaming, and horizontal scaling [39] [39] [3] |
| OpenAI Agent Builder | Visual graph with typed nodes and workflow identity | Publish a workflow, pass its ID to ChatKit, or export Agents SDK code | Preview, typed inputs/outputs, guardrails, connector administration, and deployment identity [11] |

Markdown plus frontmatter is winning as the human-facing format because it lets a developer review the instructions in a pull request, add comments or examples, and keep the prompt adjacent to its metadata. GitHub Copilot's frontmatter also makes policy fields visible: a profile can be manually selectable, model-invocable, tool-limited, or connected to MCP. [2] [2] [2]

JSON, YAML, and TOML remain useful where configuration is primarily machine-authored or needs strict nesting. OpenCode uses JSON in `opencode.json` in addition to Markdown, Codex uses standalone TOML files for personal and project agents, and Goose recommends YAML while accepting JSON. [5] [20] [25] The right conclusion is not that JSON or TOML lost. It is that Markdown should be the import/export surface and a schema-validated manifest should be the execution surface.

LangSmith illustrates the cleanest separation of identity and implementation. An assistant stores configuration such as prompts, model selection, and tools separately from the graph's core logic, so multiple specialized configurations can use one graph architecture. [39] Its configuration history and promote/rollback behavior are directly applicable to a SaaS agent catalog.

## Distribution and Organization Sync: Package Channels Beat Prompt Injection

There are three distribution patterns in the current products.

First, repository-backed distribution treats definitions like source code. GitHub Copilot's organization workflow uses a repository for custom agents, and its precedence model lets repository-level definitions override organization-level definitions, which override enterprise-level definitions. [18] [2] This is easy to audit and familiar to engineering teams, but it is tied to GitHub's repository and access model.

Second, marketplace-backed distribution treats definitions as installable packages. Claude Code defines a plugin marketplace as a catalog for distributing extensions and supports organization-managed marketplace policy and plugin synchronization. [15] Plugins can contain agents, skills, hooks, and other components, but plugin subagents do not accept every privileged field that local subagents can use. [16] [16] That asymmetry is a good security precedent: package provenance should not silently confer local authority.

Third, hosted-runtime distribution keeps the definition server-side. LangSmith Agent Server exposes assistants through a managed runtime, while OpenAI Agent Builder publishes a workflow and supplies an identifier for ChatKit or an SDK deployment. [3] [11] This avoids copying prompts to every client, but it is less suitable for an offline terminal or for a user who expects local file access unless the client also supplies a controlled execution bridge.

For altimate-code, use a hybrid package channel. The CLI should authenticate to the SaaS control plane, receive only the bundles allowed for the tenant, organization, project, user, and current repository, verify their signatures, and cache them locally. The session should resolve a bundle version once at startup. A background refresh may update the catalog for the next session, but should not silently change the instructions or permissions of an active run.

The control plane should support org-wide defaults, project overrides, user favorites, staged releases, deprecation, rollback, and an offline cache with an explicit expiration policy. The effective configuration should be visible through a status command, for example `/agents status`, showing source, version, trust tier, tools, and policy decisions. This gives the user the same kind of provenance that repository-backed and marketplace-backed products provide without requiring the SaaS to impersonate a Git repository.

## Security and Trust: Uploaded Text Must Not Be a Capability Grant

An uploaded agent has two separate powers: it can change what the model is instructed to do, and it may request access to tools or data. The first is a prompt-injection and behavior risk. The second is a capability risk. Treating both as one free-form Markdown upload is unsafe.

The products provide several useful controls. Claude Code permission rules govern tools and file or domain access, while its sandbox applies OS-level restrictions to Bash and child processes. Deny rules can stop a call even if the model is persuaded to attempt it, and managed settings cannot be overridden by lower-precedence user or project settings. [8] [8] [8] GitHub Copilot similarly lets a custom agent enumerate tools, and `tools: []` disables tools rather than inheriting them implicitly. [2] [2] VS Code documents trust, approvals, and sandboxing as separate AI safety controls rather than relying only on agent instructions. [10]

Use four explicit capability tiers:

1. **Prompt-only**: system prompt, description, model preference, output format, and routing metadata. No tools, secrets, network, or code execution.
2. **Workspace read**: read-only repository and metadata access in an approved root. Suitable for analyst, reviewer, and inventory agents.
3. **Workspace write**: edit and patch capabilities, with user approval for writes, commits, migrations, or generated files. Suitable for builder and optimizer agents.
4. **External or executable**: Bash, network, database mutations, MCP, secrets, hooks, package installation, or plugin code. Require administrator approval, explicit trust, sandboxing, and audit logging.

The client must intersect capabilities rather than union them. Effective permission equals the minimum of tenant policy, project policy, user policy, local safety settings, agent request, and current run approval. An uploaded definition can request `read` or `edit`, but it cannot escalate a tenant deny rule. Network access should be allowlisted by domain, database access should use short-lived scoped credentials, and secrets should be references resolved by the runtime rather than literal prompt content.

Do not enable arbitrary hooks or executable plugins in the first version of runtime upload. A safe initial product can accept Markdown, frontmatter, and a restricted tool declaration, then compile that content into a signed manifest. MCP, shell, browser, and custom code should be separate installable components with independent provenance and consent. This is stricter than a prompt-only marketplace, but it prevents a seemingly harmless "cost audit" agent from gaining the ability to run arbitrary database or shell commands.

## Recommended Altimate-Code Selection Model for Dozens of Agents

Keep the current four primary agents, but redefine their role as persistent workspaces rather than the entire catalog:

- **Builder**: the write-capable implementation lane.
- **Analyst**: read-heavy exploration and diagnosis.
- **Reviewer**: read-only or approval-gated quality and risk analysis.
- **Optimizer**: performance and cost work, with explicit write approval.

Tab remains valuable because these four names are stable, memorable, and visible in the TUI. Add at most one or two additional pinned lanes only when they represent a durable session posture, not a one-off task. Do not put `dbt model lineage`, `warehouse cost audit`, `migration planner`, `PR review`, and every customer agent into the Tab ring.

Add three explicit entry points:

1. **Palette**: `/agent` or a keybinding opens a fuzzy searchable catalog. Search name, description, aliases, tags, and capability. Show category, trust tier, tools, model, and whether the agent runs as primary or subagent. Include `Recent`, `Favorites`, `Project`, `Organization`, and `Installed` groups.
2. **Mention**: typing `@` in a prompt opens the same catalog and inserts an explicit specialist selection. Support namespaced IDs such as `org:dbt-cost-audit` and short aliases such as `@cost`. Use typeahead, not a full list dump.
3. **Automatic routing**: the primary agent may delegate when the task matches an agent description and the confidence score exceeds a threshold. Show a compact event such as `Delegating to @dbt-cost-audit: read-only warehouse cost analysis`, and let the user cancel, inspect, or make the choice persistent.

Every definition should declare `mode: primary`, `mode: subagent`, or `mode: both`, with `subagent` as the default for customer uploads. A primary agent owns the main conversation, accumulated context, final decisions, and user interaction. A subagent gets a bounded task, a limited context projection, and a result contract such as findings, proposed patch, or structured analysis. `both` should be reserved for definitions that are safe and coherent as a full session, such as a customer-approved migration workspace.

Add explicit invocation policy fields modeled on the useful distinction in GitHub Copilot: `user_invocable` and `model_invocable`. [2] A security reviewer might be user-invocable but not automatically selected; a generic SQL investigator might be model-invocable and user-invocable; an experimental customer agent might be neither until enabled.

## Recommended SaaS Architecture: Control Plane, Signed Bundle, Local Runtime

Use a three-layer architecture.

**1. Control plane.** Store agent source, metadata, ownership, version history, approvals, and policy bindings in the SaaS. Each agent has a stable logical ID and immutable versions. Maintain tenant, organization, project, and user scopes. Provide draft, review, publish, staged, active, deprecated, and revoked states. Store the original Markdown for review, but also store the normalized manifest and a content hash.

**2. Distribution service.** Expose an authenticated catalog endpoint that returns only definitions visible to the caller and current project. Use the CLI's existing login or device flow, short-lived access tokens, tenant claims, and repository/project identity. Return a signed bundle containing the manifest, prompt body, referenced skill hashes, policy requirements, minimum client version, and expiration or revocation metadata. Use conditional fetches and local caching so a terminal session remains usable during a brief network outage.

**3. Local execution runtime.** The CLI verifies the signature, validates the schema, checks client compatibility, applies local and tenant policy, and materializes an immutable session snapshot. It should never execute arbitrary code while parsing Markdown. The runtime can render a prompt-only agent immediately, but tools, MCP servers, hooks, and plugins should pass separate trust and installation gates.

A practical manifest can look like this:

```yaml
schema: altimate.agent/v1
id: org.example.dbt-cost-audit
version: 3.2.1
name: dbt Cost Audit
description: Find warehouse cost regressions in dbt models and propose read-only fixes
mode: subagent
user_invocable: true
model_invocable: true
prompt: |
  You are a specialist in warehouse cost analysis...
capabilities:
  filesystem: [workspace.read]
  tools: [catalog.query_readonly, dbt.parse]
  network: []
  secrets: []
limits:
  max_turns: 12
  max_parallel_tasks: 2
routing:
  tags: [dbt, warehouse, cost, performance]
  examples: ["find expensive models", "audit warehouse spend"]
provenance:
  publisher: org.example
  source: customer-upload
  content_sha256: ...
  signature: ...
```

The Markdown source should be the authoring and review format, while the manifest is the only format the runtime trusts. Reject unknown fields or place them in an inert extension namespace. Never let frontmatter specify raw API keys, unrestricted shell commands, arbitrary network destinations, or a permission mode that outranks policy. The manifest's `capabilities` field is a request; the runtime computes an `effective_capabilities` field after policy intersection and displays the result.

For observability, log bundle ID and version, policy decisions, tool approvals, delegation events, and outputs that caused writes or external calls. Do not log secrets or entire sensitive prompts by default. Provide administrators with provenance and audit views, and provide users with `/agent explain` to show why a specialist was selected and what it can do.

## Synthesis: The Scalable Pattern Is A Small Core Plus A Searchable Catalog

The tools diverge in surface details, but they converge on a structural answer. Claude Code and OpenCode explicitly separate primary agents from subagents; Cursor, Codex, and Cline emphasize automatic or parallel delegation; Goose packages repeatable workflows as recipes; Aider stays intentionally small with chat modes; and Crush shows that skills alone do not solve multi-agent orchestration. [5] [29] [27] [25] [42] [21]

The mechanism trade-off is clear. Tabs optimize speed for a tiny stable set. Palettes and mentions optimize discovery and intentional choice. Automatic routing optimizes effort and context management but needs visibility and an escape hatch. Slash commands are strongest for deterministic workflows, not for a catalog of dozens of vaguely named personas.

The recommended altimate-code design is therefore not "replace Tab with a giant list." It is a two-level system: four primary workspaces remain in Tab, while a namespaced, searchable catalog contains specialist subagents and recipes. Any safe agent can be promoted to primary for a session, but customer uploads default to subagent and prompt-only trust.

On distribution, use the same boundary that the strongest platforms expose: human-readable files for authoring, repositories or authenticated package channels for provenance, typed manifests for runtime, and policy-controlled capabilities for execution. A signed, version-pinned bundle with tenant scoping and client-side policy intersection gives customers the convenience of runtime availability without allowing an uploaded prompt to become an uncontrolled local program.

## References

1. *Custom agents in VS Code*. https://code.visualstudio.com/docs/copilot/chat/chat-modes
2. *Custom agents configuration*. https://docs.github.com/en/copilot/reference/custom-agents-configuration
3. *LangSmith Deployment*. https://docs.langchain.com/langsmith/deployment
4. *About custom agents*. https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-custom-agents
5. *Agents | OpenCode*. https://opencode.ai/docs/agents/
6. *Introducing AgentKit | OpenAI*. https://openai.com/index/introducing-agentkit/
7. *Plugins reference*. https://code.claude.com/docs/en/plugins-reference
8. *Configure permissions*. https://code.claude.com/docs/en/permissions
9. *Config | OpenCode*. https://opencode.ai/docs/config/
10. *Trust and safety*. https://code.visualstudio.com/docs/agents/concepts/trust-and-safety
11. *Agent Builder*. https://developers.openai.com/api/docs/guides/agent-builder
12. *Configure the sandboxed Bash tool*. https://code.claude.com/docs/en/sandboxing
13. *Application card: GitHub Copilot Agents*. https://docs.github.com/en/copilot/responsible-use/agents
14. *Agent Server*. https://docs.langchain.com/langsmith/agent-server
15. *Create and distribute a plugin marketplace*. http://code.claude.com/docs/en/plugin-marketplaces
16. *Create custom subagents*. https://code.claude.com/docs/en/sub-agents
17. *Discover and install prebuilt plugins through marketplaces*. http://code.claude.com/docs/en/discover-plugins
18. *Preparing to use custom agents in your organization*. https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/prepare-for-custom-agents
19. *Creating and using custom agents for GitHub Copilot CLI*. https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli
20. [
  Subagents | ChatGPT Learn
](https://learn.chatgpt.com/docs/agent-configuration/subagents)
21. *feat: subagents · Issue #431 · charmbracelet/crush · GitHub*. https://github.com/charmbracelet/crush/issues/431
22. *Aider - AI Pair Programming in Your Terminal*. https://aider.chat/
23. *Run agents in parallel*. https://code.claude.com/docs/en/agents
24. [
  Advanced Configuration | ChatGPT Learn
](https://learn.chatgpt.com/docs/config-file/config-advanced)
25. *Recipe Reference Guide | goose | Your open source AI agent*. https://goose-docs.ai/docs/guides/recipes/recipe-reference/
26. *Manage multiple agents with agent view*. https://code.claude.com/docs/en/agent-view
27. *Subagents*. https://docs.cline.bot/features/subagents
28. *Using Agent in CLI | Cursor Docs*. http://cursor.com/docs/cli/using
29. *Subagents | Cursor Docs*. https://cursor.com/docs/subagents
30. *Reusable Recipes | goose | Your open source AI agent*. https://goose-docs.ai/docs/guides/recipes/session-recipes
31. *Using Commands*. https://docs.cline.bot/core-workflows/using-commands
32. *GitHub - charmbracelet/crush: Glamourous agentic coding for all 💘 · GitHub*. https://github.com/charmbracelet/crush
33. *Overview | Cursor Docs*. https://cursor.com/docs/agent/overview
34. *Adding agent skills for GitHub Copilot CLI*. https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-cli/customize-copilot/add-skills
35. *Tools*. https://docs.cline.bot/tools-reference/all-cline-tools
36. *CLI Commands | goose | Your open source AI agent*. https://goose-docs.ai/docs/guides/goose-cli-commands/
37. *Using GitHub Copilot CLI*. https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview
38. *Options reference | aider*. https://aider.chat/docs/config/options.html
39. *Assistants - Docs by LangChain*. https://docs.langchain.com/langsmith/assistants
40. *Custom agents in VS Code*. https://code.visualstudio.com/docs/agent-customization/custom-agents
41. *Tools*. https://opencode.ai/docs/tools/
42. *Chat modes*. https://aider.chat/docs/usage/modes.html
43. *Plugins*. https://opencode.ai/docs/plugins/
44. [Chat Participant API | Visual Studio Code Extension
API](https://code.visualstudio.com/api/extension-guides/ai/chat)
45. *http://cursor.com/docs*. http://cursor.com/docs
46. *Agent Skills | Cursor Docs*. https://cursor.com/docs/skills
47. *Agent Skills*. https://opencode.ai/docs/skills/
48. *Aider Documentation*. https://aider.chat/docs/
49. *Workspace agents | OpenAI*. https://openai.com/academy/workspace-agents/
50. *Plugins | Cursor Docs*. https://cursor.com/docs/plugins
51. *Separating code reasoning and editing*. https://aider.chat/2024/09/26/architect.html
52. *Set up Claude Code for your organization*. https://code.claude.com/docs/en/admin-setup
53. *Enterprise | Cursor Docs*. http://cursor.com/docs/enterprise
54. *Configure server-managed settings*. https://code.claude.com/docs/en/server-managed-settings
55. *About GitHub Copilot cloud agent*. https://docs.github.com/copilot/concepts/agents/cloud-agent/about-cloud-agent
56. *Managing GPT access in Enterprise and Edu workspaces | OpenAI Help Center*. https://help.openai.com/en/articles/8555535-managing-gpt-access-in-enterprise-and-edu-workspaces
57. *How to Use Aider in 2026: Setup, Architect Mode & Git ...*. https://www.deployhq.com/guides/aider
58. *Tips*. https://aider.chat/docs/usage/tips.html
59. *Agent plugins in VS Code*. https://code.visualstudio.com/docs/agent-customization/agent-plugins
