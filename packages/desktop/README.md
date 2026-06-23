# Altimate Code Desktop

Native Altimate Code desktop app, built with Tauri v2.

## Prerequisites

Building the desktop app requires additional Tauri dependencies (Rust toolchain, platform-specific libraries). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for setup instructions.

## Development

From the repo root:

```bash
bun install
bun run --cwd packages/desktop tauri dev
```

## Build

```bash
bun run --cwd packages/desktop tauri build
```

## Architecture

The desktop app is a thin Tauri shell around the SolidJS web UI (`packages/app` +
`packages/ui`). It bundles our compiled `opencode`/`altimate` CLI as a **sidecar**
(`src-tauri/sidecars/opencode-cli-<target>`) and runs it as a localhost server; the
webview connects to it over HTTP+SSE. Because the sidecar IS our server, every
server-side fork capability (SQL, dbt, FinOps, warehouse, altimate-core, the Altimate
gateway) is exposed automatically.

- `scripts/predev.ts` — local dev: builds the sidecar from `../opencode` and copies it.
- `scripts/prepare.ts` — CI: downloads the `opencode-cli` artifact and copies the sidecar.
- `scripts/utils.ts` — maps each Rust target to our build output dir
  (`@altimateai/altimate-code-<os>-<arch>`) and binary name (`altimate`).

## Local sidecar build

`tauri dev` runs `predev.ts` for you. For a manual `tauri build`, build the sidecar first:

```bash
cd packages/opencode && bun run build --single
cp "dist/@altimateai/altimate-code-$(uname -m | sed 's/arm64/darwin-arm64/;s/x86_64/darwin-x64-baseline/')/bin/altimate" \
   ../desktop/src-tauri/sidecars/opencode-cli-$(rustc -vV | sed -n 's/host: //p')
```

A locally-built `.app` is unsigned — macOS Gatekeeper may quarantine it. Use `tauri dev`
for inspection, or clear the attribute on a built bundle:

```bash
xattr -dr com.apple.quarantine "src-tauri/target/release/bundle/macos/Altimate Code Dev.app"
```

## Publishing (CI)

`.github/workflows/publish-desktop.yml` builds, signs, and ships all platforms. The build
matrix MUST match `allTargets` in `packages/opencode/script/build.ts` (the sidecar only
builds for platforms with an `@altimateai/altimate-core` NAPI prebuild).

### One-time setup — updater signing keypair

```bash
bun --cwd packages/desktop x tauri signer generate -w altimate-updater.key
```

The **public** key already lives in `src-tauri/tauri.{beta,prod}.conf.json` (`updater.pubkey`).
Store the **private** key as the `TAURI_SIGNING_PRIVATE_KEY` repo secret (and its password,
if any, as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). If you regenerate the keypair, update the
committed `pubkey` to match or existing clients won't accept updates.

### Required repo secrets

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | Developer ID Application cert (.p12, base64) |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Altimate Inc (TEAMID)` |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_BASE64` | notarization (App Store Connect API key) |
| `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater signing |

Run via **Actions → publish-desktop → Run workflow** with a version + channel. The job
creates a draft GitHub release, uploads signed bundles as `altimate-code-desktop-*`, and
finalizes `latest.json` for the auto-updater. Dry-run the finalizer first:
`bun ./packages/desktop/scripts/finalize-latest-json.ts --dry-run`.

## Troubleshooting

### Rust compiler not found

If you see errors about Rust not being found, install it via [rustup](https://rustup.rs/):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
