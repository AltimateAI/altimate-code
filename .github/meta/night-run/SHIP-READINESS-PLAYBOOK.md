# Ship-readiness playbook: real-binary E2E + TUI visual inspection

The artifact-level gate that diff review, typecheck, marker guard, and isolated unit tests
structurally cannot provide. Every bug that made altimate-code unusable on ship (TUI log flood, TUI
tracing dropped, `InstanceRef not provided`, uppercase logo, branding leaks) is an **emergent runtime
behavior of the shipped artifact** — found only by building the real binary and using it like a user.
See `RETROSPECTIVE-missed-bugs.md`. Pass the `/goal` argument at the bottom of this file; this is the
loop it should follow.

## The loop — repeat until SHIPPABLE
```
build the real binary → exercise every CLI surface → visually inspect the TUI →
triage each issue (regression vs pre-existing vs benign) → root-cause → fix →
ADD A REGRESSION/PRESENCE TEST that fails without the fix → rebuild → re-verify → repeat
```
Don't stop at "found and described the bug." Stop only when every SHIPPABLE box is checked. Track
surfaces + open issues with TodoWrite across iterations.

## SHIPPABLE — declare only when ALL true
- [ ] `bun run build:local` produces a binary that runs (`--version`, `--help`).
- [ ] Branding: `--help` + TUI logo show the Altimate brand, correct case, zero bare `opencode` in
      user-visible text (data-dir paths / env-var names are OK).
- [ ] Every CLI surface exits cleanly with no stray logs (`service=`/`[INFO]`) and no
      `InstanceRef not provided` on stdout or stderr.
- [ ] TUI: clean render (no flood), a real prompt gets a correct response, `ctrl+p` palette + `tab`
      agent switch open, and a trace file is written for the session.
- [ ] `serve` + auth: `opencode:<pw>` → 200, `altimate:<pw>` → 401, no-auth → 401, `/api/provider` → 200.
- [ ] Every bug found this run has a fix AND a new regression/presence test (mutation-checked).
- [ ] `bun run typecheck` = 13/13; `analyze.ts --markers --base main --strict` no new warnings on
      touched files; smoke + guard suites green; PR CI functional checks green.

## Step 1 — build the REAL binary (not `bun run src`)
```bash
cd packages/opencode && bun run build:local
BIN="$PWD/dist/@altimateai/altimate-code-darwin-arm64/bin/altimate-code"   # adjust arch
"$BIN" --version
```
Rebuild after every fix before re-checking — bugs only reproduce against the compiled entrypoints +
embedded worker.

## Step 2 — CLI surface sweep (from `$BIN`, default env, no `--print-logs`)
For each: exit 0, expected output, and no `service=` / `[INFO]` / `InstanceRef not provided`.
```bash
"$BIN" --help        # branding/case, no bare "opencode" in command list
"$BIN" skill list    # InstanceRef + quiet canary
"$BIN" agent list; "$BIN" providers list; "$BIN" models | head; "$BIN" mcp list
```
Enumerate every subcommand from `--help` and spot-check each loads without crashing/logging.

## Step 3 — TUI visual inspection (highest value, least covered)
```bash
WS="$(mktemp -d)/ws"; mkdir -p "$WS"; printf '# scratch\n' > "$WS/README.md"
tmux kill-session -t goal 2>/dev/null
tmux new-session -d -s goal -x 140 -y 42 "cd '$WS' && '$BIN' 2>/tmp/goal-tui.log"
sleep 7; tmux capture-pane -t goal -p | sed -n '1,42p'      # INSPECT logo/branding/layout
tmux capture-pane -t goal -p | grep -c 'service='          # MUST be 0 (log-flood guard)
TRACEDIR=~/.local/share/altimate-code/traces; BEFORE=$(ls -1 "$TRACEDIR" 2>/dev/null | wc -l)
tmux send-keys -t goal "What is 17 plus 25? number only" Enter; sleep 14
tmux capture-pane -t goal -p | sed -n '1,42p'              # response + sidebar correct?
tmux send-keys -t goal C-p; sleep 2; tmux capture-pane -t goal -p   # palette opens?
tmux send-keys -t goal Escape; tmux send-keys -t goal Tab; sleep 2; tmux capture-pane -t goal -p  # agents?
tmux send-keys -t goal Escape; tmux send-keys -t goal C-c; sleep 6; tmux kill-session -t goal 2>/dev/null
echo "new traces: $(( $(ls -1 "$TRACEDIR" 2>/dev/null | wc -l) - BEFORE ))   # ≥1 (TUI tracing)"
```
Benign noise — do NOT chase: `[upgrade] … 404 …/upstream/…` (dev build channel) and
`service=server failed … Unable to connect … app.altimate.ai` (catch-all proxy, no local backend).

## Step 4 — serve + auth
```bash
OPENCODE_SERVER_PASSWORD=goalpw "$BIN" serve --port 14777 2>/tmp/goal-serve.log & sleep 5
curl -s -o/dev/null -w "%{http_code}\n" -u opencode:goalpw http://127.0.0.1:14777/config     # 200
curl -s -o/dev/null -w "%{http_code}\n" -u altimate:goalpw http://127.0.0.1:14777/config     # 401
curl -s -o/dev/null -w "%{http_code}\n" -u opencode:goalpw http://127.0.0.1:14777/api/provider # 200
pkill -f "serve --port 14777"
```

## Step 5 — for EACH issue: triage → fix → GUARD (this is what compounds the net)
1. Triage: regression (worked on `main` — `git show main:<file>`) vs pre-existing vs benign-environmental.
2. Root-cause the mechanism (don't patch symptoms). Wrap fork edits in `altimate_change` markers
   (`upstream_fix:` prefix for bug fixes).
3. Add a guard test that fails WITHOUT the fix (mutation-check it):
   - runtime/output bug → entrypoint smoke in `test/cli/smokes/` (model: `output-hygiene.test.ts`)
   - dropped fork hook → PRESENCE test in `test/upstream/fork-feature-guards.test.ts` (assert the hook
     EXISTS + FUNCTIONS — absence tests go false-green)
   - pure logic → unit test by the module
4. Rebuild, re-run Steps 2-4. New bug mid-fix → add to todos, keep looping.

## Bug-class checklist (every class we've actually shipped — MUST-CHECK)
- Log/stderr flood in the TUI (any `service=`/`[INFO]` without `--print-logs`)
- Silent feature drop on merge (tracing wiring, `/api` bridge, branding, auth default, TUI plugin)
- `InstanceRef not provided` / split ALS (canary: `skill list`, tracing)
- Branding regressions (uppercase/`opencode` wordmark, log lines, help strings, default usernames)
- Auth default mismatch (server guard vs client header username)
- TUI tracing not written (worker not feeding consumer / worker-thread async-fs write stall)
- DB migration drift/race (fingerprint or fixture table list vs `schema.gen`)

---

## The `/goal` argument to paste
> Drive PR #964 (branch `upstream/merge-v1.17.9`) to ship-ready by repeatedly building the REAL binary
> and using it like a user — not just reading diffs or running unit tests. Follow
> `.github/meta/night-run/SHIP-READINESS-PLAYBOOK.md`: each iteration build `bun run build:local`,
> exercise every CLI surface from the compiled binary, visually inspect the TUI in tmux (logo/branding/
> case, zero log flood, send a prompt and confirm the response renders + a trace file is written, open
> the `ctrl+p` palette and `tab` agent switch), and check serve+auth. For every issue: triage
> regression-vs-pre-existing, root-cause and fix it, and add a regression or presence test that fails
> without the fix. Keep looping until every SHIPPABLE box in the playbook is checked (binary builds; all
> CLI surfaces clean — no `service=`/`[INFO]`, no `InstanceRef`; TUI renders cleanly + traces a session;
> serve auth correct; typecheck 13/13; marker guard clean; smoke+guard suites green; CI green). Don't
> stop at describing bugs — fix and guard each one.
