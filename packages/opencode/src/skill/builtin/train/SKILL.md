---
name: train
description: Train your AI teammate on team standards from a document or style guide
---

# Train

## Purpose
Learn team standards and conventions from a document (style guide, review checklist, coding standards, etc.). Extracts actionable rules and saves them as training.

## Workflow

1. **Get the document**: The user provides either:
   - A file reference: `@docs/sql-style-guide.md`
   - A URL: The full URL to fetch (use webfetch tool)
   - Inline text: Pasted directly in the chat

2. **Read and analyze**: Parse the document and extract:
   - Specific, enforceable rules (naming, formatting, prohibited patterns)
   - Review criteria and checklists
   - Glossary terms and definitions
   - Architectural standards

3. **Categorize**: Group findings by training kind:
   - `rule` — Specific do/don't rules (e.g., "Never use SELECT *")
   - `standard` — Broader conventions (e.g., "SQL style guide compliance")
   - `glossary` — Term definitions (e.g., "ARR = Annual Recurring Revenue")

4. **Present summary**: Show the user what you extracted:
   - Number of rules, standards, and glossary terms found
   - Preview of each item
   - Ask for confirmation before saving

5. **Save via training_save**: Save each item using the `training_save` tool. For documents with many rules, consolidate related rules into logical groups (e.g., "sql-naming-rules" with 5 rules, rather than 5 separate entries).

## Important Guidelines

- Only extract ACTIONABLE items. Skip vague guidance like "write clean code."
- Consolidate related rules into single training entries to avoid clutter.
- Preserve the original wording when it's specific and clear.
- If the document is too large, focus on the most impactful rules.
- Always use `scope: project` unless the user specifies global.
- Do NOT make any extra LLM calls — analysis happens in the normal conversation flow.

## Usage Examples

```
/train @docs/sql-style-guide.md
/train https://wiki.company.com/data-team/review-checklist
/train   (then paste content inline)
```
