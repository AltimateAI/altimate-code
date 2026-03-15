# GitLab

altimate integrates with GitLab CI for automated merge request review.

!!! warning "Work in Progress"
    GitLab integration is under active development. Some features may be incomplete.

## GitLab CI

### Setup

```yaml
# .gitlab-ci.yml
altimate-review:
  image: node:22
  stage: review
  script:
    - npm install -g @altimateai/altimate-code
    - altimate github  # Uses GitHub-compatible interface
  variables:
    ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

### Features

- Automated merge request review
- SQL analysis on data pipeline changes
- Cost impact assessment for warehouse queries

### Configuration

GitLab integration uses the same configuration as GitHub. Set your provider API key and warehouse connections in environment variables or CI/CD settings.
