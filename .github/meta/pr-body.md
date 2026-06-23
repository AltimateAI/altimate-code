### What does this PR do?

Brings the **desktop app** into the fork — it was excluded when altimate-code was forked from OpenCode. Adopts the Tauri shell (`packages/desktop`, primary) + Electron shell (`packages/desktop-electron`, secondary) and the SolidJS web UI (`packages/app`, `packages/ui`) from upstream v1.2.20, fully rebranded to **Altimate Code** with **no OpenCode leaks**, and wired for one-click CI publishing.

Highlights:
- **Sidecar = our server.** The Tauri shell bundles our `altimate` binary as the `opencode-cli` sidecar, so every server-side fork capability (SQL, dbt, FinOps, warehouse, altimate-core, the Altimate gateway) is exposed automatically. Sidecar scripts adapted to our build output (`@altimateai/altimate-code-*/bin/altimate`) + the CI artifact contract.
- **Branding (no leaks).** Rebranded the 3 `tauri.*.conf.json` (productName, identifier, deep-link scheme `altimate://`, a **new** updater keypair + AltimateAI endpoints), `index.html`, webmanifest, AppStream, Cargo crate names, `cli.rs` WSL install paths (`~/.altimate/bin`, `www.altimate.sh/install`), native window title, and i18n (18 locales). Regenerated all icon sets, favicons, PWA icons, NSIS bitmaps, social images, and the `Logo`/`Mark` components from the Altimate brand mark.
- **Gateway.** Features the Altimate LLM Gateway (`altimate-backend`) first in the provider picker with a branded icon + an in-app credential arm; removes the OpenCode Zen onboarding and filters out the `opencode`/`opencode-go` providers.
- **Tooling.** Enhanced the generic tool renderer to show full output for custom data tools; un-skipped the packages in the merge tooling with new branding rules / `keepOurs` / `requireMarkers` so future merges stay branded; added `.github/workflows/publish-desktop.yml` + a publishing runbook.

### Type of change

- [x] New feature (non-breaking change which adds functionality)
- [ ] Bug fix
- [ ] Breaking change
- [ ] Documentation update

### Issue for this PR

Closes #960

### How did you verify your code works?

- `bun turbo typecheck` — app, ui, desktop, desktop-electron all pass.
- **Runtime smoke test** — built the sidecar, ran the server, confirmed `GET /provider` returns the `{all, default, connected}` shape with `altimate-backend` ("Altimate AI") present.
- **Native build** — `tauri build` produced `Altimate Code Dev.app` + `.dmg` with a branded `Info.plist` (name/id/executable all Altimate); launched it and confirmed the shell + sidecar run.
- **Visual inspection** — in-browser: branded home wordmark, project view, model picker (no Zen), the "Connect Altimate AI" credential dialog with branded icon; native: menu bar + permission dialog read "Altimate Code".
- **Audits** — branding audit (0 leaks), marker guard + require-markers (clean), prettier (clean), and a **codex deep review** (all P1/P2 findings addressed).

### Checklist

- [x] My code follows the style guidelines of this project
- [x] I have performed a self-review of my code
- [x] I have commented my code where necessary (wrapped fork divergences in `altimate_change` markers)
- [x] I have made corresponding changes to the documentation (`packages/desktop/README.md`)
- [x] My changes generate no new warnings (typecheck + branding + marker guard pass)
- [ ] I have added tests that prove my fix is effective or that my feature works
- [x] New and existing unit tests pass locally with my changes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
