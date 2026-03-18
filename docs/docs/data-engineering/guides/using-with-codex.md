# Using altimate with Codex

altimate integrates with Codex in two ways: as an **LLM provider** (use your ChatGPT subscription to power altimate) and as a **Codex skill** (invoke altimate from within Codex CLI).

## Using altimate as a Codex CLI skill

You can delegate data engineering tasks from Codex CLI to altimate. Run `/configure-codex` inside altimate to set up the integration:

```
/configure-codex
```

This creates `~/.codex/skills/altimate/SKILL.md`. Restart Codex to pick up the new skill. Codex will then automatically invoke altimate when you ask about data engineering tasks like SQL analysis, lineage, dbt, or FinOps.

## Using Codex as an LLM provider

If you have a ChatGPT Plus or Pro subscription, you can use Codex as your LLM backend in altimate at no additional API cost. Your subscription covers all usage.

## Setup

### 1. Launch altimate

```bash
altimate
```

### 2. Run /connect

In the TUI, type `/connect` and select **Codex** as your provider.

### 3. Authenticate

A browser window opens for OAuth authentication with your ChatGPT account. Sign in and authorize altimate.

For headless environments (SSH, containers), a device code flow is available:

```
Visit: https://chatgpt.com/device
Enter code: ABCD-1234
```

### 4. Start using

Once authenticated, all altimate tools work with Codex as the LLM backend. No API keys needed.

## Available models

| Model | Best for |
|---|---|
| `gpt-5.2-codex` | General data engineering tasks |
| `gpt-5.1-codex-max` | Complex analysis, large context |
| `gpt-5.1-codex-mini` | Fast, lightweight tasks |
| `gpt-5.3-codex` | Latest capabilities |

## How it works

- altimate authenticates via PKCE OAuth flow with ChatGPT
- Requests route through `chatgpt.com/backend-api/codex/responses`
- Your subscription covers all token usage — no per-token billing
- Token is stored locally at `~/.altimate/data/auth.json`

## Cost

With Codex subscription:
- **LLM cost**: $0 (covered by subscription)
- **Warehouse cost**: Normal warehouse credits apply for SQL execution
- altimate helps minimize warehouse costs through cost prediction and optimization

## Comparison with API keys

| Aspect | Codex Subscription | API Key (Anthropic/OpenAI) |
|---|---|---|
| Monthly cost | $20-200/mo (subscription) | Pay per token |
| Setup | OAuth (browser login) | Copy-paste API key |
| Rate limits | Subscription limits | API limits |
| Model selection | Codex models only | Full model catalog |
| Best for | Individual developers | Teams, CI/CD |

## Troubleshooting

**"OAuth token expired"**
- Run `/connect` again to re-authenticate

**"Rate limit exceeded"**
- Codex subscription has usage limits. Wait a few minutes or upgrade your plan.

**"Codex not available"**
- Ensure you have an active ChatGPT Plus or Pro subscription
- Check that Codex is available in your region
