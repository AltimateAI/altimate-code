#!/bin/bash
set -e

echo "=== Altimate Code: Codespace Setup ==="

# Configure git (required for tests)
git config --global user.name "${GITHUB_USER:-codespace}"
git config --global user.email "${GITHUB_USER:-codespace}@users.noreply.github.com"

# Install dependencies
echo "Installing dependencies with Bun..."
bun install

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Quick start:"
echo "  bun run build        # Build the CLI"
echo "  bun test             # Run tests"
echo "  bun turbo typecheck  # Type-check all packages"
echo ""
echo "To install altimate globally after building:"
echo "  bun link"
echo ""
