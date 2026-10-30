// altimate_change - new file
//
// `integrations`: one-click local integrations for GitHub, Jira and Linear. Detects existing
// credentials, collects the workspace's own credentials (fields, drafts, clipboard, validation),
// keeps them local or shares them with the workspace, and still offers the loopback browser
// consent flow behind `connect --oauth`. The workspace side is mocked unless signed in.
import type { Argv } from "yargs"
import os from "node:os"
import { cmd } from "./cmd"
import { UI } from "../ui"
import * as core from "../../altimate/integrations/core"
import * as creds from "../../altimate/integrations/credentials"
import type { ProviderId, ProviderStatus, StatusResult } from "../../altimate/integrations/core"

const S = UI.Style
const out = (text = "") => console.log(text)
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2))
const jsonOption = { describe: "print machine-readable JSON", type: "boolean", default: false } as const

const STATE_VIEW: Record<ProviderStatus["state"], { icon: string; color: string; label: string }> = {
  connected: { icon: "●", color: S.TEXT_SUCCESS, label: "connected" },
  expired: { icon: "⚠", color: S.TEXT_WARNING, label: "expired" },
  rejected: { icon: "⚠", color: S.TEXT_WARNING, label: "rejected" },
  detected: { icon: "◐", color: S.TEXT_WARNING, label: "detected" },
  available: { icon: "○", color: S.TEXT_INFO, label: "available" },
  not_found: { icon: "·", color: S.TEXT_DIM, label: "not found" },
}
const SYNC_LABEL: Record<ProviderStatus["sync"], string> = {
  synced: "synced to workspace",
  local: "local only",
  pending: "will sync on next sync",
  blocked: "blocked, kept local",
}

function printStatus(result: StatusResult, title: string) {
  out()
  out(`${S.TEXT_HIGHLIGHT_BOLD}◆ ${title}${S.TEXT_NORMAL}  ${S.TEXT_DIM}workspace ${result.workspace.name} (${result.workspace.tenant})${S.TEXT_NORMAL}`)
  out()
  for (const p of result.providers) {
    const v = STATE_VIEW[p.state]
    const src = p.source ? `${p.source.label}${p.account ? ` · ${p.account}` : ""}` : "-"
    out(`  ${v.color}${v.icon}${S.TEXT_NORMAL} ${S.TEXT_NORMAL_BOLD}${p.name.padEnd(8)}${S.TEXT_NORMAL} ${v.color}${v.label.padEnd(10)}${S.TEXT_NORMAL} ${src}`)
    if (p.state !== "not_found") out(`    ${S.TEXT_DIM}${SYNC_LABEL[p.sync]}${p.expiresAt && p.state === "connected" ? ` · expires ${p.expiresAt}` : ""}${p.note ? ` · ${p.note}` : ""}${S.TEXT_NORMAL}`)
  }
  out()
}

function parseProviders(value: unknown, all: boolean | undefined): ProviderId[] {
  if (all || value === "all") return core.PROVIDER_IDS
  if (typeof value === "string" && core.isProvider(value)) return [value]
  throw new Error(`Specify a provider (${core.PROVIDER_IDS.join(", ")}) or --all.`)
}

function fail(error: unknown, asJson = false) {
  const message = error instanceof Error ? error.message : String(error)
  if (asJson) json({ status: "failed", message })
  else UI.error(message)
  process.exitCode = 1
}

const StatusCommand = cmd({
  command: "status",
  describe: "show the GitHub, Jira and Linear integrations",
  builder: (yargs: Argv) => yargs.option("json", jsonOption),
  handler: async (args) => {
    const result = await core.statusRemote()
    if (args.json) return json(result)
    printStatus(result, "Integrations")
  },
})

const DetectCommand = cmd({
  command: "detect",
  describe: "scan this machine for existing credentials (read-only, secrets are never printed)",
  builder: (yargs: Argv) => yargs.option("json", jsonOption),
  handler: async (args) => {
    core.recordDetections(core.scan())
    const result = await core.statusRemote()
    if (args.json) return json(result)
    printStatus(result, "Detected integrations")
  },
})

function renderSync(o: core.SyncOutcome) {
  const name = core.PROVIDER_NAMES[o.id]
  if (o.result === "kept_local") return out(`  ${S.TEXT_WARNING}⊘${S.TEXT_NORMAL} ${name}: kept local (${o.reason})`)
  if (o.result === "failed") return out(`  ${S.TEXT_DANGER}✗${S.TEXT_NORMAL} ${name}: sync failed (${o.reason})`)
  if (o.result === "skipped") return out(`  ${S.TEXT_DIM}- ${name}: skipped (${o.reason})${S.TEXT_NORMAL}`)
  out(`  ${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${name} synced to workspace (private)`)
}

async function runSync(ids: ProviderId[], asJson: boolean) {
  const outcomes: core.SyncOutcome[] = []
  for (const id of ids) {
    if (!asJson && !core.isBlocked(id)) out(`\n${S.TEXT_NORMAL_BOLD}${core.PROVIDER_NAMES[id]}${S.TEXT_NORMAL}`)
    const o = await core.syncProvider(
      id,
      asJson ? undefined : (label, done) => done && out(`  ${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${label}`),
      asJson ? 0 : 250,
    )
    outcomes.push(o)
    if (!asJson) renderSync(o)
  }
  if (asJson) json({ workspace: core.workspaceInfo(), results: outcomes.map(({ steps, ...rest }) => ({ ...rest, steps: steps.map((s) => s.label) })) })
  else out()
  return outcomes
}

const SyncCommand = cmd({
  command: "sync [provider]",
  describe: "push detected and connected credentials to the workspace",
  builder: (yargs: Argv) =>
    yargs
      .positional("provider", { type: "string", choices: core.PROVIDER_IDS })
      .option("all", { describe: "sync every provider", type: "boolean", default: false })
      .option("json", jsonOption),
  handler: async (args) => {
    try {
      await runSync(args.provider || args.all ? parseProviders(args.provider, args.all) : core.PROVIDER_IDS, args.json)
    } catch (e) {
      fail(e)
    }
  },
})

function policyCommand(name: "block" | "unblock") {
  const blocking = name === "block"
  return cmd({
    command: `${name} [provider]`,
    describe: blocking ? "keep a provider's credentials on this machine only" : "allow a provider to sync to the workspace again",
    builder: (yargs: Argv) =>
      yargs
        .positional("provider", { type: "string", choices: core.PROVIDER_IDS })
        .option("all", { describe: "apply to every provider", type: "boolean", default: false })
        .option("json", jsonOption),
    handler: async (args) => {
      try {
        const ids = parseProviders(args.provider, args.all)
        core.setBlocked(ids, blocking)
        if (args.json) return json({ policy: name === "block" ? "blocked" : "allowed", providers: ids })
        for (const id of ids)
          out(`${blocking ? S.TEXT_WARNING + "⊘" : S.TEXT_SUCCESS + "✓"}${S.TEXT_NORMAL} ${core.PROVIDER_NAMES[id]} ${blocking ? "will stay on this machine" : "can sync to the workspace"}`)
      } catch (e) {
        fail(e)
      }
    },
  })
}

const DisconnectCommand = cmd({
  command: "disconnect <provider>",
  describe: "remove the local credential and the workspace connection",
  builder: (yargs: Argv) =>
    yargs.positional("provider", { type: "string", choices: core.PROVIDER_IDS, demandOption: true }).option("json", jsonOption),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      const removedLocal = core.disconnect(id)
      const removedRemote = await core.disconnectRemote(id)
      const removed = removedLocal || removedRemote > 0
      if (args.json) return json({ provider: id, status: "disconnected", removed, removedFromWorkspace: removedRemote })
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${core.PROVIDER_NAMES[id]} disconnected${removed ? "" : S.TEXT_DIM + " (nothing was stored)" + S.TEXT_NORMAL}`)
    } catch (e) {
      fail(e)
    }
  },
})

function announce(args: { json: boolean; open: boolean }, name: string, reauth: boolean) {
  return (url: string) => {
    if (args.json) console.error(JSON.stringify({ event: "browser", url }))
    else {
      out(`\n${S.TEXT_HIGHLIGHT_BOLD}◆ ${reauth ? "Reconnect" : "Connect"} ${name}${S.TEXT_NORMAL}\n`)
      out(`  Approve access in your browser:\n  ${S.TEXT_INFO}${url}${S.TEXT_NORMAL}\n`)
      out(`  ${S.TEXT_DIM}Waiting for approval (up to 5 minutes)...${S.TEXT_NORMAL}`)
    }
    if (args.open) core.openBrowser(url)
  }
}

async function runOAuthConnect(args: any) {
  try {
    const id = parseProviders(args.provider, false)[0]
    const name = core.PROVIDER_NAMES[id]
    const { result, sync } = await core.connectProvider({
      id,
      port: args.port,
      localOnly: args["local-only"],
      reauth: args.reauth,
      noFrontend: !args.frontend,
      onListening: announce(args, name, args.reauth),
      onStep: args.json ? undefined : (label, done) => done && out(`  ${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${label}`),
      pace: args.json ? 0 : 250,
    })
    if (args.json) {
      json({ provider: id, status: result.status, sync, account: result.account, url: result.url, expiresAt: result.expiresAt ?? null, ...(result.message ? { message: result.message } : {}) })
      if (result.status === "error") process.exitCode = 1
      return
    }
    out()
    if (result.status === "connected") {
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${name} connected${result.account ? ` as ${S.TEXT_NORMAL_BOLD}${result.account}${S.TEXT_NORMAL}` : ""}`)
      out(`  ${S.TEXT_DIM}${result.credential ? `credential ${core.maskSecret(result.credential)} stored locally` : "no credential kept on this machine"}${S.TEXT_NORMAL}`)
      out(`  ${S.TEXT_DIM}${sync === "synced" ? `synced to ${core.workspaceInfo().name} from ${os.hostname()}` : "kept local, not synced"}${S.TEXT_NORMAL}\n`)
    } else if (result.status === "cancelled") out(`${S.TEXT_WARNING}⊘${S.TEXT_NORMAL} Cancelled, nothing was connected.\n`)
    else if (result.status === "error") {
      out(`${S.TEXT_DANGER}✗${S.TEXT_NORMAL} ${result.message ?? "Could not connect."}\n`)
      process.exitCode = 1
    } else out(`${S.TEXT_DANGER}✗${S.TEXT_NORMAL} Timed out waiting for approval.\n`)
  } catch (e) {
    fail(e)
  }
}

const variantOption = { describe: "credential variant (Jira: cloud or server)", type: "string" } as const

async function runCredentials(args: any, update: boolean) {
  try {
    const id = parseProviders(args.provider, false)[0]
    const name = core.PROVIDER_NAMES[id]
    const r = await creds.connectCredentials({
      id,
      update,
      localOnly: args["local-only"],
      variant: args.variant,
      onStep: args.json ? undefined : (label) => out(`  ${S.TEXT_DIM}${label}${S.TEXT_NORMAL}`),
    })
    if (r.status !== "connected") process.exitCode = 1
    if (args.json) return json({ provider: r.provider, status: r.status, sync: r.sync, account: r.account, expiresAt: r.expiresAt, message: r.message, ...(r.code ? { code: r.code } : {}), ...(r.missing ? { missing: r.missing } : {}) })
    if (r.status === "connected") {
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${name} ${update ? "updated" : "connected"}${r.account ? ` as ${S.TEXT_NORMAL_BOLD}${r.account}${S.TEXT_NORMAL}` : ""}`)
      out(`  ${S.TEXT_DIM}${r.sync === "synced" ? `synced to your workspace from ${os.hostname()}` : "kept local, not synced"}${r.expiresAt ? ` · expires ${r.expiresAt}` : ""}${r.message ? ` · ${r.message}` : ""}${S.TEXT_NORMAL}`)
    } else out(`${S.TEXT_DANGER}✗${S.TEXT_NORMAL} ${name}: ${r.message ?? r.status}`)
  } catch (e) {
    fail(e)
  }
}

const credentialOptions = (yargs: Argv) =>
  yargs
    .positional("provider", { type: "string", choices: core.PROVIDER_IDS, demandOption: true })
    .option("json", jsonOption)
    .option("variant", variantOption)

const ConnectCommand = cmd({
  command: "connect <provider>",
  describe: "connect a provider with its own credentials (add --oauth for the browser sign-in)",
  builder: (yargs: Argv) =>
    credentialOptions(yargs)
      .option("local-only", { describe: "keep the credential on this machine", type: "boolean", default: false })
      .option("oauth", { describe: "use the one-click browser sign-in instead of credentials", type: "boolean", default: false })
      .option("open", { describe: "open the browser (--no-open prints the URL only)", type: "boolean", default: true })
      .option("reauth", { describe: "renew expired access for an existing connection (with --oauth)", type: "boolean", default: false })
      .option("frontend", { describe: "use the Altimate web app consent page (--no-frontend opens the provider authorize URL directly)", type: "boolean", default: true })
      .option("port", { describe: "loopback port for the consent page (with --oauth)", type: "number" }),
  handler: async (args) => (args.oauth ? runOAuthConnect(args) : runCredentials(args, false)),
})

const UpdateCommand = cmd({
  command: "update <provider>",
  describe: "re-check and save new credentials for a connected provider, keeping its sync mode",
  builder: (yargs: Argv) => credentialOptions(yargs),
  handler: async (args) => runCredentials(args, true),
})

const FieldsCommand = cmd({
  command: "fields <provider>",
  describe: "the credential fields for a provider, pre-filled where possible (secrets show only a masked tail)",
  builder: (yargs: Argv) => credentialOptions(yargs),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      const r = await creds.describeFields(id, args.variant)
      if (args.json) return json(r)
      out(`\n${S.TEXT_HIGHLIGHT_BOLD}◆ ${core.PROVIDER_NAMES[id]}${S.TEXT_NORMAL} ${S.TEXT_DIM}${r.variant}${r.variants.length > 1 ? ` (also: ${r.variants.filter((v) => v !== r.variant).join(", ")})` : ""}${S.TEXT_NORMAL}\n`)
      for (const f of r.fields) {
        const shown = f.secret ? (f.hasValue ? `✓ ${f.masked}` : "not set") : (f.value ?? "not set")
        out(`  ${f.label}${f.required ? "" : " (optional)"}: ${shown}`)
      }
      if (r.tokenUrl) out(`\n  ${S.TEXT_DIM}Create a token: ${r.tokenUrl}${S.TEXT_NORMAL}`)
      out()
    } catch (e) {
      fail(e, args.json)
    }
  },
})

const SetCommand = cmd({
  command: "set <provider> <field> <value>",
  describe: "store a non-secret credential field (secrets use set-secret)",
  builder: (yargs: Argv) =>
    yargs
      .positional("provider", { type: "string", choices: core.PROVIDER_IDS, demandOption: true })
      .positional("field", { type: "string", demandOption: true })
      .positional("value", { type: "string", demandOption: true })
      .option("json", jsonOption),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      const r = await creds.setDraft(id, String(args.field), String(args.value))
      if (args.json) return json(r)
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${core.PROVIDER_NAMES[id]} ${r.field} saved`)
    } catch (e) {
      fail(e, args.json)
    }
  },
})

const SetSecretCommand = cmd({
  command: "set-secret <provider> <field>",
  describe: "store a secret credential field from the clipboard, an environment variable or stdin",
  builder: (yargs: Argv) =>
    yargs
      .positional("provider", { type: "string", choices: core.PROVIDER_IDS, demandOption: true })
      .positional("field", { type: "string", demandOption: true })
      .option("from-clipboard", { describe: "read the secret from the clipboard", type: "boolean", default: false })
      .option("from-env", { describe: "read the secret from this environment variable", type: "string" })
      .option("stdin", { describe: "read the secret from standard input", type: "boolean", default: false })
      .option("json", jsonOption),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      const chosen = [args["from-clipboard"], Boolean(args["from-env"]), args.stdin].filter(Boolean).length
      if (chosen !== 1) throw new Error("Choose exactly one of --from-clipboard, --from-env VAR or --stdin.")
      const source: creds.SecretSource = args["from-clipboard"] ? { kind: "clipboard" } : args["from-env"] ? { kind: "env", name: args["from-env"] } : { kind: "stdin" }
      const r = await creds.setSecretDraft(id, String(args.field), source)
      if (args.json) return json(r)
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${core.PROVIDER_NAMES[id]} ${r.field} saved ${S.TEXT_DIM}${r.masked}${S.TEXT_NORMAL}`)
    } catch (e) {
      fail(e, args.json)
    }
  },
})

const OpenTokenPageCommand = cmd({
  command: "open-token-page <provider>",
  describe: "open the page where the provider's token is created",
  builder: (yargs: Argv) => credentialOptions(yargs).option("open", { describe: "open the browser (--no-open prints the URL only)", type: "boolean", default: true }),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      const { variant, tokenUrl } = await creds.describeFields(id, args.variant)
      if (!tokenUrl) throw new Error(`${core.PROVIDER_NAMES[id]} (${variant}) has no token page. Create the token in your Jira profile.`)
      if (args.open) core.openBrowser(tokenUrl)
      if (args.json) return json({ provider: id, variant, tokenUrl })
      out(tokenUrl)
    } catch (e) {
      fail(e, args.json)
    }
  },
})

const TokenCommand = cmd({
  command: "token <provider>",
  describe: "print a fresh token for local tools (renews expired access in the browser)",
  builder: (yargs: Argv) =>
    yargs
      .positional("provider", { type: "string", choices: core.PROVIDER_IDS, demandOption: true })
      .option("json", jsonOption)
      .option("open", { describe: "open the browser when access must be renewed", type: "boolean", default: true })
      .option("frontend", { describe: "use the Altimate web app consent page (--no-frontend opens the provider authorize URL directly)", type: "boolean", default: true }),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      // Progress goes to stderr so stdout carries only the token.
      const r = await core.getToken(id, {
        noFrontend: !args.frontend,
        onListening: (url) => {
          console.error(`Access expired, approve in your browser: ${url}`)
          if (args.open) core.openBrowser(url)
        },
      })
      if (r.status !== "ok") {
        if (args.json) json({ provider: id, status: r.status, message: r.message })
        else console.error(r.message)
        process.exitCode = 1
        return
      }
      if (args.json) return json({ provider: id, status: "ok", token: r.token, expiresAt: r.expiresAt, reauthed: r.reauthed })
      console.log(r.token)
    } catch (e) {
      fail(e)
    }
  },
})

const ExpireCommand = cmd({
  command: "expire <provider>",
  describe: false,
  builder: (yargs: Argv) => yargs.positional("provider", { type: "string", choices: core.PROVIDER_IDS, demandOption: true }),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      if (!core.expireProvider(id)) throw new Error(`${core.PROVIDER_NAMES[id]} is not connected.`)
      out(`${core.PROVIDER_NAMES[id]} access marked expired.`)
    } catch (e) {
      fail(e)
    }
  },
})

export const IntegrationsCommand = cmd({
  command: "integrations",
  describe: "connect GitHub, Jira and Linear with one click and sync them to your workspace",
  builder: (yargs: Argv) =>
    yargs
      .command(StatusCommand)
      .command(DetectCommand)
      .command(ConnectCommand)
      .command(UpdateCommand)
      .command(FieldsCommand)
      .command(SetCommand)
      .command(SetSecretCommand)
      .command(OpenTokenPageCommand)
      .command(SyncCommand)
      .command(policyCommand("block"))
      .command(policyCommand("unblock"))
      .command(TokenCommand)
      .command(ExpireCommand)
      .command(DisconnectCommand)
      .demandCommand(),
  async handler() {},
})
