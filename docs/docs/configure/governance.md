# Governance

Most people think of governance as a cost — something you bolt on for compliance. In practice, governance makes agents produce **better results**, not just safer ones.

LLMs have built-in randomization. Give them too much freedom and they explore dead ends, burn tokens, and produce inconsistent output. Constrain the solution space and they get to correct results faster, in fewer tokens, with more consistency.

Task-scoped permissions aren't just about safety — they're about **focus**. When an Analyst agent knows it can only `SELECT`, it doesn't waste cycles considering whether to `CREATE` a temp table. When it has prescribed, deterministic tools for tracing lineage instead of trying to figure it out from scratch, the results are the same every time.

There's an audit angle too. In regulated industries, prescribed tooling eliminates unnecessary audit cycles. When your tools generate SQL the same way every time, auditors can verify consistency. Change the SQL — even if the results are conceptually identical — and you trigger an investigation to prove equivalence. Deterministic tooling removes that overhead entirely.

Altimate Code enforces governance at the **harness level**, not via prompt instructions the model can ignore. Four mechanisms work together:

## Rules

Project rules via `AGENTS.md` files guide agent behavior — coding conventions, naming standards, warehouse policies, and workflow instructions. Rules are loaded automatically from well-known file patterns and merged into the agent's system prompt. Place them at your project root, in subdirectories for scoped guidance, or host them remotely for organization-wide standards.

[:octicons-arrow-right-24: Rules reference](rules.md)

## Permissions

Every tool has a permission level — `allow`, `ask`, or `deny` — configurable globally or per agent. The Analyst agent can't `INSERT`, `UPDATE`, `DELETE`, or `DROP`. That's not a prompt instruction the model can choose to ignore. It's enforced at the tool level. Pattern-based permissions give you fine-grained control: allow `dbt build *` but deny `rm -rf *`.

[:octicons-arrow-right-24: Permissions reference](permissions.md)

## Context Management

Long sessions produce large conversation histories that can exceed model context windows. Altimate Code automatically prunes old tool outputs, compacts conversations into summaries, and recovers from provider overflow errors — all while preserving critical data engineering context like warehouse connections, schema discoveries, lineage findings, and cost analysis results.

[:octicons-arrow-right-24: Context Management reference](context-management.md)

## Formatters

Every file edit is auto-formatted before it's written. This isn't optional consistency — it's enforced consistency. Altimate Code detects file types and runs the appropriate formatter (prettier, ruff, gofmt, sqlfluff, and 20+ others) automatically. The agent can't produce code that violates your formatting standards.

[:octicons-arrow-right-24: Formatters reference](formatters.md)

---

Together, these four mechanisms mean governance is not an afterthought — it's built into every agent interaction. The harness enforces the rules so your team doesn't have to police the output.
