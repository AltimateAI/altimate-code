# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Instead, please report them via email to **security@altimate.ai**.

### What to include

- A description of the vulnerability
- Steps to reproduce the issue
- Any relevant logs or screenshots
- Your assessment of the severity

### What to expect

- **Acknowledgment**: Within 48 hours of your report
- **Initial assessment**: Within 7 business days
- **Resolution timeline**: Depends on severity, but we aim to resolve critical issues within 30 days

### Credit

We appreciate the efforts of security researchers. With your consent, we will credit you in the release notes when the vulnerability is fixed.

## Scope

This policy applies to:

- The `altimate-code` CLI (`@altimateai/altimate-code`)
- The `altimate-engine` Python package
- The `@altimateai/altimate-code-sdk` and `@altimateai/altimate-code-plugin` packages
- Official Docker images

## Best Practices

- Always use the latest version of altimate-code
- Do not store credentials in plain text; use environment variables or secure credential stores
- Review warehouse connection configurations for least-privilege access
