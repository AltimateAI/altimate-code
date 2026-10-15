# Upstream drafts: duplicate check (2026-10-15, anomalyco/opencode)

Searched upstream issues with `gh search issues` for each draft. Nothing is posted yet; posting needs the owner's go-ahead.

| Draft | Upstream match | Action |
|---|---|---|
| ALT-P01 finish hook | None for v2. Old v1-era #5515 (closed) asked for a finish notification, not a completion gate. Related: #55212, a `session.prompt` hook with no reject-with-message. | File as new. Reference #55212 as a sibling gap. |
| ALT-P02 TUI composer | None found | File as new |
| ALT-P03 managed MCP | None. #54100, an enterprise MCP allowlist, is adjacent but different. | File as new |
| ALT-P04 cancellable MCP reload | None for v2. #36865 and #36288 are closed v1-era hang reports. | File as new |
| BUG path plugin silently dropped | **Duplicate of open #52300.** #55390 was closed as its duplicate. | Do not file. Add a comment on #52300 with our repro and the `Host.resolve` line refs if useful. |
| BUG `model.request` URL ignored | None found | File as new |
| TELEMETRY per-call usage | #35781 (closed, completed 2026-07-17) added title/compaction usage to session **totals**. Our ask is narrower: per-call events, finish reason on interrupted steps, missing vs zero tokens. | File as a follow-up and cite #35781 |

Also relevant to the branded-host spike (H4): #54879 (open) says `migrate-v1` does not migrate `mcp-auth.json` OAuth tokens.
