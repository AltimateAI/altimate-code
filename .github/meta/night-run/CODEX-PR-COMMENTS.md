# PR #964 Codex Review Comment Disposition

Date: 2026-06-25

Scope: active-path comments for the shipped `packages/opencode` binary, plus reachable TUI/core paths. Comments against `packages/cli/**` and `packages/server/**` were treated as v2 migration follow-ups unless current HEAD showed they were reachable from the shipped binary.

Fetched comments with:

```sh
gh api "repos/AltimateAI/altimate-code/pulls/964/comments?per_page=100"
```

Total comments reviewed: 25.

## Summary

| Status | Count |
|---|---:|
| FIXED | 7 |
| STALE | 2 |
| V2-MIGRATION | 15 |
| WONT-FIX | 1 |

## Comment Disposition

| ID | Review target | Status | Current HEAD decision |
|---:|---|---|---|
| 3472470922 | `packages/opencode/src/agent/subagent-permissions.ts:17` | STALE | Already wired in current HEAD through `packages/opencode/src/tool/task.ts` derived child permissions during `Session.create`; that file is also in the explicit do-not-touch list. |
| 3472470926 | `packages/opencode/src/session/message-v2.ts:827` | FIXED | `packages/opencode/src/session/processor.ts:629` now marks aborted unfinished tools with `metadata.interrupted = true`, preserves running metadata/output, and keeps the original running start time. |
| 3472470932 | `packages/opencode/src/session/prompt.ts:3085` | WONT-FIX(out of scope) | InstanceRef root fix is explicitly handled elsewhere by the user; no edits made to the do-not-touch InstanceRef/service-prompt area. |
| 3472470934 | `packages/core/src/session.ts:268` | V2-MIGRATION | `SessionV2.list` is reached through standalone `packages/server`; shipped `packages/opencode` uses the legacy session listing surface. |
| 3472628483 | `packages/opencode/src/server/auth.ts:19` | STALE | Current HEAD already uses the same default username in auth/server code; these files were also explicitly do-not-touch. |
| 3472628490 | `packages/opencode/src/session/prompt.ts:2856` | FIXED | `packages/opencode/src/session/prompt.ts:2855` passes `cwd: Instance.directory` into command-template `Bun.spawn`. |
| 3472628493 | `packages/tui/src/context/sync.tsx:418` | FIXED | `packages/tui/src/context/sync.tsx:417` now treats missing session message arrays as `[]` before removal search. |
| 3472765387 | `packages/tui/src/context/sync.tsx:520` | FIXED | `packages/tui/src/context/sync.tsx:521` now treats missing message part arrays as `[]` before removal search. |
| 3472765390 | `packages/server/src/handlers.ts:51` | V2-MIGRATION | Standalone v2 server path; not shipped by the legacy `packages/opencode` binary. |
| 3472765393 | `packages/cli/src/tui.ts:32` | V2-MIGRATION | v2 `packages/cli` TUI prompt routing; not the shipped legacy CLI. |
| 3472765395 | `packages/server/src/handlers/session.ts:73` | V2-MIGRATION | Standalone v2 server session handler; not shipped by the legacy CLI/server. |
| 3472765399 | `packages/cli/src/tui.ts:12` | V2-MIGRATION | v2 `packages/cli` launcher; shipped TUI is launched from `packages/opencode/src/cli/cmd/tui.ts`. |
| 3472765404 | `packages/cli/src/tui.ts:24` | V2-MIGRATION | v2 `packages/cli` SDK agent bootstrap; not the shipped binary. |
| 3473813097 | `packages/tui/src/context/sdk.tsx:142` | V2-MIGRATION | The shipped `opencode` TUI supplies `props.events` from `packages/opencode/src/cli/cmd/tui.ts`, so the fallback `sdk.global.event` route is only needed by the v2 CLI path. |
| 3473813103 | `packages/opencode/src/session/prompt.ts:1970` | FIXED | `packages/opencode/src/session/prompt.ts:1968` now keeps `ReadTool` init and file execution inside the same `Effect.scoped` lifetime. |
| 3475733845 | `packages/server/src/handlers/command.ts:8` | V2-MIGRATION | Standalone v2 server command handler; not shipped by legacy `packages/opencode`. |
| 3475733851 | `packages/core/src/config.ts:141` | FIXED | `packages/core/src/config.ts:141` adds `altimate-code.json` to v2 config discovery. This core layer is reachable from shipped opencode through `LocationServiceMap` users. |
| 3475733857 | `packages/cli/src/commands/handlers/serve.ts:21` | V2-MIGRATION | v2 CLI serve output compatibility; not the shipped legacy CLI/server. |
| 3475733861 | `packages/core/src/session.ts:207` | V2-MIGRATION | `SessionV2.create` is used by the standalone v2 server. Shipped opencode already records project directories through its legacy project open path. |
| 3475733867 | `packages/core/src/event.ts:229` | FIXED | `packages/core/src/event.ts:224` and `packages/core/src/event.ts:476` now replay synchronized events with the decoded stored sync definition/version. This is active through the shipped HttpApi sync bridge. |
| 3476008216 | `packages/server/src/handlers/skill.ts:7` | V2-MIGRATION | Standalone v2 server skill handler; not shipped by legacy `packages/opencode`. |
| 3476008222 | `packages/server/src/handlers/reference.ts:7` | V2-MIGRATION | Standalone v2 server reference handler; not shipped by legacy `packages/opencode`. |
| 3476008229 | `packages/server/src/cors.ts:3` | V2-MIGRATION | Standalone v2 server CORS policy; not shipped by legacy `packages/opencode` for this release. |
| 3476008236 | `packages/tui/src/component/dialog-skill.tsx:16` | V2-MIGRATION | Skill dialog v2 routing depends on the v2 server/CLI path. Shipped opencode still has the legacy skill API. |
| 3476008249 | `packages/tui/src/component/dialog-provider.tsx:385` | V2-MIGRATION | Provider integration routing depends on the v2 server/CLI path. Shipped opencode still has legacy provider auth routes. |

## Verification

Before applying fixes, each comment was checked against current HEAD. Stale comments were left untouched, and do-not-touch files were not edited.

Commands run after fixes:

| Command | Result |
|---|---|
| `bun run typecheck` | Exit 2. Current failures are unrelated to touched code: missing `pg` declarations in `packages/drivers/src/postgres.ts` and `packages/drivers/src/redshift.ts`, plus missing `playwright-core`/implicit `any` errors in `packages/opencode/test/altimate/tracing-viewer-e2e.test.ts`. Core and TUI typecheck tasks completed green from cache, and the earlier `prompt.ts` catch-variable error was fixed. |
| `cd packages/opencode && bun test --timeout 90000` | A rerun log reached `10450 pass`, `719 skip`, `113 todo`, `0 fail`. A later final full-suite attempt after a marker/catch cleanup hit repeated full-suite-only timeouts in `test/project/instance-bootstrap.test.ts`; that area is explicitly out of scope. The hung verifier was terminated after capturing the timeout details. |
| `cd packages/opencode && bun test --timeout 30000 test/project/instance-bootstrap.test.ts` | Pass: `4 pass`, `0 fail`, confirming the full-suite timeout was not a persistent failure in that out-of-scope file. |
| `cd packages/opencode && bun test --timeout 90000 test/session/message-v2.test.ts test/session/processor.test.ts test/session/processor-effect.test.ts test/session/prompt.test.ts test/cli/run/stream.transport.test.ts` | Pass: `156 pass`, `4 skip`, `23 todo`, `0 fail`. |
| `cd packages/core && bun test test/config/config.test.ts test/event.test.ts` | Pass: `60 pass`, `0 fail`. |
| `cd packages/tui && bun test test/cli/tui/data.test.tsx` | Pass: `8 pass`, `0 fail`. |
| `bun run script/upstream/analyze.ts --markers --base main --strict` | Exit 1 due pre-existing repo-wide unmarked custom code in 160 upstream-shared files. For touched files, analyzer reported only existing warnings at `packages/opencode/src/session/processor.ts:83` and `packages/opencode/src/session/prompt.ts:623`; it did not flag the new fix hunks, `packages/core/src/config.ts`, `packages/core/src/event.ts`, or `packages/tui/src/context/sync.tsx`. |

No commits were created and nothing was pushed.
