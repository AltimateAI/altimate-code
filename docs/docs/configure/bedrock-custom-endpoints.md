---
title: Amazon Bedrock Custom Endpoints — Altimate Code
description: "Configure Altimate Code to use a custom Amazon Bedrock endpoint, API gateway, or proxy for your LLM calls."
---

# Amazon Bedrock Custom Endpoints

This guide covers using Altimate Code with a custom Amazon Bedrock endpoint — such as a corporate API gateway, reverse proxy, or VPC endpoint that sits in front of Bedrock.

## When to use this

Use this setup when your organization:

- Routes Bedrock traffic through a centralized API gateway
- Requires a custom domain or proxy for compliance / network policy
- Uses a bearer token instead of standard AWS IAM credentials

## Prerequisites

You need one of the following:

- A **bearer token** issued by your gateway (most common for custom endpoints)
- Standard **AWS credentials** (access key, SSO profile, IAM role) if your gateway still delegates to the AWS credential chain

## Step 1: Set up authentication

=== "Bearer Token"

    Export the token as an environment variable. Add this to your shell profile (`~/.zshrc`, `~/.bashrc`, or equivalent):

    ```bash
    export AWS_BEARER_TOKEN_BEDROCK="your-bearer-token-here"
    ```

    Then reload your shell:

    ```bash
    source ~/.zshrc
    ```

    !!! tip
        If your organization uses the Altimate Code TUI, you can store the token via `altimate-code auth login --provider amazon-bedrock` instead of exporting it in your shell profile.

=== "AWS Credential Chain"

    If your gateway forwards standard AWS credentials, no extra auth setup is needed. Altimate Code uses the standard AWS credential chain:

    1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` environment variables
    2. `AWS_PROFILE` (named profile from `~/.aws/config`)
    3. IAM role / SSO session
    4. Web identity token (`AWS_WEB_IDENTITY_TOKEN_FILE`)
    5. ECS / EKS container credentials

    To use a specific AWS profile, set it in the config:

    ```json
    {
      "provider": {
        "amazon-bedrock": {
          "options": {
            "profile": "my-sso-profile"
          }
        }
      }
    }
    ```

!!! note
    When a bearer token is present, the AWS credential chain is bypassed entirely. The bearer token always takes precedence.

## Step 2: Create the config

Create or edit `~/.config/altimate-code/altimate-code.json`:

```json
{
  "model": "amazon-bedrock/anthropic.claude-sonnet-4-6-v1",
  "provider": {
    "amazon-bedrock": {
      "options": {
        "baseURL": "https://your-gateway.example.com/bedrock/v1",
        "region": "us-east-1"
      }
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `model` | The model to use, prefixed with `amazon-bedrock/`. |
| `baseURL` | Your custom gateway URL. Replace with your organization's endpoint. |
| `region` | The AWS region your gateway targets (e.g., `us-east-1`, `eu-west-1`). |

!!! info "The `baseURL` path"
    The path portion of the `baseURL` (e.g., `/bedrock/v1`) depends entirely on how your API gateway is configured. Ask your platform team for the correct URL — there is no universal standard path.

### Config scope

| Config location | Scope |
|-----------------|-------|
| `~/.config/altimate-code/altimate-code.json` | Global — applies to all projects |
| `altimate-code.json` in a project root | Project — overrides global config for that project |

## Step 3: Launch

```bash
altimate-code
```

The status bar should display your selected model under Amazon Bedrock.

## Cross-region model ID prefixing

Altimate Code may prepend a region prefix to model IDs for cross-region inference when the selected model and region require it. For example, with `region: "us-east-1"` the model ID `anthropic.claude-sonnet-4-6-v1` is sent to the gateway as `us.anthropic.claude-sonnet-4-6-v1`.

Prefixing is conditional on **both** the region and the model family:

| Your region | Prefix | Models prefixed |
|-------------|--------|-----------------|
| `us-*` (except GovCloud) | `us.` | Claude, Nova, DeepSeek |
| `eu-*` | `eu.` | Claude, Nova Lite/Micro, Llama 3, Pixtral |
| `ap-northeast-1` (Tokyo) | `jp.` | Claude, Nova Lite/Micro/Pro |
| `ap-southeast-2`, `ap-southeast-4` (Australia) | `au.` | Claude Sonnet 4.5, Claude Haiku |
| Other `ap-*` | `apac.` | Claude, Nova Lite/Micro/Pro |

Models not listed in the table for a given region are **not** prefixed.

**If your gateway expects the prefixed ID** (e.g., `us.anthropic.claude-sonnet-4-6-v1`), no changes are needed — this is the default behavior for supported models.

**If your gateway requires a specific prefixed model ID**, you can force that exact ID by including the recognized prefix yourself:

```json
{
  "model": "amazon-bedrock/us.anthropic.claude-sonnet-4-6-v1"
}
```

When the model ID already starts with a recognized prefix (`us.`, `eu.`, `global.`, `jp.`, `apac.`, `au.`), auto-prefixing is skipped and the ID is passed through as-is. Note that this does **not** strip the prefix — the full prefixed ID is what gets sent to the gateway.

!!! warning
    There is currently no config option to disable auto-prefixing entirely. If your gateway requires bare (unprefixed) model IDs and the model would normally be prefixed, contact your platform team or open an issue.

## Troubleshooting

### Verify credentials and config

```bash
altimate-code providers list
```

This shows all stored credentials and active environment variables. You should see `Amazon Bedrock` listed under credentials or environment.

### Check config resolution

Look for these lines in the logs (`~/.local/share/altimate-code/log/*.log`):

| Log line | Meaning |
|----------|---------|
| `service=config loading config from ...altimate-code.json` | Config file is being read |
| `service=provider providerID=amazon-bedrock found` | Provider detected successfully |
| `service=provider providerID=amazon-bedrock` + error | Auth or endpoint failure |

### Enable debug logging

For detailed output including credential chain steps and SDK-level request info:

```bash
altimate-code --log-level DEBUG
```

## Full config reference

```json
{
  "model": "amazon-bedrock/anthropic.claude-sonnet-4-6-v1",
  "provider": {
    "amazon-bedrock": {
      "options": {
        "baseURL": "https://your-gateway.example.com/bedrock/v1",
        "region": "us-east-1",
        "profile": "my-aws-profile"
      }
    }
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `baseURL` | `string` | Custom API gateway URL. Overrides the default Bedrock endpoint. |
| `endpoint` | `string` | Alias for `baseURL`. If both are set, `endpoint` takes precedence. |
| `region` | `string` | AWS region. Falls back to `AWS_REGION` env var, then `us-east-1`. |
| `profile` | `string` | AWS named profile. Falls back to `AWS_PROFILE` env var. |
