# IDE

altimate-code integrates with VS Code and Cursor as an AI assistant.

!!! warning "Beta"
    IDE integration is currently in beta. Features may change.

## VS Code / Cursor

### Setup

1. Install the altimate-code extension from the marketplace
2. Ensure `altimate-code` is installed globally:
   ```bash
   npm install -g @altimateai/altimate-code
   ```
3. The extension will auto-detect the CLI

### Features

- Inline chat with altimate-code agents
- File context awareness from your editor
- Tool call results displayed inline
- Agent mode switching from the command palette

### Configuration

The extension uses your existing `altimate-code.json` config. No additional IDE configuration is required.
