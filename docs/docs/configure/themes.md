# Themes

altimate-code includes 12+ built-in themes and supports custom themes.

## Switching Themes

- **TUI**: Press leader + `t` or use `/theme`
- **Config**: Set `"theme": "catppuccin"` in your config file

```json
{
  "theme": "catppuccin"
}
```

## Built-in Themes

| Theme | Description |
|-------|------------|
| `catppuccin` | Pastel colors on a dark background |
| `dracula` | Dark theme with vibrant colors |
| `gruvbox` | Retro groove colors |
| `monokai` | Classic dark theme |
| `nord` | Arctic-inspired colors |
| `one-dark` | Atom-inspired dark theme |
| `solarized-dark` | Solarized dark variant |
| `solarized-light` | Solarized light variant |
| `tokyo-night` | Tokyo Night color scheme |
| `rose-pine` | Soho vibes |
| `kanagawa` | Inspired by Katsushika Hokusai |

## Custom Themes

Create a custom theme JSON file and reference it by name:

```json
{
  "theme": "my-theme"
}
```

Custom themes define colors for UI elements including:

- Primary, secondary, and accent colors
- Background and foreground
- Success, warning, and error states
- Diff added/removed highlights
- Agent colors

### Theme File Location

Place custom themes in one of these directories:

| Location | Scope |
|----------|-------|
| `~/.config/altimate-code/themes/` | Available in all projects |
| `.altimate-code/themes/` | Project-specific |

!!! tip
    Name your theme file `my-theme.json` and set `"theme": "my-theme"` in your config. altimate-code will find it automatically in the theme directories.
