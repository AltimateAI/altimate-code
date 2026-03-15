# IDE

!!! warning "Work in Progress"
    This page is under active development. Content may be incomplete or change frequently.

Altimate AI provides the **Datamates** extension for VS Code, Cursor, and compatible editors — giving you AI teammates for data engineering work directly in your IDE.

## Installation

Install from one of these sources:

- **VS Code Marketplace**: Search for "Datamates" by altimateai, or [install directly](https://marketplace.visualstudio.com/items?itemName=altimateai.vscode-altimate-mcp-server)
- **Open VSX Registry**: For Cursor and other VS Code-compatible editors

!!! tip
    If you already have an Altimate API key from the dbt Power User extension, you can reuse those credentials.

## Features

### Automate Building and Testing Data Pipelines

Datamates automates end-to-end pipeline work: retrieves issue details from Jira, analyzes your dbt project structure and code, identifies root causes using best practices and change history, makes fixes, compiles models, checks dependencies, examines column mappings, and merges changes to production.

### Automate Migrations

Transform PySpark code to dbt models. Datamates analyzes PySpark repositories, creates equivalent dbt models and marts, understands schema structures and lineage, builds models with proper dependencies, and validates outputs by executing SQL on both implementations.

### Tool Integration

Connect your entire data stack through natural language:

| Category | Supported Tools |
|---|---|
| **Data Stores** | Snowflake, BigQuery, Databricks, PostgreSQL |
| **Orchestration** | Airflow |
| **Version Control** | GitHub |
| **Project Management** | Jira |
| **Data Transformation** | dbt |
| **Generic DB Support** | Most databases via [SQL Tools](https://marketplace.visualstudio.com/items?itemName=mtxr.sqltools) |
| **Custom** | Python, API, and MCP integrations |

### Knowledge Hub

Centralize your team's expertise and documentation:

- Upload organizational best practices and guidelines
- Access documentation directly in your AI assistant
- Create referenceable links for DOCS in Cursor, `#fetch` in GitHub Copilot, or `@web` in Windsurf
- Maintain consistency across all team members

### Memory Hub

Context-aware assistance that remembers your work:

- Automatically searches relevant past interactions based on current tasks
- Builds on previous solutions and learnings
- Shares institutional knowledge across projects
- Provides personalized assistance based on work history

