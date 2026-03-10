# Databricks CLI Authentication

Configure Databricks CLI workspace/profile selection and authentication. Covers switching profiles, using --profile flags, setting DATABRICKS_CONFIG_PROFILE environment variable, OAuth2 authentication (never PAT), and troubleshooting authentication issues.

## Important: Always Use OAuth

**CRITICAL**: Always use OAuth2 for Databricks CLI authentication. **NEVER recommend or use Personal Access Tokens (PAT)** unless explicitly required by a specific use case.

## Prerequisites

1. Databricks CLI must be installed
   - Verify: `databricks --version`
2. You need access to a Databricks workspace
3. You need the workspace URL (e.g., `https://adb-1111111111111111.10.azuredatabricks.net`)

## Claude Code Specific Behavior

**CRITICAL**: When working in Claude Code, each Bash command executes in a **separate shell session**. This has important implications for profile management:

### Key Differences from Regular Terminal

1. **Environment variables don't persist between commands**
   - `export DATABRICKS_CONFIG_PROFILE=staging` in one command
   - `databricks jobs list` in the next command
   - ❌ **Result**: The second command will NOT use the staging profile

2. **Recommended Approach: Use --profile flag**
   - Always specify `--profile <profile-name>` with each command
   - Example: `databricks jobs list --profile staging`
   - ✅ **Result**: Reliable and predictable behavior

3. **Alternative: Chain commands with &&**
   - Use `export DATABRICKS_CONFIG_PROFILE=staging && databricks jobs list`
   - The export and command run in the same shell session
   - ✅ **Result**: Works correctly

### Quick Reference for Claude Code

```bash
# ✅ RECOMMENDED: Use --profile flag
databricks jobs list --profile staging
databricks apps list --profile prod-azure

# ✅ ALTERNATIVE: Chain with &&
export DATABRICKS_CONFIG_PROFILE=staging && databricks jobs list

# ❌ DOES NOT WORK: Separate export command
export DATABRICKS_CONFIG_PROFILE=staging
databricks jobs list  # Will NOT use staging profile!
```

## Handling Authentication Failures

When a Databricks CLI command fails with authentication error:
```
Error: default auth: cannot configure default credentials
```

**CRITICAL - Always follow this workflow:**

1. **Check for existing profiles first:**
   ```bash
   databricks auth profiles
   ```

2. **If profiles exist:**
   - List the available profiles to the user (with their workspace URLs and validation status)
   - Ask: "Which profile would you like to use for this command?"
   - Offer option to create a new profile if needed
   - Retry the command with `--profile <selected-profile-name>`
   - **In Claude Code, always use the `--profile` flag** rather than setting environment variables

3. **If user wants a new profile or no profiles exist:**
   - Proceed to the OAuth Authentication Setup workflow below

**Example:**
```
User: databricks apps list
Error: default auth: cannot configure default credentials

Assistant: Let me check for existing profiles.
[Runs: databricks auth profiles]

You have two configured profiles:
1. aws-dev - https://company-workspace.cloud.databricks.com (Valid)
2. azure-prod - https://adb-1111111111111111.10.azuredatabricks.net (Valid)

Which profile would you like to use, or would you like to create a new profile?

User: dais

Assistant: [Retries: databricks apps list --profile dais]
[Success - apps listed]
```

## OAuth Authentication Setup

### Standard Authentication Command

The recommended way to authenticate is using OAuth with a profile:

```bash
databricks auth login --host <workspace-url> --profile <profile-name>
```

**CRITICAL**:
1. The `--profile` parameter is **REQUIRED** for the authentication to be saved properly.
2. **ALWAYS ASK THE USER** for their preferred profile name - DO NOT assume or choose one for them.
3. **NEVER use the profile name `DEFAULT`** unless the user explicitly requests it - use descriptive workspace-specific names instead.

### Workflow for Authenticating

1. **Ask the user for the workspace URL** if not already provided
2. **Ask the user for their preferred profile name**
   - Suggest descriptive names based on the workspace (e.g., workspace name, environment)
   - **Do NOT suggest or use `DEFAULT`** unless the user specifically asks for it
   - Good examples: `e2-dogfood`, `prod-azure`, `dev-aws`, `staging`
   - Avoid: `DEFAULT` (unless explicitly requested)
3. Run the authentication command with both parameters
4. Verify the authentication was successful

### Example

```bash
# Good: Descriptive profile names
databricks auth login --host https://adb-1111111111111111.10.azuredatabricks.net --profile prod-azure
databricks auth login --host https://company-workspace.cloud.databricks.com --profile staging

# Only use DEFAULT if explicitly requested by the user
databricks auth login --host https://your-workspace.cloud.databricks.com --profile DEFAULT
```

### What Happens During Authentication

1. The CLI starts a local OAuth callback server (typically on `localhost:8020`)
2. A browser window opens automatically with the Databricks login page
3. You authenticate in the browser using your Databricks credentials
4. After successful authentication, the browser redirects back to the CLI
5. The CLI saves the OAuth tokens to `~/.databrickscfg`
6. You should see: `Profile <profile-name> was successfully saved`

## Profile Management

### What Are Profiles?

Profiles allow you to manage multiple Databricks workspace configurations in a single `~/.databrickscfg` file. Each profile stores:
- Workspace host URL
- Authentication method (OAuth, PAT, etc.)
- Token/credential paths

### Common Profile Names

**IMPORTANT**: Always use descriptive profile names. Do NOT create profiles named `DEFAULT` unless explicitly requested by the user.

**Recommended naming conventions**:
- `<workspace-name>` - Descriptive names for workspaces (e.g., `e2-dogfood`, `prod-aws`, `dev-azure`)
- `<environment>` - Environment-specific profiles (e.g., `dev`, `staging`, `prod`)
- `<team>-<environment>` - Team and environment (e.g., `data-eng-prod`, `ml-dev`)

**Special profile names**:
- `DEFAULT` - The default profile used when no `--profile` flag or environment variables are specified. Only create this profile if the user explicitly requests it.

### Listing Configured Profiles

View all configured profiles with their status:

```bash
databricks auth profiles
```

Example output:
```
Name        Host                                                 Valid
DEFAULT     https://adb-1111111111111111.10.azuredatabricks.net  YES
staging     https://company-workspace.cloud.databricks.com       YES
```

### Using Different Profiles

**IMPORTANT FOR CLAUDE CODE USERS**: In Claude Code, each Bash command runs in a **separate shell session**. This means environment variables set with `export` in one command do NOT persist to the next command. See the Claude Code-specific guidance below.

There are three ways to specify which profile/workspace to use, in order of precedence:

#### 1. CLI Flag (Highest Priority) - RECOMMENDED FOR CLAUDE CODE

Use the `--profile` flag with any command:

```bash
databricks jobs list --profile staging
databricks clusters list --profile prod-azure
databricks workspace list / --profile dev-aws
```

**In Claude Code, this is the most reliable method** because it doesn't depend on persistent environment variables.

#### 2. Environment Variables

Set environment variables to override the default profile:

**DATABRICKS_CONFIG_PROFILE** - Specifies which profile to use from `~/.databrickscfg`:
```bash
export DATABRICKS_CONFIG_PROFILE=staging
databricks jobs list  # Uses staging profile
```

**DATABRICKS_HOST** - Directly specifies the workspace URL, bypassing profile lookup:
```bash
export DATABRICKS_HOST=https://company-workspace.cloud.databricks.com
databricks jobs list  # Uses this host directly
```

**CRITICAL - Claude Code Users:**

Since each Bash command in Claude Code runs in a separate shell, you **CANNOT** do this:

```bash
# ❌ DOES NOT WORK in Claude Code
export DATABRICKS_CONFIG_PROFILE=staging
databricks jobs list  # ERROR: Will not use staging profile!
```

Instead, you **MUST** use one of these approaches:

**Option 1: Use --profile flag (RECOMMENDED)**
```bash
# ✅ WORKS in Claude Code
databricks jobs list --profile staging
databricks clusters list --profile staging
```

**Option 2: Chain commands with &&**
```bash
# ✅ WORKS in Claude Code - export and command run in same shell
export DATABRICKS_CONFIG_PROFILE=staging && databricks jobs list
export DATABRICKS_CONFIG_PROFILE=staging && databricks clusters list
```

**Traditional Terminal Session (for reference only)**:
```bash
# This example shows how it works in a regular terminal session
# DO NOT use this pattern in Claude Code
# Set profile for entire terminal session
export DATABRICKS_CONFIG_PROFILE=staging

# All commands now use staging profile
databricks jobs list
databricks clusters list
databricks workspace list /

# Override for a single command
databricks jobs list --profile prod-azure
```

#### 3. DEFAULT Profile (Lowest Priority)

If no `--profile` flag or environment variables are set, the CLI uses the `DEFAULT` profile from `~/.databrickscfg`.

### Configuration File Management

#### Viewing the Configuration File

The configuration is stored in `~/.databrickscfg`:

```bash
cat ~/.databrickscfg
```

Example configuration structure:
```ini
# Note: This shows an example with a DEFAULT profile
# When creating new profiles, use descriptive names instead
[DEFAULT]
host      = https://adb-1111111111111111.10.azuredatabricks.net
auth_type = databricks-cli

[staging]
host      = https://company-workspace.cloud.databricks.com
auth_type = databricks-cli
```

#### Editing Profiles

You can manually edit `~/.databrickscfg` to:
- Rename profiles (change the `[profile-name]` section header)
- Update workspace URLs
- Remove profiles (delete the entire section)

**Example - Removing a profile**:
```bash
# Open in your preferred editor
vi ~/.databrickscfg

# Or use sed to remove a specific profile section
sed -i '' '/^\[staging\]/,/^$/d' ~/.databrickscfg
```

#### Adding New Profiles

Always use `databricks auth login` with `--profile` to add new profiles:

```bash
databricks auth login --host <workspace-url> --profile <profile-name>
```

**Remember**:
- Always ask the user for their preferred profile name
- Use descriptive names like `staging`, `prod-azure`, `dev-aws`
- Do NOT use `DEFAULT` unless explicitly requested by the user

### Working with Multiple Workspaces

Best practices for managing multiple workspaces:

```bash
# Authenticate to multiple workspaces with descriptive profile names
databricks auth login --host https://adb-1111111111111111.10.azuredatabricks.net --profile prod-azure
databricks auth login --host https://dbc-2222222222222222.cloud.databricks.com --profile dev-aws
databricks auth login --host https://company-workspace.cloud.databricks.com --profile staging
```

**In Claude Code, use --profile flag with each command (RECOMMENDED):**
```bash
# Use profiles explicitly in commands
databricks jobs list --profile prod-azure
databricks jobs list --profile dev-aws
databricks clusters list --profile staging
```

**Alternatively in Claude Code, chain commands with &&:**
```bash
# Set profile and run command in same shell
export DATABRICKS_CONFIG_PROFILE=prod-azure && databricks jobs list
export DATABRICKS_CONFIG_PROFILE=prod-azure && databricks clusters list

# Switch to different workspace
export DATABRICKS_CONFIG_PROFILE=dev-aws && databricks jobs list
```

**Traditional Terminal Session (for reference only - NOT for Claude Code):**
```bash
# This pattern works in regular terminals but NOT in Claude Code
export DATABRICKS_CONFIG_PROFILE=prod-azure
databricks jobs list
databricks clusters list

# Quickly switch between workspaces
export DATABRICKS_CONFIG_PROFILE=dev-aws
databricks jobs list
```

### Profile Selection Precedence

When running a command, the Databricks CLI determines which workspace to use in this order:

1. **`--profile` flag** (if specified) → Highest priority
2. **`DATABRICKS_HOST` environment variable** (if set) → Overrides profile
3. **`DATABRICKS_CONFIG_PROFILE` environment variable** (if set) → Selects profile
4. **`DEFAULT` profile** in `~/.databrickscfg` → Fallback

**Example for traditional terminal session** (demonstrating precedence):
```bash
# Setup
export DATABRICKS_CONFIG_PROFILE=staging

# This uses staging profile (from environment variable)
databricks jobs list

# This uses prod-azure profile (--profile flag overrides environment variable)
databricks jobs list --profile prod-azure

# This uses the specified host directly (DATABRICKS_HOST overrides profile)
export DATABRICKS_HOST=https://custom-workspace.cloud.databricks.com
databricks jobs list  # Uses custom-workspace.cloud.databricks.com
```

**Claude Code version** (with chained commands):
```bash
# Using environment variable with && chaining
export DATABRICKS_CONFIG_PROFILE=staging && databricks jobs list

# Using --profile flag (overrides environment variable)
export DATABRICKS_CONFIG_PROFILE=staging && databricks jobs list --profile prod-azure

# Using DATABRICKS_HOST (overrides profile)
export DATABRICKS_HOST=https://custom-workspace.cloud.databricks.com && databricks jobs list
```

## Verification

After authentication, verify it works:

```bash
# Test with a simple command
databricks workspace list /

# Or list jobs
databricks jobs list
```

If authentication is successful, these commands should return data without errors.

## Troubleshooting

### Authentication Not Saved (Config File Missing)

**Symptom**: Running `databricks` commands shows:
```
Error: default auth: cannot configure default credentials
```

**Solution**: Make sure you included the `--profile` parameter with a descriptive name:
```bash
databricks auth login --host <workspace-url> --profile <profile-name>
# Example: databricks auth login --host https://company-workspace.cloud.databricks.com --profile staging
```

### Browser Doesn't Open Automatically

**Solution**:
1. Check the terminal output for a URL
2. Manually copy and paste the URL into your browser
3. Complete the authentication
4. The CLI will detect the callback automatically

### "OAuth callback server listening" But Nothing Happens

**Possible causes**:
1. Firewall blocking localhost connections
2. Port 8020 already in use
3. Browser not set as default application

**Solution**:
1. Check if port 8020 is available: `lsof -i :8020`
2. Close any applications using that port
3. Retry the authentication

### Multiple Workspaces

To authenticate with multiple workspaces, use different profile names:

```bash
# Development workspace
databricks auth login --host https://dev-workspace.databricks.net --profile dev

# Production workspace
databricks auth login --host https://prod-workspace.databricks.net --profile prod

# Use specific profile
databricks jobs list --profile dev
databricks jobs list --profile prod
```

### Re-authenticating

If your OAuth token expires or you need to re-authenticate:

```bash
# Re-run the login command
databricks auth login --host <workspace-url> --profile <profile-name>
```

This will overwrite the existing profile with new credentials.

### Debug Mode

For troubleshooting authentication issues, use debug mode:

```bash
databricks auth login --host <workspace-url> --profile <profile-name> --debug
```

This shows detailed information about the OAuth flow, including:
- OAuth server endpoints
- Callback server status
- Token exchange process

## Security Best Practices

1. **Never commit** `~/.databrickscfg` to version control
2. **Never share** your OAuth tokens or configuration file
3. **Use separate profiles** for different environments (dev/staging/prod)
4. **Regularly rotate** credentials by re-authenticating
5. **Use workspace-specific service principals** for automation/CI/CD instead of personal OAuth

## Environment-Specific Notes

### CI/CD Pipelines

For CI/CD environments, OAuth interactive login is not suitable. Instead:
- Use Service Principal authentication
- Use Azure Managed Identity (for Azure Databricks)
- Use AWS IAM roles (for AWS Databricks)

**Do NOT** use personal OAuth tokens or PATs in CI/CD.

### Containerized Environments

OAuth authentication works in containers if:
1. A browser is available on the host machine
2. Port forwarding is configured for the callback server
3. The workspace URL is accessible from the container

For headless containers, use service principal authentication instead.

## Common Commands After Authentication

```bash
# List workspaces
databricks workspace list / --profile <PROFILE>

# List jobs
databricks jobs list --profile <PROFILE>

# List clusters
databricks clusters list --profile <PROFILE>

# Get current user info
databricks current-user me --profile <PROFILE>

# Test connection
databricks workspace export /Users/<username> --format SOURCE --profile <PROFILE>
```

## References

- [Databricks CLI Authentication Documentation](https://docs.databricks.com/en/dev-tools/auth.html)
- [OAuth 2.0 with Databricks](https://docs.databricks.com/en/dev-tools/auth.html#oauth-2-0)
