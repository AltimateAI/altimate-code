# Keybinds

altimate supports 85+ customizable keybindings for the TUI.

## Leader Key

The leader key (default: `Ctrl+X`) is the prefix for most keybindings. Press the leader key first, then the action key.

Override it in your config:

```json
{
  "keybinds": {
    "leader": "ctrl+space"
  }
}
```

## Default Keybindings

### Session Management

| Keybind | Action |
|---------|--------|
| Leader + `n` | New session |
| Leader + `l` | List sessions |
| Leader + `Shift+D` | Delete session |
| Leader + `Shift+R` | Rename session |
| Leader + `Shift+F` | Fork session |
| Leader + `Shift+E` | Export session |
| Leader + `Shift+C` | Compact session |
| Leader + `Shift+S` | Share session |

### Navigation

| Keybind | Action |
|---------|--------|
| `Page Up` | Scroll messages up one page |
| `Page Down` | Scroll messages down one page |
| `Home` | Jump to first message |
| `End` | Jump to last message |
| `Ctrl+Up` | Previous message |
| `Ctrl+Down` | Next message |

### Models & Agents

| Keybind | Action |
|---------|--------|
| Leader + `m` | Model list |
| Leader + `Shift+M` | Model provider list |
| Leader + `a` | Agent list |
| Leader + `Tab` | Cycle agent |
| Leader + `Shift+Tab` | Cycle agent (reverse) |

### UI Toggles

| Keybind | Action |
|---------|--------|
| Leader + `s` | Toggle sidebar |
| Leader + `t` | Theme list |
| Leader + `k` | Keybind list |
| Leader + `e` | Open editor |
| Leader + `q` | Quit |

### Input Editing

| Keybind | Action |
|---------|--------|
| `Ctrl+A` | Move to beginning of line |
| `Ctrl+E` | Move to end of line |
| `Ctrl+W` | Delete word backward |
| `Ctrl+U` | Delete to beginning of line |
| `Ctrl+K` | Delete to end of line |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |

### Prompt

| Keybind | Action |
|---------|--------|
| Leader + `i` | Enhance prompt (AI-powered rewrite for clarity) |

### Other

| Keybind | Action |
|---------|--------|
| Leader + `/` | Command list |
| Leader + `Ctrl+C` | Interrupt session |
| Leader + `d` | Tool details |
| `Up` | Previous history |
| `Down` | Next history |

## Custom Keybindings

Override any keybinding in your config:

```json
{
  "keybinds": {
    "leader": "ctrl+space",
    "session_new": "ctrl+n",
    "sidebar_toggle": "ctrl+b",
    "theme_list": "ctrl+t"
  }
}
```

!!! tip
    Use `/keybinds` or leader + `k` in the TUI to see all current keybindings and their assigned keys.

## Full Keybind Reference

All configurable keybind identifiers:

### Session

`session_export`, `session_new`, `session_list`, `session_timeline`, `session_fork`, `session_rename`, `session_delete`, `session_child_cycle`, `session_parent`, `session_share`, `session_unshare`, `session_interrupt`, `session_compact`

### Messages

`messages_page_up`, `messages_page_down`, `messages_line_up`, `messages_line_down`, `messages_half_page_up`, `messages_half_page_down`, `messages_first`, `messages_last`, `messages_next`, `messages_previous`, `messages_copy`, `messages_undo`, `messages_redo`, `messages_toggle_conceal`

### Input

`input_move_left`, `input_move_right`, `input_move_up`, `input_move_down`, `input_undo`, `input_redo`

### UI

`leader`, `sidebar_toggle`, `scrollbar_toggle`, `username_toggle`, `theme_list`, `status_view`, `editor_open`, `app_exit`

### Models & Agents

`model_list`, `model_cycle_recent`, `model_cycle_favorite`, `model_favorite_toggle`, `model_provider_list`, `variant_cycle`, `agent_list`, `agent_cycle`, `agent_cycle_reverse`

### Misc

`tool_details`, `history_previous`, `history_next`, `command_list`, `terminal_suspend`, `terminal_title_toggle`, `display_thinking`, `tips_toggle`
