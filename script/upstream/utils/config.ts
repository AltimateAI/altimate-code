// Configuration for upstream merge automation.
// All branding/renaming rules live here as code rather than JSON
// for easier maintenance, type safety, and inline documentation.

import path from "path"
import { fileURLToPath } from "url"

export interface StringReplacement {
  pattern: RegExp
  replacement: string
  description: string
}

export interface MergeConfig {
  upstreamRemote: string
  upstreamRepo: string
  originRepo: string
  baseBranch: string
  changeMarker: string

  /** Glob patterns of files to keep as-is (never overwrite with upstream). */
  keepOurs: string[]

  /** Glob patterns of upstream files to discard entirely. */
  skipFiles: string[]

  /** All branding replacement rules, ordered by specificity (most specific first). */
  brandingRules: StringReplacement[]

  /** Lines containing any of these strings skip product-name transforms. */
  preservePatterns: string[]

  /** Only files with these extensions are eligible for text transforms. */
  transformableExtensions: string[]

  /** Product name replacements (standalone words in prose/UI text). */
  productNameRules: StringReplacement[]

  /** npm/bun install command replacements. */
  npmInstallRules: StringReplacement[]

  /** CLI binary name replacements (user-facing docs only). */
  cliBinaryRules: StringReplacement[]
}

// ---------------------------------------------------------------------------
// Branding rules — ordered from most specific to least specific so that
// narrower patterns match before broader ones consume the substring.
// ---------------------------------------------------------------------------

const urlRules: StringReplacement[] = [
  {
    pattern: /auth\.dev\.opencode\.ai/g,
    replacement: "auth.dev.altimate.ai",
    description: "Auth dev subdomain",
  },
  {
    pattern: /enterprise\.opencode\.ai/g,
    replacement: "enterprise.altimate.ai",
    description: "Enterprise subdomain",
  },
  {
    pattern: /docs\.opencode\.ai/g,
    replacement: "docs.altimate.ai",
    description: "Docs subdomain",
  },
  {
    pattern: /api\.opencode\.ai/g,
    replacement: "api.altimate.ai",
    description: "API subdomain",
  },
  {
    pattern: /dev\.opencode\.ai/g,
    replacement: "dev.altimate.ai",
    description: "Dev subdomain",
  },
  {
    pattern: /opencode\.ai/g,
    replacement: "altimate.ai",
    description: "Root domain",
  },
  {
    pattern: /opncd\.ai/g,
    replacement: "altimate.ai",
    description: "Short domain alias",
  },
]

const githubRules: StringReplacement[] = [
  {
    pattern: /anomalyco\/opencode-beta/g,
    replacement: "AltimateAI/altimate-code-beta",
    description: "Beta repo",
  },
  {
    pattern: /anomalyco\/tap\/opencode/g,
    replacement: "AltimateAI/tap/altimate-code",
    description: "Homebrew tap",
  },
  {
    pattern: /anomalyco\/zed-extensions/g,
    replacement: "AltimateAI/zed-extensions",
    description: "Zed extensions repo",
  },
  {
    pattern: /anomalyco\/opencode/g,
    replacement: "AltimateAI/altimate-code",
    description: "Main repo",
  },
]

const registryRules: StringReplacement[] = [
  {
    pattern: /ghcr\.io\/anomalyco/g,
    replacement: "ghcr.io/AltimateAI",
    description: "Container registry org",
  },
]

const emailRules: StringReplacement[] = [
  {
    pattern: /opencode@sst\.dev/g,
    replacement: "dev@altimate.ai",
    description: "SST dev email",
  },
  {
    pattern: /bot@opencode\.ai/g,
    replacement: "bot@altimate.ai",
    description: "Bot email",
  },
]

const appIdRules: StringReplacement[] = [
  {
    pattern: /ai\.opencode\.desktop\.dev/g,
    replacement: "ai.altimate.code.desktop.dev",
    description: "Desktop app ID (dev)",
  },
  {
    pattern: /ai\.opencode\.desktop\.beta/g,
    replacement: "ai.altimate.code.desktop.beta",
    description: "Desktop app ID (beta)",
  },
  {
    pattern: /ai\.opencode\.desktop/g,
    replacement: "ai.altimate.code.desktop",
    description: "Desktop app ID",
  },
  {
    pattern: /ai\.opencode\.opencode/g,
    replacement: "ai.altimate.code",
    description: "Generic app ID",
  },
]

const socialRules: StringReplacement[] = [
  {
    pattern: /x\.com\/altaborodin/g,
    replacement: "x.com/Altimateinc",
    description: "Twitter/X handle",
  },
]

const productNameRules: StringReplacement[] = [
  {
    pattern: /OpenCode Desktop/g,
    replacement: "Altimate Code Desktop",
    description: "Product name: Desktop",
  },
  {
    pattern: /OpenCode Beta/g,
    replacement: "Altimate Code Beta",
    description: "Product name: Beta",
  },
  {
    pattern: /OpenCode Dev/g,
    replacement: "Altimate Code Dev",
    description: "Product name: Dev",
  },
  {
    pattern: /OpenCode Zen/g,
    replacement: "Altimate Code Zen",
    description: "Product name: Zen",
  },
  {
    pattern: /OpenCode Go/g,
    replacement: "Altimate Code Go",
    description: "Product name: Go",
  },
  {
    // Standalone "OpenCode" — word boundary ensures we don't match inside
    // compound identifiers like "opencode-ai" or "@opencode-ai/cli".
    pattern: /\bOpenCode\b/g,
    replacement: "Altimate Code",
    description: "Product name: generic",
  },
]

const npmInstallRules: StringReplacement[] = [
  {
    pattern: /bun i -g opencode-ai/g,
    replacement: "bun i -g altimate-code",
    description: "bun global install",
  },
  {
    pattern: /npm install -g opencode-ai/g,
    replacement: "npm install -g altimate-code",
    description: "npm global install",
  },
  {
    pattern: /npm i -g opencode-ai/g,
    replacement: "npm i -g altimate-code",
    description: "npm short global install",
  },
  {
    pattern: /npx opencode-ai/g,
    replacement: "npx altimate-code",
    description: "npx invocation",
  },
]

const cliBinaryRules: StringReplacement[] = [
  {
    pattern: /brew install anomalyco\/tap\/opencode/g,
    replacement: "brew install AltimateAI/tap/altimate-code",
    description: "Homebrew install command",
  },
  {
    pattern: /paru -S opencode/g,
    replacement: "paru -S altimate-code",
    description: "Arch Linux install command",
  },
]

// ---------------------------------------------------------------------------
// Full default configuration
// ---------------------------------------------------------------------------

export const defaultConfig: MergeConfig = {
  upstreamRemote: "upstream",
  upstreamRepo: "anomalyco/opencode",
  originRepo: "AltimateAI/altimate-code",
  baseBranch: "main",
  changeMarker: "altimate_change",

  keepOurs: [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "RELEASING.md",
    "CHANGELOG.md",
    ".github/workflows/**",
    ".github/actions/**",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/**",
    "github/action.yml",
    "github/README.md",
    "github/index.ts",
    "install",
    "packages/altimate-engine/**",
    "packages/opencode/src/altimate/**",
    "packages/opencode/src/bridge/**",
    // Build and publish scripts have critical branding (binary name, user-agent,
    // engine version embedding, archive naming, altimate-code symlink)
    "packages/opencode/script/build.ts",
    "packages/opencode/script/publish.ts",
    "packages/opencode/script/bump-version.ts",
    // Bin wrappers are Altimate-branded
    "packages/opencode/bin/**",
    "experiments/**",
    "docs/**",
    ".claude/**",
    "sdks/**",
    "script/upstream/**",
  ],

  skipFiles: [
    // Hosted platform packages (not needed for CLI)
    "packages/app/**",
    "packages/console/**",
    "packages/containers/**",
    "packages/desktop/**",
    "packages/desktop-electron/**",
    "packages/docs/**",
    "packages/enterprise/**",
    "packages/extensions/**",
    "packages/function/**",
    "packages/identity/**",
    "packages/slack/**",
    "packages/storybook/**",
    "packages/ui/**",
    "packages/web/**",
    // Nix packaging
    "nix/**",
    "flake.nix",
    "flake.lock",
    // SST infrastructure
    "infra/**",
    "sst.config.ts",
    "sst-env.d.ts",
    // Upstream project specs
    "specs/**",
    // Translated READMEs
    "README.*.md",
    // Translation glossaries (we don't ship translations)
    ".opencode/glossary/**",
    ".opencode/agent/translator.md",
    // Upstream project-specific dev tools and agents
    ".opencode/tool/github-triage.ts",
    ".opencode/tool/github-triage.txt",
    ".opencode/tool/github-pr-search.txt",
    ".opencode/tool/github-pr-search.ts",
    ".opencode/agent/duplicate-pr.md",
    ".opencode/agent/triage.md",
    ".opencode/agent/docs.md",
    ".opencode/themes/mytheme.json",
    ".opencode/env.d.ts",
    ".opencode/command/rmslop.md",
    ".opencode/command/ai-deps.md",
    ".opencode/command/spellcheck.md",
    // Storybook CI (packages/storybook and packages/ui are deleted)
    ".github/workflows/storybook.yml",
    // Upstream Zed extension sync (no workflow references it)
    "script/sync-zed.ts",
    // Upstream AGENTS.md references dev branch, misleading for our fork
    "AGENTS.md",
  ],

  brandingRules: [
    ...urlRules,
    ...githubRules,
    ...registryRules,
    ...emailRules,
    ...appIdRules,
    ...socialRules,
    ...productNameRules,
    ...npmInstallRules,
    ...cliBinaryRules,
  ],

  preservePatterns: [
    "@opencode-ai/",
    "packages/opencode",
    "OPENCODE_",
    ".opencode/",
    '.opencode"',
    "opencode.json",
    "opencode.jsonc",
    "window.__OPENCODE__",
    "Flag.OPENCODE_",
    'pname = "opencode"',
    "inherit (opencode)",
    "callPackage ./",
    'from "@opencode-ai',
    'require("@opencode-ai',
    "import { ",
  ],

  transformableExtensions: [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".jsonc",
    ".md",
    ".mdx",
    ".txt",
    ".yml",
    ".yaml",
    ".toml",
    ".xml",
    ".html",
    ".css",
    ".sh",
    ".rs",
    ".nix",
    ".plist",
  ],

  productNameRules,
  npmInstallRules,
  cliBinaryRules,
}

/**
 * Load the merge configuration.
 * Currently returns the built-in defaults. In the future this could
 * merge overrides from a local file or environment variables.
 */
export function loadConfig(): MergeConfig {
  return { ...defaultConfig }
}

/**
 * Resolve the repository root directory.
 * This file lives at script/upstream/utils/config.ts, so root is three levels up.
 */
export function repoRoot(): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  return path.resolve(__dirname, "..", "..", "..")
}
