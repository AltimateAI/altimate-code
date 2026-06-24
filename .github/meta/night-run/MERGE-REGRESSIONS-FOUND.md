# v1.17.9 Merge Regressions Found (Pillar 1: "was it merged right?")
Discovered by the upstream merge-correctness pass (test/upstream invariants). All FIXED in src unless noted.

## REAL regressions the v1.17.9 merge silently introduced (fixed):
1. **System prompts re-leaked upstream branding** — src/session/prompt/{default,codex,gpt,kimi}.txt reverted to
   "You are OpenCode" / github.com/anomalyco/opencode / opencode.ai. HIGHEST blast radius (sent to LLM every turn).
   Fixed -> "Altimate Code" / AltimateAI/altimate-code / altimate.ai.
2. **33 theme schema URLs** (packages/tui/src/theme/assets/*.json) reset to opencode.ai/theme.json. Fixed -> altimate.ai.
3. **21 httpapi OpenAPI descriptions** (src/server/routes/instance/httpapi/groups/*.ts) re-leaked "OpenCode" (root cause
   of many generated-SDK leaks). Fixed (strings only).
4. **20 TUI brand strings** (app.tsx title, dialog upsells/domains, tips, parsers-config, attention, permission). Fixed.
5. **`mcp add --name` non-interactive flag DROPPED** (src/cli/cmd/mcp.ts) — merge replaced fork's --name flag with a
   positional, breaking scripted MCP-add (2nd time per in-code history). Restored.
6. **anthropic login hint dropped** (src/cli/cmd/providers.ts) — restored `anthropic: "API key"`.
7. Plugin OAuth callback HTML titles + various CLI strings re-leaked OpenCode. Fixed.

## Real regression flagged for ARCHITECTURAL follow-up (.todo, not a 1-line fix):
8. **Duplicate `@opencode/Account` Effect Service identifier** — registered in BOTH src/account/account.ts AND
   src/account/index.ts -> shares one Layer slot (split-brain risk). Needs disambiguation or deleting stale index.ts
   variant + repointing its 2 importers. (Same class of bug as the auth/index vs auth/service dedup already handled.)

## Remaining branding leaks (out of shipped-src scope; .todo):
- ~107 in TEST fixtures (not shipped; mostly opencode.ai/config.json $schema fixtures).
- ~44 in GENERATED SDK artifacts (packages/sdk/.../gen/**, openapi.json) — need REGEN from rebranded descriptions, not hand-edit.
- ~11 deliberate User-Agent: opencode/${VERSION} provider headers (intentional compat).
- ~9 in packages/core/src/public/opencode.ts (intentional public Effect API class named OpenCode).

## Carry-forward features VERIFIED intact (merge preserved them; stale tests repointed):
build->builder alias, pluginSpecifier/pluginOptions/PluginSpec (moved config/plugin.ts), escapeHtml XSS guard (moved
@/util/html, still wraps every error interpolation — no XSS regression), Auth identifier dedup, logo brand colors,
variant_list keybind, SyncEvent->BusEvent bridge.
