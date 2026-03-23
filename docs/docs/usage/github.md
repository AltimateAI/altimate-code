# GitHub

altimate integrates with GitHub for automated code review and issue handling.

## GitHub Actions

Run altimate as a GitHub Actions bot that responds to PRs and issues.

### Setup

```yaml
# .github/workflows/altimate.yml
name: altimate
on:
  issues:
    types: [opened, labeled]
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Install altimate
        run: npm install -g altimate-code
      - name: Run agent
        run: altimate github
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

!!! important "LLM provider required"
    The workflow `GITHUB_TOKEN` is for repository access only — it cannot be used for LLM inference. You must provide a separate API key (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) as a repository secret. GitHub Copilot and GitHub Models providers are automatically disabled in Actions environments.

### Triggers

| Event | Behavior |
|-------|----------|
| PR opened | Reviews code, suggests improvements |
| PR comment | Responds to review comments |
| Issue opened | Analyzes and suggests solutions |
| Issue labeled | Triggers specific agent modes |

### PR Commands

Comment on a PR to interact with altimate:

```
@altimate review this PR
@altimate check for SQL anti-patterns
@altimate estimate query costs
```

## CLI Usage

```bash
# Run GitHub integration locally
altimate github

# Work with PRs
altimate pr
```
