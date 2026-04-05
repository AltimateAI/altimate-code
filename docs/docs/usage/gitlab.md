# GitLab

altimate integrates with GitLab for automated merge request review.

## Quick Start

Review a merge request from the command line:

```bash
export GITLAB_PERSONAL_ACCESS_TOKEN="glpat-xxxxxxxxxxxxxxxxxxxx"
altimate gitlab review https://gitlab.com/org/repo/-/merge_requests/123
```

The review is posted as a note on the MR. To print to stdout instead:

```bash
altimate gitlab review https://gitlab.com/org/repo/-/merge_requests/123 --no-post-comment
```

## Authentication

Set one of these environment variables:

| Variable | Description |
|----------|-------------|
| `GITLAB_PERSONAL_ACCESS_TOKEN` | Preferred. GitLab PAT with `api` scope. |
| `GITLAB_TOKEN` | Fallback (same scope). |

Create a token at: `<your-instance>/-/user_settings/personal_access_tokens` with **api** scope.

## Self-Hosted Instances

The instance URL is extracted from the MR URL automatically. To override (e.g., for internal proxies):

```bash
export GITLAB_INSTANCE_URL=https://gitlab.internal.example.com
```

## GitLab CI

### Setup

```yaml
# .gitlab-ci.yml
altimate-review:
  image: node:22
  stage: review
  script:
    - npm install -g altimate-code
    - altimate gitlab review "$CI_MERGE_REQUEST_PROJECT_URL/-/merge_requests/$CI_MERGE_REQUEST_IID"
  variables:
    GITLAB_PERSONAL_ACCESS_TOKEN: $GITLAB_TOKEN
    ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

### Model Selection

Override the default model with the `--model` flag or `MODEL` / `ALTIMATE_MODEL` env vars:

```yaml
    - altimate gitlab review "$MR_URL" --model openai/gpt-4o
```

## Features

- AI-powered merge request review
- Comment deduplication — re-running updates the existing review note instead of posting duplicates
- SQL analysis on data pipeline changes
- Supports nested GitLab groups and subgroups
- Large MR handling — diffs are automatically truncated when they exceed context limits

## Known Limitations

- Reviews are posted as MR-level notes, not inline per-line comments (inline comments planned for a future release).
- Large MRs (more than 50 files or exceeding 200 KB of diffs) are automatically truncated. The review will note which files were omitted.
