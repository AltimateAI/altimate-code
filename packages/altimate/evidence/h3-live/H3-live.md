# H3 live updater acceptance (altimate-code branded OpenCode v2 spike)

Build: detached checkout altimate-code-v2-host-live @ 9c4ee060e6, Bun 1.4.2, darwin-arm64. Everything under h3live/w (env: h3live/env.sh). Evidence in h3live/evidence/.

| # | Item | Result |
|---|------|--------|
| 1 | 0.0.1-spike and 0.0.2-spike built+packed, published only to local Verdaccio (127.0.0.1:4873) | PASS (1-registry-versions.txt: both packages list [0.0.1-spike, 0.0.2-spike]; `npm config get @altimateai:registry` = 127.0.0.1 verified before dry-run and publish) |
| 2 | npm -g install 0.0.1-spike into temp prefix, branded --version | PASS: `altimate-code v0.0.1-spike`, bin `altimate-code`, pkg `@altimateai/altimate-code` (2-*.txt) |
| 3 | Updater check sees mock 0.0.2-spike; request hit mock not opencode.ai | PASS: TUI `/update` showed "Update available"; release.log `GET /update/api/spike/cli/npm?current=0.0.1-spike` (3-*) |
| 4 | `upgrade` installs 0.0.2-spike from local registry; restart; branded | PASS: upgrade exit 0, `--version` v0.0.2-spike, npm list shows 0.0.2-spike, `debug paths` all under .../altimate-code dirs (db altimate-code-spike.db); service restarted onto new binary, TUI footer 0.0.2-spike, `/update` says up to date, mock log current=0.0.2-spike (4-*) |
| 5 | Wrong package name refused, version unchanged | PASS: exit 1, "returned package "@opencode/cli"; expected "@altimateai/altimate-code"", --version still 0.0.1-spike, no registry install (5-*). Tested via CLI only, not the TUI dialog |
| 6 | No request to opencode.ai during 3-5 | PASS with limits (below) |

## Egress method and limits
- Logging HTTP/CONNECT proxy (127.0.0.1:4875) via HTTP(S)_PROXY on the TUI/service/CLI; 0 opencode.ai entries (final-proxy-full.log). lsof of TUI+service: only 127.0.0.1 sockets (6-lsof-tui-service.txt). Mock + Verdaccio logs show only local traffic.
- Limits: the proxy is advisory. Plain CLI (`upgrade`) localhost requests and npm's did not appear in the proxy log (proxy bypassed for those), so for the CLI path evidence is mock/registry logs only; lsof snapshots are point-in-time, not continuous. No DNS/pcap capture (no sudo).
- Observed non-opencode.ai public egress at the TUI update check: CONNECT registry.npmjs.org x3 and registry.yarnpkg.com x1 (3-proxy-nonapi.log), probably package-manager install-method probes ignoring the local registry. Cause not root-caused.

## Defects
1. TUI strings still say OpenCode: update dialog "prompted to restart OpenCode", "OpenCode is already up to date.", model label "Exo Free OpenCode Zen" on the home prompt.
2. Installed binary embeds opencode.ai URLs (theme.json x34, docs, /v2/install; 6-binary-opencode-ai-strings.txt). None fetched in this run, but not proven unreachable (theme.json, docs links, installer).
3. Public registry probes (npmjs, yarnpkg) at update check, above.
4. Verdaccio logged 403 for `@pnpm/exe.darwin-arm64` during upgrade: pnpm probe hits the configured registry; harmless here.
5. Update runs the check twice in `upgrade` (two mock requests, same timestamp); minor.
6. Platform optional dependency is the unscoped `altimate-code-darwin-arm64` (as designed, name squatting/publish-scope concern for real release).
Unrun: standalone/Homebrew/WinGet paths, TUI wrong-package dialog, post-upgrade --altimate-artifact-smoke.
