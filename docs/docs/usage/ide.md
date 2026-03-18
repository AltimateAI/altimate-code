# IDE

altimate integrates with VS Code and Cursor as an AI assistant.

!!! warning "Beta"
    IDE integration is currently in beta. Features may change.

## VS Code / Cursor

### Setup

1. Install the altimate extension from the marketplace
2. Ensure `altimate` is installed globally:
   ```bash
   npm install -g altimate-code
   ```
3. The extension will auto-detect the CLI

### Features

- Inline chat with altimate agents
- File context awareness from your editor
- Tool call results displayed inline
- Agent mode switching from the command palette

### Configuration

The extension uses your existing `altimate-code.json` config. No additional IDE configuration is required.
