# Release-Evaluation Board — final pre-release analysis (PR #964, v1.17.9 bridge)
7 independent perspectives (3 codex / 3 sonnet / 1 haiku) + Fable runtime probe + synthesis.
GOAL: dual preservation — don't lose FORK work, don't lose UPSTREAM work.

## Scorecard

| Perspective | Verdict | Findings |
|---|---|---|
| D Fork-feature preservation | **PASS** | All tools (101→102 superset), 9 agents, 13 warehouse drivers, 7 builtin skills, 8 commands, memory/tracing/telemetry/PII — present + WIRED. 0 new fork drops. |
| F Safety/security regression | **PASS** | All 5 shipped safety properties INTACT: DDL non-overridable, subagent deny-inheritance (#26597), sensitive-write #209 guard (edit.ts+write.ts), secret redaction, basic-auth username. No regression. |
| A Upstream-fix adoption (73 sampled) | 5 dropped | 1 HIGH-ish (processor providerExecuted), 4 MED/LOW upstream fixes reverted. |
| B Upgrade/format compat | 2 real | managed-TUI-config load dropped (MED), .json/.jsonc precedence inverted (LOW). Auth-username & thinking-default changes INTENTIONAL. DB/auth/session/cache formats back-compatible. |
| C Build/packaging/distribution | **1 HIGH ship-blocker** | release.yml pinned Bun 1.3.10 but build scripts require ^1.3.14 → tag releases fail. FIXED. |
| E Integration seams | 1 real | Azure/DigitalOcean/xAI upstream auth plugins in-tree but unwired in INTERNAL_PLUGINS (MED). Codex plugin = intentional fork keep. |
| G Branding | LOW polish | `.opencode/` paths in warehouse-list/skill-ops messages + `opencode.json` in provider dialogs should say altimate-code. Provider labels & auth-username default = intentional. |
| Fable runtime probe | **PASS** | Compiled binary: palette, agent-switch, shell-mode EXECUTE, /skills list, prompt round-trip all work — empirically confirms the resolved V2-premise review comments don't affect the shipped product. |

## Actions taken (all upstream-fix restorations, marked + tested)
- FIXED (HIGH ship-blocker): release.yml Bun 1.3.10 → 1.3.14 (all 4 pins).
- FIXED (Fable): run.ts in-process auth header (local run 401'd when OPENCODE_SERVER_PASSWORD set).
- FIXED (delegated): provider.ts Cloudflare unified apiKey; transform.ts Devstral toLowerCase; project.ts session-migration time_updated preservation (3 sites); config/tui.ts managed-config load + paths.ts json/jsonc precedence; plugin/index.ts wire Azure/DigitalOcean/xAI auth plugins.

## Flagged follow-up (NOT fixed — deliberate)
- processor.ts `providerExecuted` handling: shipped session doesn't use the provider-executed-tool flag (adapters capture it). MED — server-side provider tools (e.g. web search) not handled optimally. NOT fixed pre-release: the upstream change is entangled with GitLab-Duo approval code the fork doesn't ship; porting it blind risks core session processing. Needs a scoped follow-up.
- Branding LOW polish: optional, non-blocking.

## Dual-preservation verdict
- FORK preservation: CLEAN (D + F pass; nothing we built is lost or weakened).
- UPSTREAM preservation: the gaps were HERE — 5 dropped fixes + 3 unwired auth plugins + managed-config, now restored. This is the class my earlier fork-focused passes missed; the board's upstream-adoption + seam lenses caught them.

## Addendum — E (integration seams) full report
Enumerated the seam surface: 587 `@opencode-ai/*` import sites across 216 files in packages/opencode/src + 37 in packages/tui/src; 6 subsystem scopes audited.
- **Azure/DigitalOcean/xAI auth plugins unwired** (MED-HIGH) — FIXED (board commit b0ade919c7).
- **`openai/codex.ts` orphaned** (MED) — DOCUMENTED, not fixed. 0 consumers; fork deliberately uses its own `./codex` (BUILTIN). Harmless dead code; deleting an upstream file risks future-merge friction. Adopting its WebSocket/allowlist/dispose capabilities is a product decision, not a merge fix.
- **Dual-`Session`-module `getUsage` divergence** (MED-latent / LOW-active) — DOCUMENTED, not fixed. Live path is `processor.ts:326 → session/index.ts:830` (carries the OpenRouter cost fix); `session.ts:387` is the caller-less V2-migration copy. Not a live bug; session.ts is the not-shipped V2 surface.
- **OVERTURNED false-positive HIGH**: an earlier subagent claimed `fromPlugin` permission-gate bypass (ctx.ask became Effect → `await` no-ops). E traced the `legacyToInit`→bridged-`legacyCtx` layer (tool-zod-compat.ts:221) that makes ask Promise-based before the plugin runs — the gate runs correctly. Safety surface confirmed clean.
- Server / cli / effect / config / storage seam scopes: clean. Signature-skew class (`Adaptor.target()`) already fixed; 192 tracked `upstream_fix` markers + green typecheck catch compile-level skew.

## Final board disposition
- Ship-blocker: 1 (release.yml) — FIXED.
- Real dropped-upstream fixes/features: 6 + 3 auth plugins + run-auth — FIXED.
- Security (pre-existing): sensitive-write guard neutralization — FIXED.
- provider-executed metadata — FIXED (execution was already correct); settlement-telemetry field = scoped follow-up.
- Latent/dead-code in the not-shipped V2 surface (codex orphan, getUsage copy) — DOCUMENTED, deliberately not chased.
- Fork preservation + safety surface: PASS (nothing lost or weakened).
