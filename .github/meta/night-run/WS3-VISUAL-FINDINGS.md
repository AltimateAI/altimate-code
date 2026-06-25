# WS3 — TUI visual inspection findings (tmux capture of built binary)

Method: launched the compiled binary under `tmux` (220x50), drove each surface with `send-keys`,
captured with `capture-pane`. Model `azure/gpt-5.5`.

## Surfaces verified WORKING
| Surface | How | Result |
| --- | --- | --- |
| Home logo | boot | **altimate** wordmark (NOT opencode) ✓ |
| Command palette | `ctrl+p` | full list: Switch model, themes, status, help, docs, debug/console toggles ✓ |
| Model picker | `ctrl+x m` | providers + models populate (GPT-5.5 Azure ●, Zen, Big Pickle, DeepSeek/MiMo/Nemotron free, full Claude lineup); Connect provider / Favorite actions ✓ |
| Theme picker | `ctrl+x t` | full theme list renders, switchable ✓ |
| Prompt → response | typed prompt | agent replied `TUI_OK` in 3.8s; session id, context (25.8K/13%), cost, LSP, cwd all render ✓ |
| Sidebar | session view | session/context/cost/LSP/cwd correct ✓ |
| Help | palette → Help | renders ✓ |
| `/api` traffic | stderr | boot burst of `/api/model` + `/api/provider`, all `(done)` 200s, settles in <1s — **no error flood** ✓ (the user's screenshot flood was 404s from the pre-fix root route mount; fixed) |

## Branding leaks FOUND + FIXED (the scanner missed these)
1. **sidebar/footer.tsx** — wordmark "OpenCode {version}" (split `<b>Open</b><b>Code</b>` across spans → evaded the literal-"OpenCode" regex) → `altimate code {version}`.
2. **home/tips-view.tsx** — tips told users to run `opencode <cmd>` (wrong binary), `.opencode/` dirs, `opencode.json`, `~/.config/opencode/`, `/opencode` GH trigger → rebranded to `altimate <cmd>`, `.altimate-code/`, `altimate-code.json`, `~/.config/altimate-code/`, `/oc`.
3. **util/error.ts** — model-not-found + MCP-auth error hints (`opencode models`, `opencode.json`, "opencode does not support…") → altimate.
4. **attention.ts** — default terminal-title fallback `"opencode"` → `"altimate"`.

## Deferred cosmetic items (NOT functional breaks; config-compat risk)
- **Default theme is named "opencode"** (shows ● in theme picker; like "nord"/"dracula"). Renaming would break saved `"theme":"opencode"` configs — needs an alias strategy. Tracked as cosmetic follow-up.
- **"OpenCode Zen" provider** entry in the model picker — third-party hosted-gateway product name; the fork already rebranded its URLs. Display-name rebrand is a separate provider-mapping decision.

## Verdict
TUI renders correctly across all major surfaces with altimate branding; agent loop, model/provider
loading, and dialogs all functional. No runtime breakage. Footer/tips/error/title rebrands are uncommitted
pending a rebuild re-verify (queued behind the DB-race fix to avoid bundling a half-edited tree).
