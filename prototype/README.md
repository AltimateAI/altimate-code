# Altimate Code — Part 1 Onboarding Prototype

Everything under `prototype/` is prototype-only scaffolding for the redesigned
Part 1 onboarding (model select + gateway sign-in). The CLI changes it drives
live in the normal source tree (`packages/opencode/src/...`).

## Layout

- `stub-server/` — a single Bun server (`http://localhost:8787`) that serves both
  the pixel-faithful web pages and the API the CLI talks to. The device-auth wire
  contract mirrors `packages/opencode/src/account/index.ts` exactly (standard OAuth
  device grant); instance provisioning is modeled as bearer-authenticated follow-up
  calls after the token arrives.
- `assets/signup-design-reference.png` — the live `app.myaltimate.com/register`
  design reference every Altimate-branded page is matched against.

## Stage 1 — stub server (this stage)

### Run

```sh
# from the repo root
~/.bun/bin/bun run prototype/stub-server/server.ts
# optional: PORT=9000 ~/.bun/bin/bun run prototype/stub-server/server.ts
```

Then open:

- <http://localhost:8787/register> — sign-up (Google, or email fallback)
- <http://localhost:8787/dev/inbox> — the prototype email mailbox (email path)

### Pages

| Page | What |
|---|---|
| `/register` | Altimate sign-up. "or use email instead" expands the email form in place; password rules light up live. |
| `/oauth/google` | Google account-chooser replica (Priya Sharma · priya@acme.com). |
| `/instance` | Name your instance (same flow, right after sign-in): pre-filled from the email domain, debounced live availability, inline validation. |
| `/connected` | "Connected" confirmation the CLI's polling makes truthful. |
| `/verify` | "Check your inbox" (email fallback). |
| `/dev/inbox` | Prototype mailbox — click **Verify email** to authorize the session. |

### API (contract mirrors `account/index.ts`)

| Method + path | Purpose |
|---|---|
| `POST /auth/device/code` | Issue `device_code` / `user_code` / `verification_uri_complete`. |
| `POST /auth/device/token` | Standard OAuth device-grant poll → `authorization_pending` then `access_token`. Also `refresh_token` grant. |
| `GET /api/user` (bearer) | `{ id, email, suggested_instance }`. |
| `GET /api/instance/check?name=` | Live availability for the `/instance` page: `{valid,error?}` / `{valid,available,suggestion?}`. |
| `POST /web/instance` (form) | Web submit of the instance name → provisioning (`acme` seeded taken → suggests `acme-2`). |
| `GET /api/instance` (bearer) | `{status:"awaiting_name"}` (user still naming in the browser) → `{status:"provisioning"}` → `{status:"ready", instance, api_key}` after ~8s. The CLI polls this silently — it never prompts for the name. |
| `POST /api/instance {name}` (bearer) | Legacy direct-create (kept for scripting): `201 provisioning` or `409 name_taken`. |

Every event logs a structured JSON line to stdout (`device_code_issued`,
`provider_selected`, `device_authorized`, `signup_blocked_personal_email`,
`instance_provisioning`, `instance_ready`, …) — these double as the
instrumentation demo.
