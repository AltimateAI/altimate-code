The fork was created from OpenCode without the desktop app. We want a fully-functional, fully-branded **Altimate Code desktop app** that exposes everything the fork has built, with no OpenCode branding leaks, and a publish-ready CI pipeline.

### Scope
- Adopt the Tauri desktop shell (`packages/desktop`, primary) + Electron shell (`packages/desktop-electron`, secondary) and the SolidJS web UI (`packages/app`, `packages/ui`) from upstream v1.2.20.
- Bundle our `opencode`/`altimate` CLI as the Tauri sidecar so all server-side fork capabilities (SQL, dbt, FinOps, warehouse, altimate-core, the Altimate gateway) are exposed automatically.
- Rebrand every user-facing surface to Altimate Code (names, icons, colors, deep-link scheme, updater endpoints + key) — zero OpenCode leaks.
- Feature the **Altimate LLM Gateway** (`altimate-backend`) provider and remove the OpenCode Zen onboarding.
- Keep future upstream merges branded (un-skip packages, branding rules, `altimate_change` markers).
- Add a CI publish workflow (signed, auto-updating) — ready for org secrets.
