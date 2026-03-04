# ACP Support

altimate implements the Agent Communication Protocol (ACP), allowing it to act as a backend for editors and IDEs.

## Usage

```bash
altimate acp
```

This starts altimate in ACP mode, ready to accept connections from compatible editors.

## Editor Configuration

### Zed

Add to your Zed settings:

```json
{
  "language_models": {
    "altimate": {
      "command": ["altimate", "acp"]
    }
  }
}
```

### JetBrains IDEs

Configure altimate as an external AI provider in your JetBrains IDE settings.

### Neovim

Use an ACP-compatible Neovim plugin to connect to altimate:

```lua
require("acp").setup({
  command = { "altimate", "acp" }
})
```

## Features

ACP mode provides:

- Model access through your configured providers
- Tool execution (file operations, search, shell commands)
- Agent selection and switching
- Full data engineering tool access
