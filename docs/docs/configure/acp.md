# ACP Support

altimate-code implements the Agent Communication Protocol (ACP), allowing it to act as a backend for editors and IDEs.

## Usage

```bash
altimate-code acp
```

This starts altimate-code in ACP mode, ready to accept connections from compatible editors.

## Editor Configuration

### Zed

Add to your Zed settings:

```json
{
  "language_models": {
    "altimate-code": {
      "command": ["altimate-code", "acp"]
    }
  }
}
```

### JetBrains IDEs

Configure altimate-code as an external AI provider in your JetBrains IDE settings.

### Neovim

Use an ACP-compatible Neovim plugin to connect to altimate-code:

```lua
require("acp").setup({
  command = { "altimate-code", "acp" }
})
```

## Features

ACP mode provides:

- Model access through your configured providers
- Tool execution (file operations, search, shell commands)
- Agent selection and switching
- Full data engineering tool access
