// altimate_change - new file
//
// `integrations`: one-click local integrations for GitHub, Jira and Linear. Detects existing
// credentials, collects the workspace's own credentials (fields, drafts, clipboard, validation) and
// keeps them local or saves them as the caller's own workspace connection. Signed in, it talks to the
// real workspace; without a login the credentials stay on this machine (or a stand-in workspace in mock and demo modes).
import type { Argv } from "yargs"
import os from "node:os"
import open from "open"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { IntegrationsCore as core } from "../../altimate/integrations/core"
import { IntegrationsCredentials as creds } from "../../altimate/integrations/credentials"
import type { ProviderId, ProviderStatus, StatusResult } from "../../altimate/integrations/core"

const S = UI.Style
const out = (text = "") => console.log(text)
/** Text from config, a provider or the network, safe to print: escape sequences, control characters and bidi marks are removed. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
export const clean = (value: unknown) => String(value ?? "").replace(ANSI, "").replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim()
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2))
const jsonOption = { describe: "print machine-readable JSON", type: "boolean", default: false } as const
const shareOption = { describe: "allow sharing: attach to a linked workspace that is not private (its members can use the connection), and update a connection that is already shared (the people it is shared with get the new credential)", type: "boolean", default: false } as const

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
  out(`${S.TEXT_HIGHLIGHT_BOLD}◆ ${title}${S.TEXT_NORMAL}  ${S.TEXT_DIM}${result.workspace.linked ? `workspace ${clean(result.workspace.name)}` : "workspace not linked"}${result.workspace.tenant ? ` (${clean(result.workspace.tenant)})` : ""}${S.TEXT_NORMAL}`)
  if (result.workspaceUnchecked) out(`  ${S.TEXT_WARNING}Could not check the workspace, so these states come from this machine and may be out of date: ${clean(result.workspaceUnchecked)}${S.TEXT_NORMAL}`)
  out()
  for (const p of result.providers) {
    const v = STATE_VIEW[p.state]
    const src = p.source ? `${clean(p.source.label)}${p.account ? ` · ${clean(p.account)}` : ""}` : "-"
    out(`  ${v.color}${v.icon}${S.TEXT_NORMAL} ${S.TEXT_NORMAL_BOLD}${p.name.padEnd(8)}${S.TEXT_NORMAL} ${v.color}${v.label.padEnd(10)}${S.TEXT_NORMAL} ${src}`)
    if (p.state !== "not_found") out(`    ${S.TEXT_DIM}${SYNC_LABEL[p.sync]}${p.expiresAt && p.state === "connected" ? ` · expires ${clean(p.expiresAt)}` : ""}${p.note ? ` · ${clean(p.note)}` : ""}${S.TEXT_NORMAL}`)
  }
  out()
}

function parseProviders(value: unknown, all: boolean | undefined): ProviderId[] {
  if (all || value === "all") return core.PROVIDER_IDS
  if (typeof value === "string" && core.isProvider(value)) return [value]
  throw new Error(`Specify a provider (${core.PROVIDER_IDS.join(", ")}) or --all.`)
}

function fail(error: unknown, asJson = false) {
  const message = clean(error instanceof Error ? error.message : String(error))
  if (asJson) json({ status: "failed", message })
  else UI.error(message)
  process.exitCode = 1
}

const StatusCommand = cmd({
  command: "status",
  describe: "show the GitHub, Jira and Linear integrations",
  builder: (yargs: Argv) => yargs.option("json", jsonOption),
  handler: async (args) => {
    try {
      const result = await core.statusRemote()
      if (args.json) return json(result)
      printStatus(result, "Integrations")
    } catch (e) {
      fail(e, args.json)
    }
  },
})

const DetectCommand = cmd({
  command: "detect",
  describe: "scan this machine for existing credentials (read-only, secrets are never printed)",
  builder: (yargs: Argv) => yargs.option("json", jsonOption),
  handler: async (args) => {
    try {
      await core.recordDetections(core.scan())
      const result = await core.statusRemote()
      if (args.json) return json(result)
      printStatus(result, "Detected integrations")
    } catch (e) {
      fail(e, args.json)
    }
  },
})

/** Who can use a synced connection: only the user, unless it was attached to a workspace that is not private. */
export const syncedTo = (o: Pick<core.SyncOutcome, "shared">) => `synced to workspace${o.shared ? ", shared with other people" : " (private)"}`

function renderSync(o: core.SyncOutcome) {
  const name = core.PROVIDER_NAMES[o.id]
  const warnings = () => {
    for (const st of o.steps) if (!st.ok && st.label.startsWith(core.LOCAL_CLEANUP_FAILED_PREFIX)) out(`  ${S.TEXT_WARNING}!${S.TEXT_NORMAL} ${clean(st.label)}`)
  }
  if (o.result === "kept_local") return out(`  ${S.TEXT_WARNING}⊘${S.TEXT_NORMAL} ${name}: kept local (${clean(o.reason)})`)
  if (o.result === "failed") {
    out(`  ${S.TEXT_DANGER}✗${S.TEXT_NORMAL} ${name}: sync failed (${clean(o.reason)})`)
    return warnings()
  }
  if (o.result === "skipped") return out(`  ${S.TEXT_DIM}- ${name}: skipped (${clean(o.reason)})${S.TEXT_NORMAL}`)
  out(`  ${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${name} ${syncedTo(o)}`)
  warnings()
}

async function runSync(ids: ProviderId[], asJson: boolean, skipSynced = false, share = false) {
  const outcomes: core.SyncOutcome[] = []
  for (const id of ids) {
    if (!asJson && !core.isBlocked(id)) out(`\n${S.TEXT_NORMAL_BOLD}${core.PROVIDER_NAMES[id]}${S.TEXT_NORMAL}`)
    const o = await core.syncProvider(
      id,
      asJson ? undefined : (label, done) => done && out(`  ${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${label}`),
      asJson ? 0 : 250,
      skipSynced,
      share,
    )
    outcomes.push(o)
    if (!asJson) renderSync(o)
  }
  if (asJson) json({ workspace: await core.liveWorkspaceInfo(), results: outcomes })
  else out()
  return outcomes
}

/** A run over every provider, or one provider asked to keep a saved connection, never overwrites a connection already synced to the workspace. */
export const skipsSynced = (args: { provider?: string; all?: boolean; keepSynced?: boolean }) => !args.provider || Boolean(args.keepSynced)

export const SyncCommand = cmd({
  command: "sync [provider]",
  describe: "push detected and connected credentials to the workspace",
  builder: (yargs: Argv) =>
    yargs
      .positional("provider", { type: "string", choices: core.PROVIDER_IDS })
      .option("all", { describe: "sync every provider", type: "boolean", default: false })
      .option("keep-synced", { describe: "attach a connection already saved to the workspace instead of overwriting it, as sync --all does", type: "boolean", default: false })
      .option("share", shareOption)
      .option("json", jsonOption),
  handler: async (args) => {
    try {
      const outcomes = await runSync(args.provider || args.all ? parseProviders(args.provider, args.all) : core.PROVIDER_IDS, args.json, skipsSynced(args), args.share)
      if (outcomes.some((o) => o.result === "failed")) process.exitCode = 1
    } catch (e) {
      fail(e, args.json)
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
        const wanted = parseProviders(args.provider, args.all)
        // A connection saved in the workspace has no copy here to keep, so it cannot be blocked. One only the workspace holds counts too. If the workspace cannot be read the block is still set (it only stops later uploads) and a warning says so.
        const { blocked: ids, refused: held, unchecked } = blocking ? await core.blockProviders(wanted) : { blocked: wanted, refused: [] as ProviderId[], unchecked: [] as ProviderId[] }
        if (!blocking) await core.setBlocked(ids, false)
        if (held.length) process.exitCode = 1
        const warning = unchecked.length ? `Could not check the workspace for ${unchecked.map((id) => core.PROVIDER_NAMES[id]).join(", ")}; blocked here anyway. If a copy is already saved there it stays until you disconnect it.` : null
        const refusal = (id: ProviderId) => `${core.PROVIDER_NAMES[id]} is saved in your workspace only. To keep it on this machine run: altimate integrations connect ${id} --local-only`
        if (args.json) return json({ policy: name === "block" ? "blocked" : "allowed", providers: ids, ...(held.length ? { refused: held, message: held.map(refusal).join(" ") } : {}), ...(warning ? { warning } : {}) })
        for (const id of ids)
          out(`${blocking ? S.TEXT_WARNING + "⊘" : S.TEXT_SUCCESS + "✓"}${S.TEXT_NORMAL} ${core.PROVIDER_NAMES[id]} ${blocking ? "will stay on this machine" : "can sync to the workspace"}`)
        for (const id of held) UI.error(refusal(id))
        if (warning) out(`${S.TEXT_WARNING}${warning}${S.TEXT_NORMAL}`)
      } catch (e) {
        fail(e, args.json)
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
      const { removedLocal, removedRemote, detached, detachMessage, workspaceUnchecked } = await core.disconnect(id)
      const removed = removedLocal || removedRemote > 0
      if (args.json) return json({ provider: id, status: "disconnected", removed, removedFromWorkspace: removedRemote, detached, ...(workspaceUnchecked ? { workspaceChecked: false, workspaceNote: `The workspace was not checked for a copy of this connection: ${workspaceUnchecked}` } : {}), ...(detachMessage ? { message: `Could not detach it from the linked workspace: ${detachMessage}` } : {}) })
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${core.PROVIDER_NAMES[id]} disconnected${removed ? "" : S.TEXT_DIM + " (nothing was stored)" + S.TEXT_NORMAL}`)
      if (workspaceUnchecked) out(`  ${S.TEXT_WARNING}The workspace was not checked for a copy of this connection (${clean(workspaceUnchecked)}). Sign in and disconnect again to remove it.${S.TEXT_NORMAL}`)
      if (!detached) out(`  ${S.TEXT_WARNING}Could not detach it from the linked workspace: ${clean(detachMessage)}. Check the workspace's integrations.${S.TEXT_NORMAL}`)
    } catch (e) {
      fail(e, args.json)
    }
  },
})

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
      share: args.share,
      onStep: args.json ? undefined : (label) => out(`  ${S.TEXT_DIM}${label}${S.TEXT_NORMAL}`),
    })
    if (r.status !== "connected") process.exitCode = 1
    if (args.json) return json({ provider: r.provider, status: r.status, sync: r.sync, account: r.account, expiresAt: r.expiresAt, message: r.message, ...(r.code ? { code: r.code } : {}), ...(r.missing ? { missing: r.missing } : {}), ...(r.shared ? { shared: true } : {}) })
    if (r.status === "connected") {
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${name} ${update ? "updated" : "connected"}${r.account ? ` as ${S.TEXT_NORMAL_BOLD}${clean(r.account)}${S.TEXT_NORMAL}` : ""}`)
      out(`  ${S.TEXT_DIM}${r.sync === "synced" ? `synced to your workspace from ${clean(os.hostname())}` : "kept local, not synced"}${r.expiresAt ? ` · expires ${clean(r.expiresAt)}` : ""}${r.message ? ` · ${clean(r.message)}` : ""}${S.TEXT_NORMAL}`)
    } else out(`${S.TEXT_DANGER}✗${S.TEXT_NORMAL} ${name}: ${clean(r.message ?? r.status)}`)
  } catch (e) {
    fail(e, args.json)
  }
}

const credentialOptions = (yargs: Argv) =>
  yargs
    .positional("provider", { type: "string", choices: core.PROVIDER_IDS, demandOption: true })
    .option("json", jsonOption)
    .option("variant", variantOption)

export const ConnectCommand = cmd({
  command: "connect <provider>",
  describe: "connect a provider with its own credentials",
  builder: (yargs: Argv) =>
    credentialOptions(yargs).option("share", shareOption).option("local-only", { describe: "keep the credential on this machine", type: "boolean", default: false }),
  handler: async (args) => runCredentials(args, false),
})

const UpdateCommand = cmd({
  command: "update <provider>",
  describe: "re-check and save new credentials for a connected provider, keeping its sync mode",
  builder: (yargs: Argv) => credentialOptions(yargs).option("share", shareOption),
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
      out(`\n${S.TEXT_HIGHLIGHT_BOLD}◆ ${core.PROVIDER_NAMES[id]}${S.TEXT_NORMAL} ${S.TEXT_DIM}${clean(r.variant)}${r.variants.length > 1 ? ` (also: ${r.variants.filter((v) => v !== r.variant).map(clean).join(", ")})` : ""}${S.TEXT_NORMAL}\n`)
      for (const f of r.fields) {
        const shown = f.secret ? (f.hasValue ? `✓ ${clean(f.masked)}` : "not set") : (clean(f.value) || "not set")
        out(`  ${clean(f.label)}${f.required ? "" : " (optional)"}: ${shown}`)
        if (f.note) out(`    ${S.TEXT_DIM}${clean(f.note)}${S.TEXT_NORMAL}`)
      }
      if (r.tokenUrl) out(`\n  ${S.TEXT_DIM}Create a token: ${clean(r.tokenUrl)}${S.TEXT_NORMAL}`)
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
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${core.PROVIDER_NAMES[id]} ${r.field} saved ${S.TEXT_DIM}${clean(r.masked)}${S.TEXT_NORMAL}`)
    } catch (e) {
      fail(e, args.json)
    }
  },
})

const DiscardCommand = cmd({
  command: "discard <provider>",
  describe: "forget the fields and secrets typed in for a provider and not yet connected, such as after a cancelled connect or update",
  builder: (yargs: Argv) => yargs.positional("provider", { type: "string", choices: core.PROVIDER_IDS, demandOption: true }).option("json", jsonOption),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      const r = await creds.discardDrafts(id)
      if (args.json) return json({ ...r, status: "discarded" })
      out(`${S.TEXT_SUCCESS}✓${S.TEXT_NORMAL} ${core.PROVIDER_NAMES[id]} entries cleared`)
    } catch (e) {
      fail(e, args.json)
    }
  },
})

const OpenTokenPageCommand = cmd({
  command: "open-token-page <provider>",
  describe: "open the page where the provider's token is created",
  builder: (yargs: Argv) => credentialOptions(yargs).option("open", { describe: "open the browser (on by default; with --json only when --open is given)", type: "boolean" }),
  handler: async (args) => {
    try {
      const id = parseProviders(args.provider, false)[0]
      const { variant, tokenUrl } = await creds.describeFields(id, args.variant)
      if (!tokenUrl) throw new Error(`${core.PROVIDER_NAMES[id]} (${variant}) has no token page. Create the token in your Jira profile.`)
      if (args.open ?? !args.json) await open(tokenUrl).catch(() => undefined)
      if (args.json) return json({ provider: id, variant, tokenUrl })
      out(tokenUrl)
    } catch (e) {
      fail(e, args.json)
    }
  },
})

export const IntegrationsCommand = cmd({
  command: "integrations",
  describe: "connect GitHub, Jira and Linear and sync them to your workspace",
  builder: (yargs: Argv) =>
    yargs
      .command(StatusCommand)
      .command(DetectCommand)
      .command(ConnectCommand)
      .command(UpdateCommand)
      .command(FieldsCommand)
      .command(SetCommand)
      .command(SetSecretCommand)
      .command(DiscardCommand)
      .command(OpenTokenPageCommand)
      .command(SyncCommand)
      .command(policyCommand("block"))
      .command(policyCommand("unblock"))
      .command(DisconnectCommand)
      .demandCommand(),
  async handler() {},
})
