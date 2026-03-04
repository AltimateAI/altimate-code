# LSP Servers

altimate integrates with Language Server Protocol (LSP) servers for diagnostics, completions, and code intelligence.

## Built-in Servers

| Server | Languages | Auto-install | Root Detection |
|--------|-----------|-------------|----------------|
| **TypeScript** | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | Yes | `package-lock.json`, `bun.lock`, `yarn.lock` |
| **Deno** | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` | Yes | `deno.json`, `deno.jsonc` |
| **Vue** | `.vue` | Yes | `package-lock.json`, `bun.lock` |
| **ESLint** | `.ts`, `.tsx`, `.js`, `.jsx`, `.vue` | Yes | `package-lock.json`, `bun.lock` |
| **Oxlint** | `.ts`, `.js`, `.json`, `.css`, `.html`, `.vue` | Yes | `.oxlintrc.json`, `package.json` |
| **Biome** | `.ts`, `.js`, `.json`, `.vue`, `.css`, `.html` | Yes | `biome.json`, `biome.jsonc` |
| **Gopls** | `.go` | Yes | `go.mod`, `go.sum` |
| **Ruby-LSP** | `.rb`, `.rake`, `.gemspec` | Yes | `Gemfile` |
| **Pyright** | `.py`, `.pyi` | Yes | `pyproject.toml`, `setup.py` |
| **Ty** | `.py`, `.pyi` | No (experimental) | `pyproject.toml`, `setup.py` |
| **Elixir-LS** | `.ex`, `.exs` | Yes | `mix.exs` |
| **ZLS** | `.zig`, `.zon` | Yes | `build.zig` |
| **C#** | `.cs` | Yes | `.sln`, `.csproj` |
| **F#** | `.fs`, `.fsi`, `.fsx` | Yes | `.sln`, `.fsproj` |

## Configuration

### Disable All LSP

```json
{
  "lsp": false
}
```

### Disable a Specific Server

```json
{
  "lsp": {
    "eslint": {
      "disabled": true
    }
  }
}
```

### Custom Server

```json
{
  "lsp": {
    "my-lsp": {
      "command": ["my-language-server", "--stdio"],
      "extensions": [".myext"],
      "env": {
        "MY_LSP_LOG": "debug"
      },
      "initialization": {
        "customSetting": true
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string[]` | Command to start the LSP server |
| `extensions` | `string[]` | File extensions (required for custom servers) |
| `disabled` | `boolean` | Disable this server |
| `env` | `object` | Environment variables |
| `initialization` | `object` | LSP initialization options |

## Auto-Install

LSP servers are automatically downloaded when needed. Disable with:

```bash
export ALTIMATE_CLI_DISABLE_LSP_DOWNLOAD=true
```

## Experimental Servers

Enable experimental LSP servers:

```bash
export ALTIMATE_CLI_EXPERIMENTAL_LSP_TY=true    # Ty (Python)
export ALTIMATE_CLI_EXPERIMENTAL_LSP_TOOL=true   # LSP as tool
```
