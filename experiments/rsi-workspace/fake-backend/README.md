# Fake Altimate workspace backend

A single-file `Bun.serve` stand-in for the Altimate API, enough to exercise workspace
link/bind, skill sync, skill publish and the memory mirror offline with the real CLI.
The wire contract is taken from `packages/opencode/src/altimate/workspace/*.ts`
(`api-client`, `skill-sync`, `skill-publish`, `memory-api`), not guessed.

## Run the server

```bash
PORT=18787 FAKE_STATE=./state.json FAKE_SEED_REMOTE=https://example.test/demo/rsi-demo.git \
  bun experiments/rsi-workspace/fake-backend/server.ts
```

| env | default | meaning |
| --- | --- | --- |
| `PORT` | `18787` | listen port; always binds `127.0.0.1` |
| `FAKE_STATE` | `./state.json` | persisted state |
| `FAKE_TENANT` | `demo` | the one tenant; requests must send `x-tenant: demo` (else 403) |
| `FAKE_TOKENS` | `token-user-a`, `token-user-b` | JSON `{token: {user_id, email}}`; user 1 = A, user 2 = B |
| `FAKE_SEED_REMOTE` | unset | if set and state is empty, seeds a **shared** workspace `rsi-demo` (id 101) owned by user 1 and bound to that git remote |
| `FAKE_DEBUG_TOKEN` | unset | enables debug routes with a separate admin bearer token; leave unset outside harness debugging |

Debug routes are disabled by default. When `FAKE_DEBUG_TOKEN` is set,
`GET /__debug/state` dumps everything and `POST /__debug/reset` resets the state;
both require `Authorization: Bearer <FAKE_DEBUG_TOKEN>` and the correct `x-tenant`.
Ordinary user tokens cannot access them. This fake uses public example user tokens
and is only for local research. Every request logs `METHOD path?query status`.
Unknown routes (engine, MCP, `/mask`, `/connections`, custom integrations...) answer
`404 {"detail":"Not Found"}`, which the CLI treats as "absent"; no engine is offered.

Modelled behaviour: bearer token -> user; workspaces (`/datamates/`) visible to their owner or
when `privacy: shared`; project bindings (`/datamate-project-bindings/*`, 404 when the
workspace is invisible, 409/412 bodies as `{"detail": {...}}`); tenant-wide skills
(`/skills`, paginated `{items,total,page,size,pages}`, `GET /{id}` wrapped in `{skill}`,
`/files/{path}` -> `{path, content}`, `PUT /{id}/datamates` replaces the attachment set and
requires owning the workspace, per-creator unique names, `PATCH` needs `replace_bundle` to drop
paths, strictly increasing `updated_at`); per-user private memory (`/datamates/memory/`,
`PATCH /{id}`, `/list` hiding `source`-tagged rows unless `include_sources` names them).
A skill attached to a workspace is listed/readable by anyone who can see that workspace,
regardless of the skill's own `privacy` (that is a guess about the real server).

## Run altimate-code as user A / user B

Credentials come from `<HOME>/.altimate/altimate.json` (`AltimateApi.credentialsPath()` =
`Global.Path.home` + `.altimate/altimate.json`, `packages/opencode/src/altimate/api/client.ts:56`),
and `Global.Path.home` is `OPENCODE_TEST_HOME || os.homedir()` (`src/global/index.ts:19`).
There is no dedicated credentials-path env var, so override **both `HOME` and `OPENCODE_TEST_HOME`**
to avoid an inherited test home overriding the isolated credentials. Also point the XDG dirs at the isolated home so
the CLI's data/config/state/cache never touch the real ones:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
W="$(mktemp -d "${TMPDIR:-/tmp}/rsi-demo.XXXXXX")"
for u in a b; do
  mkdir -p "$W/home-$u/.altimate"
  printf '{"altimateUrl":"http://127.0.0.1:18787","altimateInstanceName":"demo","altimateApiKey":"token-user-%s"}\n' "$u" \
    > "$W/home-$u/.altimate/altimate.json"
done

run_as() {  # run_as <a|b> <args...>, from inside that user's clone
  HOME="$W/home-$1" OPENCODE_TEST_HOME="$W/home-$1" \
  XDG_DATA_HOME="$W/home-$1/.local/share" XDG_CONFIG_HOME="$W/home-$1/.config" \
  XDG_CACHE_HOME="$W/home-$1/.cache" XDG_STATE_HOME="$W/home-$1/.local/state" ALTIMATE_WORKSPACE=1 \
  bun run --conditions=browser "$REPO_ROOT/packages/opencode/src/index.ts" "${@:2}"
}
```

Notes:
- `ALTIMATE_WORKSPACE=1` is required; without it `skill publish` is a stub and no sync runs.
- Run from the worktree checkout after `bun install --frozen-lockfile` at the repo root.
- Each user needs a clone whose `origin` is the **same URL**. It must be a URL
  (`https://...` or `git@host:path`): a bare local path is dropped by `stripGitRemoteCredentials`
  (`src/altimate/tools/project-scan.ts:185`, `new URL()` throws), leaving only a path-based lookup.
- `altimate-code link` needs a TTY (`src/cli/cmd/link.ts:~164`), so the demo seeds the binding
  server-side (`FAKE_SEED_REMOTE`) and the CLI finds it with `GET /datamate-project-bindings/by-remote`.
- Model auth for `run` is independent of the fake and model requests can incur charges.
  The demo defaults to `google-vertex/gemini-3.5-flash`; override `AGENT_MODEL` or `MODEL`
  with an available configured model. Claude on Vertex may be blocked by organization policy.
  Provider auth stored only in the usual home is unavailable in an isolated home.
- `skill list` does NOT trigger a sync. The bind-time sync runs on the first prompt of a session
  (`src/session/prompt.ts:~395`), so B needs a `run` (or the TUI).

## Automated demo

`bash experiments/rsi-workspace/fake-backend/demo.sh [scratch-parent]` creates a fresh child
directory containing two clones, starts the server, then runs the sequence below. It requires
Bun, Git, Python 3, the repo's installed dependencies, and model authentication. Artifacts are
retained and their path is printed. `ALTIMATE_CMD` overrides the repo-relative CLI command
(quote paths containing spaces inside the command string); `PORT` overrides the port.

For a free local API/auth check with no model calls, run
`python3 experiments/rsi-workspace/fake-backend/selftest.py`.

## What was run and what came out

```
== user A: publish        (skill at repo-a/.altimate-code/skill/dbt-incremental-gotcha/SKILL.md)
$ run_as a skill publish dbt-incremental-gotcha
Published "dbt-incremental-gotcha" in the workspace (1 file, 282B).

== user B: first session
$ run_as b run -m 'google-vertex-anthropic/claude-haiku-4-5@20251001' "Reply with just the word ok."
> builder · claude-haiku-4-5@20251001
ok

$ find repo-b/.altimate-code/skill/_workspace -name SKILL.md
repo-b/.altimate-code/skill/_workspace/sk_103/SKILL.md      # content identical to A's
```

Server log (A's publish, then B's session):

```
GET  /datamate-project-bindings/by-remote?repo_remote=https%3A%2F%2Fexample.test%2Fdemo%2Frsi-demo.git 200
GET  /users/me 200
GET  /datamates/ 200
POST /skills 201
GET  /skills/sk_103 200
PUT  /skills/sk_103/datamates 200
GET  /datamate-project-bindings/by-remote?... 200            <- B
GET  /skills?datamate_id=101&page=1 200
GET  /skills/sk_103 200
GET  /skills/sk_103/files/SKILL.md 200
GET  /datamates/101/summary 200, /datamate_integrations/ 200, /dbt/v3/validate-credentials 200, /datamates 200
GET  /mask 404, /datamate_integrations/custom?page=1&size=100 404, /connections 404
GET  /datamates/memory/list?include_sources=altimate-code&page_size=200 200
```

Publishing requires the publisher to **own** the bound workspace (`assertOwnsWorkspace`,
`skill-publish.ts:882`): per the code (not run), user B publishing into A's workspace is refused client-side with
`NotWorkspaceOwnerError`. For B to publish back, B needs their own workspace or ownership.
