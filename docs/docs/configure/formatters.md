# Formatters

altimate auto-formats files after editing using language-specific formatters.

## How It Works

When a file is modified by an agent, altimate:

1. Detects the file extension
2. Finds a matching formatter
3. Checks if the formatter is available (binary in PATH or project dependency)
4. Runs the formatter on the modified file

## Supported Formatters

| Formatter | Extensions | Detection | Command |
|-----------|-----------|-----------|---------|
| **prettier** | `.js`, `.jsx`, `.ts`, `.tsx`, `.json`, `.yaml`, `.md` | `package.json` deps | `bun x prettier --write $FILE` |
| **biome** | `.ts`, `.js`, `.json`, `.css`, `.html` | `biome.json` | `bun x @biomejs/biome check --write $FILE` |
| **gofmt** | `.go` | `gofmt` in PATH | `gofmt -w $FILE` |
| **rustfmt** | `.rs` | `rustfmt` in PATH | `rustfmt $FILE` |
| **ruff** | `.py`, `.pyi` | `ruff` binary + config | `ruff format $FILE` |
| **clang-format** | `.c`, `.cpp`, `.h` | `.clang-format` file | `clang-format -i $FILE` |
| **ktlint** | `.kt`, `.kts` | `ktlint` in PATH | `ktlint -F $FILE` |
| **mix** | `.ex`, `.exs`, `.eex`, `.heex` | `mix` in PATH | `mix format $FILE` |
| **dart** | `.dart` | `dart` in PATH | `dart format $FILE` |
| **shfmt** | `.sh`, `.bash` | `shfmt` in PATH | `shfmt -w $FILE` |
| **terraform** | `.tf`, `.tfvars` | `terraform` in PATH | `terraform fmt $FILE` |
| **gleam** | `.gleam` | `gleam` in PATH | `gleam format $FILE` |
| **nixfmt** | `.nix` | `nixfmt` in PATH | `nixfmt $FILE` |
| **rubocop** | `.rb`, `.rake`, `.gemspec` | `rubocop` in PATH | `rubocop --autocorrect $FILE` |
| **standardrb** | `.rb`, `.rake`, `.gemspec` | `standardrb` in PATH | `standardrb --fix $FILE` |
| **pint** | `.php` | `composer.json` has `laravel/pint` | `./vendor/bin/pint $FILE` |
| **ormolu** | `.hs` | `ormolu` in PATH | `ormolu -i $FILE` |
| **cljfmt** | `.clj`, `.cljs`, `.cljc`, `.edn` | `cljfmt` in PATH | `cljfmt fix --quiet $FILE` |
| **ocamlformat** | `.ml`, `.mli` | `.ocamlformat` file | `ocamlformat -i $FILE` |
| **zig** | `.zig`, `.zon` | `zig` in PATH | `zig fmt $FILE` |
| **air** | `.R` | `air --help` output | `air format $FILE` |
| **latexindent** | `.tex` | `latexindent` in PATH | `latexindent -w -s $FILE` |
| **htmlbeautifier** | `.erb` | `htmlbeautifier` in PATH | `htmlbeautifier $FILE` |
| **dfmt** | `.d` | `dfmt` in PATH | `dfmt -i $FILE` |
| **uv** | `.py`, `.pyi` | `uv` binary (fallback) | `uv format -- $FILE` |

## Configuration

### Disable All Formatting

```json
{
  "formatter": false
}
```

### Disable a Specific Formatter

```json
{
  "formatter": {
    "prettier": {
      "disabled": true
    }
  }
}
```

### Custom Formatter Configuration

```json
{
  "formatter": {
    "prettier": {
      "command": ["npx", "prettier", "--write", "$FILE"],
      "extensions": [".ts", ".tsx", ".js"],
      "environment": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string[]` | Override the formatter command (`$FILE` is replaced) |
| `extensions` | `string[]` | Override file extensions |
| `environment` | `object` | Extra environment variables |
| `disabled` | `boolean` | Disable this formatter |
