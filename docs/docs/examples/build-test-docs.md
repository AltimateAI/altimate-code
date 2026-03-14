# Build, Test & Document dbt Models

Pull context from your Knowledge Hub, grab requirements from a Jira ticket, and update dbt models — all within your IDE.

## Overview

This workflow automates the full lifecycle of building a dbt model: reading a Jira ticket, understanding the existing project structure, writing the model, adding tests and documentation, and updating the ticket — without leaving your editor.

## Workflow

### 1. Retrieve ticket details from Jira

The agent connects to Jira and pulls the requirements from the assigned ticket (e.g., `AI-2984`), including acceptance criteria and any linked context.

### 2. Understand the dbt project

The agent inspects the existing dbt project structure — models, sources, tests, and macros — to understand naming conventions and patterns already in use.

### 3. Mark work in progress

An initial comment is added to the Jira ticket marking that work has started, keeping your team informed.

### 4. Build the model

Based on the ticket requirements and existing project patterns, the agent creates the new dbt model (e.g., a new mart layer) with:

- Proper SQL following your project conventions
- Joins and transformations matching the requirements
- Column naming aligned with existing models

### 5. Add documentation and tests

The agent references organizational best practices stored in the **Knowledge Hub** to:

- Generate `schema.yml` entries with column descriptions
- Add `not_null`, `unique`, and relationship tests
- Create custom tests where the requirements call for them

### 6. Build, test, and verify

```bash
dbt build --select +new_model
```

The agent runs the model, executes tests, and confirms everything passes.

## Key features

| Feature | Description |
|---|---|
| **Knowledge Hub** | Centralizes your team's best practices and tribal knowledge so the AI follows your standards |
| **Jira integration** | Reads requirements directly from tickets and updates status as work progresses |
| **IDE integration** | Works within Cursor, VS Code, or other supported editors — no context switching |
| **Convention-aware** | Inspects your existing project to match naming, structure, and testing patterns |

## Try it

See the full interactive walkthrough on the [Datamates documentation site](https://datamates-docs.myaltimate.com/examples/build-test-document-dbt-model/).
