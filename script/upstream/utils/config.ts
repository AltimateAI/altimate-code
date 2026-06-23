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

  /**
   * Glob patterns of files that historically hold altimate behavioral patches
   * (UA strings, retry loops, hour-aligned cleanup tasks, etc.) without
   * `altimate_change` markers. The bridge merge tool MUST flag these for human
   * review whenever it takes upstream content for them — even if the file
   * has no markers — because the absence of markers does not mean "safe to
   * overwrite", just "we forgot to mark our patches".
   *
   * Use `bun run script/upstream/analyze.ts --require-markers --strict` to
   * confirm every file in this list actually has at least one altimate_change
   * block; CI rejects any file in the list that lost all its markers.
   */
  requireMarkers: string[]

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

// Desktop deep-link URL scheme. Upstream registers `opencode://` (used for
// `opencode://open-project?directory=...`). We rebrand to `altimate://`.
// NOTE: the internal Tauri IPC event name "opencode:deep-link" is lowercase and
// NOT a URL scheme — it stays as-is (no "//" so these rules don't touch it).
const schemeRules: StringReplacement[] = [
  {
    pattern: /opencode:\/\//g,
    replacement: "altimate://",
    description: "Deep-link URL scheme",
  },
  {
    pattern: /"schemes":\s*\["opencode"\]/g,
    replacement: '"schemes": ["altimate"]',
    description: "Tauri deep-link scheme registration",
  },
]

// Desktop Tauri Rust crate names. Not user-facing, but renamed for a fully
// leak-free build (log filenames, EnvFilter targets). These are NOT covered by
// the OpenCode product-name rule (lowercase, with suffixes), so they need
// dedicated rules to survive future merges. Order longest-first.
const crateRules: StringReplacement[] = [
  {
    pattern: /opencode-desktop/g,
    replacement: "altimate-code-desktop",
    description: "Desktop Cargo package / log filename",
  },
  {
    pattern: /opencode_desktop/g,
    replacement: "altimate_code_desktop",
    description: "Desktop bin crate (EnvFilter target)",
  },
  {
    pattern: /opencode_lib/g,
    replacement: "altimate_code_lib",
    description: "Desktop lib crate name",
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
    "packages/drivers/**",
    "packages/opencode/src/altimate/**",
    "packages/opencode/src/bridge/**",
    // Memory tools are net-new altimate features (altimate_memory_* tool family)
    "packages/opencode/src/memory/**",
    "packages/opencode/test/altimate/**",
    // Build and publish scripts have critical branding (binary name, user-agent,
    // engine version embedding, archive naming, altimate-code symlink)
    "packages/opencode/script/build.ts",
    "packages/opencode/script/publish.ts",
    "packages/opencode/script/bump-version.ts",
    // postinstall copies builtin skills to ~/.altimate/builtin/ — our addition
    "packages/opencode/script/postinstall.mjs",
    // Builtin skills shipped to customers — fully owned by Altimate
    ".opencode/skills/**",
    // Bin wrappers are Altimate-branded
    "packages/opencode/bin/**",
    "experiments/**",
    "docs/**",
    ".claude/**",
    "sdks/**",
    "script/upstream/**",
    // Catppuccin theme files — JSON can't carry inline altimate_change markers, so
    // we lock them via keepOurs. The textMuted value is a deliberate a11y choice
    // (Subtext1 vs upstream's darker Overlay2). The other Catppuccin variants
    // share the same convention for consistency.
    "packages/opencode/src/cli/cmd/tui/context/theme/catppuccin.json",
    "packages/opencode/src/cli/cmd/tui/context/theme/catppuccin-frappe.json",
    "packages/opencode/src/cli/cmd/tui/context/theme/catppuccin-macchiato.json",
    // Test files that intentionally reference upstream branding —
    // either testing upstream API/release fetches, or asserting that
    // branding strings DON'T leak into shipped source. Excluding from
    // the branding scan prevents false positives.
    "packages/opencode/test/upstream/**",
    "packages/opencode/test/branding/**",
    // External-API fixture (models.dev response) — keeps real product
    // names like "OpenCode Zen" because that's what the real API returns.
    "packages/opencode/test/tool/fixtures/models-api.json",
    // Transient commit message / PR body files — intentionally quote
    // upstream brand strings when describing rebrand fixes. See CLAUDE.md
    // commit workflow conventions.
    ".github/meta/**",
    // --- Desktop app (adopted from upstream v1.2.20) — files we fully own ---
    // Tauri configs carry OUR updater signing pubkey + AltimateAI release
    // endpoints + rebranded identifiers/productName. Never take upstream's.
    "packages/desktop/src-tauri/tauri.conf.json",
    "packages/desktop/src-tauri/tauri.beta.conf.json",
    "packages/desktop/src-tauri/tauri.prod.conf.json",
    // Brand binary assets (cannot carry text markers) + rebranded AppStream.
    "packages/desktop/src-tauri/icons/**",
    "packages/desktop/src-tauri/assets/**",
    "packages/desktop/src-tauri/release/appstream.metainfo.xml",
    // Sidecar build/copy scripts adapted to our binary naming + CI artifact contract.
    "packages/desktop/scripts/utils.ts",
    "packages/desktop/scripts/predev.ts",
    "packages/desktop/scripts/prepare.ts",
    "packages/desktop/scripts/copy-bundles.ts",
    "packages/desktop/scripts/finalize-latest-json.ts",
    // Web UI brand assets (favicons, social share, PWA icons, manifest).
    "packages/app/public/favicon*",
    "packages/app/public/apple-touch-icon*",
    "packages/app/public/web-app-manifest*",
    "packages/app/public/social-share*",
    "packages/ui/src/assets/favicon/**",
    "packages/ui/src/assets/images/social-share*",
  ],

  // Files with altimate behavioral patches that MUST be marked + reviewed on
  // every upstream merge. The v1.4.0 bridge silently overwrote these because
  // they had no markers; the patches were re-applied in commit 3a6b59bdea and
  // wrapped in altimate_change blocks. This list is the regression backstop —
  // CI fails if any file here loses all its markers, and the bridge tool flags
  // any change to these for human review.
  requireMarkers: [
    // CLI commands with altimate-branded describe/log strings + behavior
    "packages/opencode/src/cli/cmd/serve.ts",
    "packages/opencode/src/cli/cmd/web.ts",
    "packages/opencode/src/cli/cmd/uninstall.ts",
    "packages/opencode/src/cli/cmd/pr.ts",
    "packages/opencode/src/cli/cmd/mcp.ts",
    "packages/opencode/src/cli/cmd/github.ts",
    "packages/opencode/src/cli/cmd/upgrade.ts",
    "packages/opencode/src/cli/cmd/tui/attach.ts",
    "packages/opencode/src/cli/cmd/tui/component/upgrade-indicator.tsx",
    "packages/opencode/src/cli/error.ts",
    "packages/opencode/src/cli/ui.ts",
    "packages/opencode/src/cli/network.ts",
    // TUI components with brand strings or Log.Default usage
    "packages/opencode/src/cli/cmd/tui/component/dialog-status.tsx",
    "packages/opencode/src/cli/cmd/tui/component/dialog-mcp.tsx",
    "packages/opencode/src/cli/cmd/tui/component/dialog-workspace-list.tsx",
    "packages/opencode/src/cli/cmd/tui/component/error-component.tsx",
    "packages/opencode/src/cli/cmd/tui/component/logo.tsx",
    "packages/opencode/src/cli/cmd/tui/util/clipboard.ts",
    "packages/opencode/src/cli/cmd/tui/context/route.tsx",
    // (Catppuccin a11y tweaks live in keepOurs — JSON can't carry markers.)
    // HTTP routes that must call PermissionNext (split-brain regression)
    "packages/opencode/src/server/routes/permission.ts",
    "packages/opencode/src/server/routes/session.ts",
    "packages/opencode/src/server/routes/global.ts",
    "packages/opencode/src/server/instance.ts",
    // OAuth client + TUI schema URLs (point at altimate.ai not opencode.ai)
    "packages/opencode/src/mcp/oauth-provider.ts",
    "packages/opencode/src/mcp/config.ts",
    "packages/opencode/src/config/migrate-tui-config.ts",
    "packages/opencode/src/config/tui-migrate.ts",
    // Workspace router middleware uses target() not fetch() — drift breaks runtime
    "packages/opencode/src/control-plane/workspace-router-middleware.ts",
    "packages/opencode/src/control-plane/workspace.ts",
    // Plugin behavior patches (UA, OAuth retry, expiry skew, install dirs)
    "packages/opencode/src/plugin/codex.ts",
    "packages/opencode/src/plugin/copilot.ts",
    "packages/opencode/src/plugin/github-copilot/copilot.ts",
    "packages/opencode/src/plugin/install.ts",
    // Provider UA strings + bootstrap deferral
    "packages/opencode/src/provider/provider.ts",
    "packages/opencode/src/provider/models.ts",
    "packages/opencode/src/project/bootstrap.ts",
    // Session error display + LLM UA
    "packages/opencode/src/session/llm.ts",
    "packages/opencode/src/util/error.ts",
    // Desktop CLI: install dir/binary + WSL installer point at OUR altimate paths
    // (functional divergence, not just branding) — must keep altimate_change markers.
    "packages/desktop/src-tauri/src/cli.rs",
    // Desktop shell waits for OUR branded sqlite path (~/.local/share/altimate-code/
    // altimate-code.db), not upstream's opencode path — else the window hangs.
    "packages/desktop/src-tauri/src/lib.rs",
  ],

  skipFiles: [
    // NOTE: packages/app, packages/ui, packages/desktop, packages/desktop-electron
    // are NO LONGER skipped — we adopted the desktop app (Tauri primary + Electron
    // secondary) and its SolidJS web UI. Upstream changes to them flow through the
    // merge and get rebranded by the branding transforms; files we diverge on are
    // protected via altimate_change markers / keepOurs (see desktop entries below).
    // Hosted platform packages we still don't ship:
    "packages/console/**",
    "packages/containers/**",
    "packages/docs/**",
    "packages/enterprise/**",
    "packages/extensions/**",
    "packages/function/**",
    "packages/identity/**",
    "packages/slack/**",
    "packages/storybook/**",
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
    // Storybook CI (packages/storybook is not adopted; packages/ui now IS)
    ".github/workflows/storybook.yml",
    // Upstream Zed extension sync (no workflow references it)
    "script/sync-zed.ts",
    // Upstream AGENTS.md references dev branch, misleading for our fork
    "AGENTS.md",
    // Unused legacy Anthropic prompt variant — active prompt is anthropic.txt.
    // PR #18186 deleted this; we do not restore it. If upstream resurrects
    // this filename, skipFiles ensures the overlay drops it.
    "packages/opencode/src/session/prompt/anthropic-20250930.txt",
    // Upstream contributor-management metadata — not relevant to our fork.
    // We maintain our own TEAM_MEMBERS / pull_request_template.md (kept via
    // keepOurs above). These specific files are upstream-only and were
    // accidentally pulled in by the v1.4.0 bridge merge.
    ".github/CODEOWNERS",
    ".github/VOUCHED.td",
    // Upstream's GitHub-stars download tracker — we have our own analytics.
    "STATS.md",
    "script/stats.ts",
    // Upstream Zed editor settings — leaks editor preferences from upstream.
    ".zed/settings.json",
    // Upstream changelog command — we have our own bridge-merge / release process.
    ".opencode/command/changelog.md",
  ],

  brandingRules: [
    ...urlRules,
    ...githubRules,
    ...registryRules,
    ...emailRules,
    ...appIdRules,
    ...socialRules,
    ...schemeRules,
    ...crateRules,
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
    // External dependency hosted under anomalyco's org — no Altimate fork exists,
    // rebranding the source URL would break the install. Keep as-is.
    "anomalyco/ghostty-web",
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
