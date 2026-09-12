// altimate_change - new file
//
// The session attach report: what this session actually received from its
// workspace, posted to the backend when the outcome settles so the workspace
// page can show it. Pure shaping here; the one I/O function at the bottom
// goes through the API client and never throws.
import { AltimateApi } from "@/altimate/api/client"
import { log, syncInternals } from "./engine-seams"
import type { Declared, Outcome, Unfulfilled } from "./engine-types"

/** What the backend accepts as an unserved key's detail: a code and, for
 * spawn failures, the basename of the command. Never the engine's raw error
 * text, which can name paths and hosts. */
export type AttachReportDetail = { code: string; command?: string }

export type AttachReportUnfulfilled = {
  key: string
  integration_id: string
  reason: string
  detail?: AttachReportDetail
}

export type AttachReportOutcome = "attached" | "engine-missing" | "engine-too-old" | "connect-failed"

export type AttachReport = {
  binding_key: string
  outcome: AttachReportOutcome
  cli_version: string
  engine_version: string | null
  bridge_connected: boolean
  declared_keys: string[]
  delivered_keys: string[]
  unfulfilled: AttachReportUnfulfilled[]
  reported_at: string
}

/** The identity the server binding row already carries: the git remote when
 * the project has one, else its absolute path. Nothing new about the machine
 * leaves it. */
export function bindingKey(binding: { repoRemote: string | null; projectPath: string | null }): string | null {
  return binding.repoRemote || binding.projectPath || null
}

const CODES: Array<[RegExp, string]> = [
  [/\bENOENT\b/, "ENOENT"],
  [/\bEACCES\b|\bEPERM\b/, "EACCES"],
  [/\bETIMEDOUT\b|timed? ?out/i, "ETIMEDOUT"],
  [/\bECONNREFUSED\b/, "ECONNREFUSED"],
  [/invalid url/i, "invalid-url"],
]

/** A code for an error string, never the string. */
export function errorCode(text: string): string {
  return CODES.find(([re]) => re.test(text))?.[1] ?? "other"
}

/** Reduce an engine detail to what may leave the machine. For a spawn
 * failure the spawned command's basename is kept (`spawn /Users/x/bin/docker
 * ENOENT` → `docker`); the directory, and everything else, is dropped. */
export function sanitizeDetail(detail: string | undefined, reason: string): AttachReportDetail | undefined {
  if (!detail) return undefined
  const code = errorCode(detail)
  if (reason !== "spawn-failed") return { code }
  const match = /\bspawn\s+(\S+)/.exec(detail)
  const command = match ? match[1].split(/[\\/]/).pop() : undefined
  return command ? { code, command } : { code }
}

function sanitizeUnfulfilled(entries: Unfulfilled[]): AttachReportUnfulfilled[] {
  return entries.map((u) => {
    const detail = sanitizeDetail(u.detail, u.reason)
    return { key: u.key, integration_id: u.integrationId, reason: u.reason, ...(detail ? { detail } : {}) }
  })
}

export type AttachReportInput = {
  outcome: Outcome
  bindingKey: string
  cliVersion: string
  /** The probed engine version, when the engine ran at all. */
  engineVersion: string | null
  declared: Declared | null
  /** Keys the engine served under the workspace key (attached only). */
  present?: Set<string>
  bridgeConnected: boolean
  reportedAt: string
}

/** The report for a settled outcome, or null for outcomes that are not about
 * the engine at all (disabled, unbound). */
export function buildAttachReport(input: AttachReportInput): AttachReport | null {
  const { outcome, declared } = input
  const declaredKeys = declared ? [...declared.keys, ...declared.extensionKeys] : []
  const base = {
    binding_key: input.bindingKey,
    cli_version: input.cliVersion,
    bridge_connected: input.bridgeConnected,
    declared_keys: declaredKeys,
    delivered_keys: [] as string[],
    unfulfilled: [] as AttachReportUnfulfilled[],
    reported_at: input.reportedAt,
  }
  switch (outcome.kind) {
    case "attached": {
      const present = input.present ?? new Set<string>()
      const delivered = declared ? declaredKeys.filter((k) => present.has(k)) : [...present]
      return {
        ...base,
        outcome: "attached",
        engine_version: input.engineVersion,
        delivered_keys: delivered,
        unfulfilled: sanitizeUnfulfilled(outcome.unfulfilled ?? []),
      }
    }
    case "engine-missing":
      return { ...base, outcome: "engine-missing", engine_version: null }
    case "engine-too-old":
      return { ...base, outcome: "engine-too-old", engine_version: outcome.found }
    case "connect-failed":
      return { ...base, outcome: "connect-failed", engine_version: input.engineVersion }
    default:
      return null
  }
}

/** Everything that would make the backend row different — so an identical
 * re-attach does not post again, and a changed reason or version does. */
export function attachReportSignature(report: AttachReport): string {
  const { reported_at: _at, ...rest } = report
  return JSON.stringify(rest)
}

/** Post a report; fire-and-forget by contract. A failure is logged once at
 * debug and never reaches the user or the turn. */
export async function postAttachReport(datamateId: string, report: AttachReport): Promise<void> {
  try {
    if (syncInternals.reportAttach) return await syncInternals.reportAttach(datamateId, report)
    if (!(await AltimateApi.isConfigured())) return
    await AltimateApi.postAttachReport(datamateId, report)
  } catch (err) {
    log.debug("attach report not posted", { datamateId, err: String(err) })
  }
}
