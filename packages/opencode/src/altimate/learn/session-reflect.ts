// altimate_change - new file
//
// The reflect pipeline shared by `learn reflect`, `learn reflect --pending` and the auto-reflect hook at
// the end of `run`: digest -> reflector -> curator -> candidate + history. Kept free of CLI and Effect
// so it can run in-process with an injected `generate`.
import path from "node:path"
import * as Playbook from "./playbook"
import * as Store from "./store"
import * as Signals from "./signals"
import { curate, flagSuspiciousFeedback, type CurateResult } from "./curator"
import { buildDigest, sourceFromMessages, type DigestSource } from "./digest"
import { reflect, type FeedbackKind, type Generate } from "./reflect"

/** Named errors (e.g. ModelNotFoundError) carry their detail in `data`, not `message`. */
export function errText(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const data = (e as { data?: unknown }).data
  if (e.message && e.message !== e.name) return e.message
  return data ? `${e.name}: ${JSON.stringify(data)}` : e.name
}

export interface ReflectCoreInput {
  root: string
  name: string
  source: DigestSource
  feedback: string
  kind: FeedbackKind
  /** Session id or trajectory path: scopes the distinct-feedback count. */
  origin: string
  session?: string
  generate: Generate
  applyPaths?: string[]
  /** Shown in the error when the model call fails, e.g. `--model x` or `the default model`. */
  modelLabel?: string
}

export interface ReflectCoreResult {
  curated: CurateResult
  proposed: number
  flagged: string | undefined
  history: Awaited<ReturnType<typeof Store.appendHistory>>
}

export async function reflectCore(input: ReflectCoreInput): Promise<ReflectCoreResult> {
  const { root, name } = input
  const flagged = flagSuspiciousFeedback(input.feedback)
  const digest = buildDigest(input.source)
  const pb = await Store.loadCandidate(root, name, { applyPaths: input.applyPaths })
  const deltas = await reflect(
    { digest, feedback: input.feedback, kind: input.kind, bullets: Playbook.bullets(pb) },
    input.generate,
  ).catch((e) => {
    throw new Error(`Model call failed (${input.modelLabel ?? "the default model"}): ${errText(e)}`)
  })
  const curated = curate(Playbook.bullets(pb), deltas, {
    feedbackId: Store.feedbackId(input.feedback, input.origin),
    harmfulFrom: await Store.readHarmfulFrom(root, name),
  })
  if (curated.applied.length > 0) await Store.saveCandidate(root, name, Playbook.withBullets(pb, curated.next))
  await Store.writeHarmfulFrom(root, name, curated.harmfulFrom)
  const history = await Store.appendHistory(root, name, {
    action: "reflect",
    session: input.session,
    feedbackKind: input.kind,
    feedbackHash: Store.sha256(input.feedback),
    feedbackFlagged: flagged ? true : undefined,
    applied: curated.applied,
    rejected: curated.rejected,
  })
  return { curated, proposed: deltas.length, flagged, history }
}

export async function sourceFromSession(sessionID: string): Promise<DigestSource> {
  const { Session } = await import("../../session")
  const { SessionID } = await import("../../session/schema")
  const sid = SessionID.make(sessionID)
  try {
    await Session.get(sid)
  } catch {
    throw new Error(`Session not found: ${sessionID}. For a session from another project, use --trajectory.`)
  }
  return sourceFromMessages(await Session.messages({ sessionID: sid }))
}

export interface ReflectSessionInput {
  root: string
  name: string
  sessionID: string
  /** Called only when the session has open signals, so a model is not resolved for nothing. */
  getGenerate: () => Promise<Generate>
  applyPaths?: string[]
  modelLabel?: string
  loadSource?: (sessionID: string) => Promise<DigestSource>
}

export type ReflectSessionResult =
  | { status: "none" }
  | { status: "done"; result: ReflectCoreResult; signals: Signals.Signal[]; kind: FeedbackKind }

/**
 * Reflects on a session's open signals. They are marked consumed (by the history entry) only after the
 * reflection succeeded; any failure leaves them open for a retry.
 */
export async function reflectSessionSignals(input: ReflectSessionInput): Promise<ReflectSessionResult> {
  await Signals.flushWrites()
  const signals = await Signals.listSignals(input.root, { session: input.sessionID })
  if (signals.length === 0) return { status: "none" }
  const { kind, text } = Signals.feedbackFromSignals(signals)
  // Review and CI signals can come from an integration with no local session: reflect on the text alone.
  const external = signals.every((s) => s.kind === "review" || s.kind === "ci")
  const load = input.loadSource ?? sourceFromSession
  const source = await load(input.sessionID).catch((e) => {
    if (external) return { prompts: [], calls: [] } as DigestSource
    throw e
  })
  const generate = await input.getGenerate()
  const result = await reflectCore({
    root: input.root,
    name: input.name,
    source,
    feedback: text,
    kind,
    origin: input.sessionID,
    session: input.sessionID,
    generate,
    applyPaths: input.applyPaths,
    modelLabel: input.modelLabel,
  })
  await Signals.consumeSignals(
    input.root,
    signals.map((s) => s.id),
    `reflect@${result.history.ts}`,
  )
  return { status: "done", result, signals, kind }
}

export const candidatePath = (root: string, name: string) => path.relative(root, Store.paths(root, name).candidate)
