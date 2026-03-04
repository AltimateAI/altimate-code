# TUI

altimate-code launches a terminal-based user interface (TUI) by default.

```bash
altimate-code
```

## Interface Layout

The TUI has three main areas:

- **Message area** — shows the conversation with the AI assistant
- **Input area** — where you type messages and commands
- **Sidebar** — shows session info, tool calls, and file changes (toggle with leader key + `s`)

## Input Shortcuts

| Prefix | Action | Example |
|--------|--------|---------|
| `@` | Reference a file | `@src/models/user.sql explain this model` |
| `!` | Run a shell command | `!dbt run --select my_model` |
| `/` | Slash command | `/discover`, `/connect`, `/review`, `/models`, `/theme` |

## Leader Key

The leader key (default: `Ctrl+X`) gives access to all TUI keybindings. Press leader, then the action key:

| Key | Action |
|-----|--------|
| `n` | New session |
| `l` | List sessions |
| `e` | Open editor |
| `s` | Toggle sidebar |
| `t` | List themes |
| `m` | List models |
| `a` | List agents |
| `k` | List keybinds |
| `q` | Quit |

## Scrolling

- **Page up/down** — scroll messages
- **Home/End** — jump to first/last message
- **Mouse scroll** — scroll with mouse wheel

Configure scroll speed:

```json
{
  "tui": {
    "scroll_speed": 3,
    "scroll_acceleration": {
      "enabled": true
    }
  }
}
```

## Agent Switching

Switch between agents during a conversation:

- Press leader key + `a` to see all agents
- Use `/agent <name>` to switch directly
- Built-in agents: `general`, `plan`, `build`, `explore`
- Data engineering agents: `builder`, `analyst`, `validator`, `migrator`

## Diff Display

Configure how file diffs are displayed:

```json
{
  "tui": {
    "diff_style": "stacked"
  }
}
```

Options: `"auto"` (default) or `"stacked"`.

## Session Management

| Leader + Key | Action |
|-------------|--------|
| `n` | New session |
| `l` | Session list |
| `Shift+D` | Delete session |
| `Shift+R` | Rename session |
| `Shift+F` | Fork session |
| `Shift+E` | Export session |
| `Shift+C` | Compact session |

## Editor Integration

Press leader + `e` to open the current message in your `$EDITOR`. This is useful for composing long prompts or pasting multi-line SQL.
