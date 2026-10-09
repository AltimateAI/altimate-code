// altimate_change - new file
import { constants } from "node:fs"
import fs from "node:fs/promises"
import * as SafeFS from "./safe-fs"
import path from "node:path"
import z from "zod"
import { Log } from "@/util/log"
import { lint, MAX_TEXT, normalizeText } from "./curator"
import { redactSecrets } from "./digest"
import { Lesson, canonical, parse } from "./lesson"
import { assertLearnLock } from "./lock"
import { validateName } from "./playbook"
import { estimateTokens, fileHookEnabled, lessonLine, renderSection, resolveLimits, retrieve, selectFile, selectStart, type Limits } from "./select"
import * as Store from "./store"
import { effectiveLessons, resolve, type Source } from "./effective"
import { identityKey, readOutbox, readRemote, remoteFor, Scope, sameScope, scopeKey, writeOutbox, type Identity } from "./ledger"
import type { RemoteView } from "./sync"

const log = Log.create({ service: "learn.delivery" })
const LOCK_OPTIONS = { timeoutMs: 5000 }
const singleLine = (text: string) => normalizeText(text.replace(/[\s\u0085]+/g, " ")).trim()

function sanitize(name: string, lesson: Lesson, grandfathered: Pick<Lesson, "id" | "text">[] = []): Lesson | undefined {
  const text = singleLine(lesson.text)
  const paths = lesson.trigger?.paths?.map(singleLine)
  const reason = lint(text, { grandfathered: grandfathered.some((old) => old.id === lesson.id && singleLine(old.text) === text) })
  if (reason) {
    log.warn("learn lesson skipped", { name, id: lesson.id, reason })
    return
  }
  for (const trigger of paths ?? []) {
    const reason = lint(trigger)
    if (!reason) continue
    log.warn("learn lesson skipped", { name, id: lesson.id, reason: `path trigger ${reason}` })
    return
  }
  return { ...lesson, text, ...(paths ? { trigger: { paths } } : {}) }
}

const IdentitySchema = z.object({ repo_identity: z.string().nullable(), store: z.string(), lesson_key: z.string() })
const Shown = z.object({
  name: z.string(),
  lesson: Lesson,
  tier: z.enum(["core", "retrieved", "request", "file"]),
  at: z.string(),
  queryHash: z.string(),
  // Sync (effective.ts): where the lesson came from, its qualified identity, and for team lessons the exact
  // revision delivered and the scope it was pulled for. Absent on local lessons delivered without sync.
  source: z.enum(["local", "remote"]).optional(),
  identity: IdentitySchema.optional(),
  public_id: z.string().optional(),
  version: z.number().int().optional(),
  scope: Scope.optional(),
})
type Shown = z.infer<typeof Shown>
const State = z.object({
  version: z.literal(1),
  session: z.string(),
  firstMessage: z.string(),
  query: z.string().default(""),
  touchedPaths: z.array(z.string()).default([]),
  section: z.string(),
  shown: z.array(Shown),
  requests: z.array(z.object({ message: z.string(), note: z.string() })),
  requestParts: z.array(z.object({ message: z.string(), id: z.string(), text: z.string() })).default([]),
  compactions: z.array(z.string()),
  counted: z.array(z.string()),
  /** Fingerprint of the sync view this state was last reconciled with. */
  remote: z.string().optional(),
})
type State = z.infer<typeof State>
type Approved = { name: string; lesson: Lesson; source?: Source; identity?: Identity; public_id?: string; version?: number; scope?: Scope }
// Stage 1 IDs are unique within a named store, not across the project's stores.
const identity = (name: string, id: string) => `${id}/${name}`
const corpus = (approved: Approved[]) => approved.map(({ name, lesson }) => ({ ...lesson, id: identity(name, lesson.id) }))
const Flush = z.object({
  session: z.string(),
  lessons: z.array(z.object({ name: z.string(), id: z.string(), applied: z.number().int().nonnegative() })),
  /** Team lessons counted through an outbox usage batch, never through local usage.json. */
  remote: z.array(z.object({ name: z.string(), id: z.string() })).default([]),
})
export type Prepared = { section: string; requestNote: string }
const EMPTY: Prepared = { section: "", requestNote: "" }

/** Remove lesson lines from a rendered section or note; a heading left without lessons is no section at all. */
function dropLines(text: string, lines: ReadonlySet<string>): string {
  if (!text) return text
  const [heading, ...body] = text.split("\n")
  const kept = body.filter((line) => !lines.has(line))
  if (kept.length === body.length) return text
  return kept.length ? [heading, ...kept].join("\n") : ""
}

/** A stable RFC 4122-shaped id from a hex digest (the server only requires a UUID). */
function uuidFrom(hex: string): string {
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function read(root: string, file: string) {
  try {
    await SafeFS.assertSafePath(root, file)
    await fs.access(file)
    return await fs.readFile(file, "utf8")
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** Persisted text snapshots keep the prefix stable even after edits, ranking changes or a restart. */
export class Delivery {
  private resolved?: Limits
  private readonly dir: string
  private enabled = false
  private changes = 0

  get active() { return this.enabled }
  get limits() { return this.resolved ??= resolveLimits(this.config) }
  /** Bumped whenever reconciliation rewrites a session's frozen section or request notes. */
  get generation() { return this.changes }

  /** `remote` is set only when lesson sync is on; without it delivery is exactly local. */
  constructor(readonly root: string, private readonly config: Partial<Limits> & { file_hook?: boolean } = {}, readonly directory = root, private readonly remote?: RemoteView) {
    this.dir = path.join(root, ".altimate-code", "learn")
  }

  async hasSession(session: string): Promise<boolean> {
    try {
      await SafeFS.assertSafePath(this.root, this.stateFile(session))
      await fs.access(this.stateFile(session))
      this.enabled = true
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      log.warn("learn session lookup skipped", { error })
      return false
    }
  }

  async section(session: string): Promise<string> {
    return this.sectionChecked(session).catch((error) => {
      log.warn("learn section skipped", { error })
      return ""
    })
  }

  private async sectionChecked(session: string): Promise<string> {
    const state = await this.state(session)
    if (!state) return ""
    this.enabled = true
    return state.section
  }

  private async exists() {
    try { await fs.access(this.dir); await SafeFS.assertSafePath(this.root, this.dir); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  private stateFile(session: string) {
    return path.join(this.dir, ".sessions", Store.sha256(session) + ".json")
  }

  private async state(session: string, validate = true) {
    const raw = await read(this.root, this.stateFile(session))
    if (raw === undefined) return undefined
    const state = State.parse(JSON.parse(raw))
    if (state.session !== session) throw new Error("Learn session state belongs to another session")
    // Attribution needs only IDs/counters and must survive a snapshot failing prompt checks.
    if (!validate) return state
    // Older versions froze unchecked content. Rebuild unsafe snapshots on the next prepare;
    // valid snapshots retain their byte-identical prefix across resume and approved edits.
    const grandfathered = new Map<string, Pick<Lesson, "id" | "text">[]>()
    for (const { name, lesson } of state.shown) {
      if (lesson.text.length > MAX_TEXT && !grandfathered.has(name))
        grandfathered.set(name, await Store.grandfathered(this.root, name, { migrate: false }).catch(() => []))
      const safe = sanitize(name, lesson, grandfathered.get(name))
      if (safe && safe.text === lesson.text && JSON.stringify(safe.trigger) === JSON.stringify(lesson.trigger)) continue
      log.warn("learn unsafe session snapshot skipped", { session })
      return undefined
    }
    await this.validateStatePaths(state)
    return state
  }

  private async approved(): Promise<Approved[]> {
    const result: Approved[] = []
    const names = (await fs.readdir(this.dir, { withFileTypes: true }))
      .filter((entry) => {
        if (entry.isSymbolicLink()) log.warn("learn symlinked store skipped", { name: entry.name })
        return entry.isDirectory()
      }).map((entry) => entry.name).sort()
    for (const name of names) {
      try { validateName(name) } catch { continue }
      // Read approved snapshots directly: migration/capture may write, and merely opening a
      // candidate-only project must not mutate it. Capture being off does NOT disable these
      // rules: a person already approved them. An unused project only pays the existence check.
      try {
        const raw = await read(this.root, Store.paths(this.root, name).approved)
        const scope = this.remote?.scope()
        const remote = await remoteFor(this.root, name, scope)
        if (raw === undefined && !remote) continue
        await SafeFS.assertSafePath(this.root, Store.paths(this.root, name).usage)
        await SafeFS.assertSafePath(this.root, path.join(Store.paths(this.root, name).learnDir, "shown.jsonl"))
        const lessons = raw === undefined ? [] : await Store.mergeUsage(this.root, name, parse(raw))
        const grandfathered = lessons.some((lesson) => lesson.text.length > MAX_TEXT)
          ? await Store.grandfathered(this.root, name, { migrate: false }) : []
        // Team lessons carry server counters, which are never merged into local usage.
        for (const entry of effectiveLessons(name, lessons, remote)) {
          const safe = sanitize(name, entry.lesson, entry.source === "local" ? grandfathered : [])
          if (!safe) continue
          result.push({
            name, lesson: safe, ...(remote ? { source: entry.source } : {}), ...(entry.identity ? { identity: entry.identity } : {}),
            ...(entry.remote ? { public_id: entry.remote.public_id, version: entry.remote.version, scope } : {}),
          })
        }
      } catch (error) {
        if (error instanceof SafeFS.UnsafeLearnPathError) throw error
        log.warn("learn approved store skipped", { name, error })
      }
    }
    return result
  }

  private async validateStatePaths(state: State) {
    await SafeFS.assertSafePath(this.root, this.stateFile(state.session))
    await SafeFS.assertSafePath(this.root, path.join(this.dir, ".flush.json"))
    for (const name of new Set(state.shown.map((entry) => entry.name))) {
      const p = Store.paths(this.root, name)
      await SafeFS.assertSafePath(this.root, p.usage)
      await SafeFS.assertSafePath(this.root, path.join(p.learnDir, "shown.jsonl"))
    }
  }

  private async save(state: State) {
    await this.validateStatePaths(state)
    await assertLearnLock(this.root)
    await SafeFS.mkdir(this.root, path.dirname(this.stateFile(state.session)))
    await Store.writeAtomic(this.root, this.stateFile(state.session), canonical(state))
  }

  /** Replay missing records after a restart; state is persisted before append-only attribution. */
  private async log(state: State) {
    for (const name of new Set(state.shown.map((entry) => entry.name))) {
      try {
        const file = path.join(Store.paths(this.root, name).learnDir, "shown.jsonl")
        const raw = await read(this.root, file) ?? ""
        const logged = new Set<string>()
        for (const line of raw.split("\n").filter(Boolean)) {
          try {
            const record = JSON.parse(line)
            if (typeof record?.session !== "string" || typeof record?.id !== "string") throw new Error("Invalid shown record")
            logged.add(`${record.session}\0${record.id}`)
          } catch { log.warn("learn shown record skipped", { name }) }
        }
        const missing = state.shown.filter((entry) => entry.name === name && !logged.has(`${state.session}\0${entry.lesson.id}`))
        if (!missing.length) continue
        await assertLearnLock(this.root)
        await SafeFS.mkdir(this.root, path.dirname(file))
        await assertLearnLock(this.root)
        // Separate a torn trailing record from the next valid append.
        const handle = await SafeFS.open(this.root, file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600)
        try {
          await handle.appendFile((raw && !raw.endsWith("\n") ? "\n" : "") + missing.map(({ lesson, tier, at, queryHash }) =>
            JSON.stringify({ session: state.session, id: lesson.id, tier, at, queryHash }) + "\n").join(""))
        } finally { await handle.close() }
      } catch (error) {
        if (error instanceof SafeFS.UnsafeLearnPathError) throw error
        // Attribution is replayable from state; its failure must not swallow the prepared rules.
        log.warn("learn shown log failed", { name, error })
      }
    }
  }

  private add(state: State, approved: Approved[], lessons: Lesson[], tier: Shown["tier"], query: string) {
    const shown = new Set(state.shown.map((entry) => identity(entry.name, entry.lesson.id)))
    const at = new Date().toISOString()
    const added: Lesson[] = []
    for (const lesson of lessons) {
      if (state.shown.length >= this.limits.session_max_lessons) break
      if (shown.has(lesson.id)) continue
      const original = approved.find((entry) => identity(entry.name, entry.lesson.id) === lesson.id)!
      state.shown.push({ ...original, tier, at, queryHash: Store.sha256(query) })
      shown.add(lesson.id)
      added.push(original.lesson)
    }
    return added
  }

  private mentionedPaths(query: string) {
    // Paths mentioned for creation count too; never traverse the project tree.
    const found = new Set<string>()
    query = query.replace(/\\/g, "/")
    const words = [
      ...[...query.matchAll(/(?:[\w@./-]+\/)?[\w@.-]+(?:\.[\w.-]+|\/[\w@./-]+)/g)].map((match) => match[0]),
      ...[...query.matchAll(/[`"']([^`"'\n]+)[`"']/g)].map((match) => match[1]).filter((word) => /[./]/.test(word)),
    ]
    const candidates = new Set(words.flatMap((word) => {
      const candidate = word.replace(/[.,:;]+$/, "")
      return candidate.startsWith("@") ? [candidate, candidate.slice(1)] : [candidate]
    }))
    for (const candidate of candidates) {
      for (const base of new Set([this.directory, this.root])) {
        const absolute = path.resolve(base, candidate)
        const relative = path.relative(this.root, absolute)
        if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) continue
        found.add(relative.split(path.sep).join("/"))
      }
    }
    return [...found].sort()
  }

  private async initialQuery(query: string) {
    const found = new Set<string>()
    for (const relative of this.mentionedPaths(query)) {
      const stat = await fs.stat(path.resolve(this.root, relative)).catch(() => undefined)
      if (stat?.isFile()) found.add(relative)
    }
    return found.size ? `${query}\n${[...found].sort().join("\n")}` : query
  }

  async prepare(session: string, message: string, query: string): Promise<Prepared> {
    return this.prepareChecked(session, message, query).catch((error) => {
      log.warn("learn prepare skipped", { error })
      return { ...EMPTY }
    })
  }

  /** Provenance lives in server-side state, never in client-editable message metadata. */
  async requestParts(session: string, message: string) {
    return (await this.state(session, false))?.requestParts.filter((part) => part.message === message) ?? []
  }

  async recordRequestPart(session: string, message: string, id: string, text: string) {
    await Store.transaction(this.root, async () => {
      const state = await this.state(session, false)
      if (!state) throw new Error("Learn request part requires delivery session state")
      state.requestParts.push({ message, id, text })
      await this.save(state)
    }, LOCK_OPTIONS)
  }

  private async prepareChecked(session: string, message: string, query: string): Promise<Prepared> {
    if (!await this.exists()) return { ...EMPTY }
    // Do not acquire the filesystem lock until there is existing delivery state or approved content.
    if (!await this.state(session) && !(await this.approved()).length) return { ...EMPTY }
    this.enabled = true
    const redactedQuery = redactSecrets(query)
    return Store.transaction(this.root, async () => {
      let state = await this.state(session)
      if (state) {
        const previous = state.requests.find((request) => request.message === message)
        if (previous) {
          if (state.query !== redactedQuery) {
            state.query = redactedQuery
            await this.save(state)
          }
          await this.log(state)
          const requestNote = estimateTokens(previous.note) <= this.limits.budget_tokens ? previous.note : ""
          if (previous.note && !requestNote) log.warn("learn cached request note exceeds budget", { session, message })
          return { section: state.section, requestNote }
        }
      }
      const approved = await this.approved()
      if (!state && !approved.length) return { ...EMPTY }
      if (!state) {
        // Count earlier deliveries before replacing an unsafe snapshot; retain the session ledger
        // so selecting its approved replacement cannot count the same ID twice.
        await this.flush(session)
        const previous = await this.state(session, false)
        if (previous?.shown.some((entry) => !previous.counted.includes(identity(entry.name, entry.lesson.id))))
          throw new Error("Learn snapshot attribution could not be preserved")
        const initialQuery = await this.initialQuery(query)
        const start = selectStart(corpus(approved), initialQuery, this.limits)
        state = { version: 1, session, firstMessage: message, query: redactedQuery, touchedPaths: previous?.touchedPaths ?? [], section: start.section, shown: [], requests: [], requestParts: previous?.requestParts ?? [], compactions: [], counted: previous?.counted ?? [] }
        for (const item of start.lessons) this.add(state, approved, [item.lesson], item.tier, initialQuery)
        state.requests.push({ message, note: "" })
      } else {
        state.query = redactedQuery
        const matches = retrieve(corpus(approved), query, {
          limit: Math.min(this.limits.request_lessons, Math.max(0, this.limits.session_max_lessons - state.shown.length)),
          exclude: state.shown.map((entry) => identity(entry.name, entry.lesson.id)),
          paths: [...state.touchedPaths, ...this.mentionedPaths(query)],
        })
        const rendered = renderSection(matches, this.limits.budget_tokens, "Team rules for this request:")
        this.add(state, approved, rendered.lessons, "request", query)
        state.requests.push({ message, note: rendered.section })
      }
      await this.save(state)
      await this.log(state)
      return { section: state.section, requestNote: state.requests.find((request) => request.message === message)!.note }
    }, LOCK_OPTIONS)
  }

  /**
   * Re-check every lesson this session was shown against the current sync view, by qualified identity and
   * whatever its source: a tombstone or an approved replacement for that identity, narrowed sharing, a changed
   * scope or account, or sync turned off. Ineligible lessons leave the frozen section and the request notes;
   * message history already sent is not rewritten. A no-op (no lock, no write) when nothing changed.
   */
  async reconcile(session: string): Promise<boolean> {
    return this.reconcileChecked(session).catch((error) => {
      log.warn("learn reconcile skipped", { error })
      return false
    })
  }

  private async fingerprint(names: string[]): Promise<string> {
    const scope = this.remote?.scope()
    const parts: string[] = [scope ? scopeKey(scope) : "off"]
    for (const name of names) {
      const remote = scope ? await readRemote(this.root, name).catch(() => undefined) : undefined
      parts.push(name, remote && sameScope(remote.scope, scope) ? `${remote.revision}|${remote.pulled_at}` : "-")
    }
    return Store.sha256(JSON.stringify(parts))
  }

  private async reconcileChecked(session: string): Promise<boolean> {
    if (!await this.exists()) return false
    const current = await this.state(session)
    // Without sync and without team lessons shown, there is nothing to reconcile: local delivery stays frozen.
    if (!current || (!this.remote && !current.shown.some((entry) => entry.source === "remote"))) return false
    const names = [...new Set(current.shown.map((entry) => entry.name))].sort()
    const fingerprint = await this.fingerprint(names)
    if (current.remote === fingerprint) return false
    return Store.transaction(this.root, async () => {
      const state = await this.state(session)
      if (!state) return false
      const scope = this.remote?.scope()
      const removed: Shown[] = []
      for (const name of names) {
        const remote = await remoteFor(this.root, name, scope)
        const entries = state.shown.filter((entry) => entry.name === name)
        const hidden = resolve(name, entries.filter((entry) => entry.source !== "remote").map((entry) => entry.lesson.id), remote).hidden
        const live = new Set((remote?.lessons ?? []).map((lesson) =>
          `${identityKey({ repo_identity: lesson.repo_identity, store: lesson.store, lesson_key: lesson.lesson_key })}|${lesson.public_id}`))
        for (const entry of entries) {
          const eligible = entry.source === "remote"
            ? !!entry.identity && !!entry.public_id && sameScope(entry.scope, scope) && live.has(`${identityKey(entry.identity)}|${entry.public_id}`)
            : !hidden.has(entry.lesson.id)
          if (!eligible) removed.push(entry)
        }
      }
      state.remote = fingerprint
      if (removed.length) {
        const lines = new Set(removed.map((entry) => lessonLine(entry.lesson)))
        state.shown = state.shown.filter((entry) => !removed.includes(entry))
        state.section = dropLines(state.section, lines)
        state.requests = state.requests.map((request) => ({ ...request, note: dropLines(request.note, lines) }))
        this.changes++
        log.info("learn delivery reconciled", { session, removed: removed.length })
      }
      await this.save(state)
      return removed.length > 0
    }, LOCK_OPTIONS)
  }

  async compact(session: string, marker: string): Promise<string | undefined> {
    return this.compactChecked(session, marker).catch((error) => {
      log.warn("learn compaction skipped", { error })
      return undefined
    })
  }

  private async compactChecked(session: string, marker: string): Promise<string | undefined> {
    if (!await this.exists()) return ""
    if (!await this.state(session)) return ""
    this.enabled = true
    return Store.transaction(this.root, async () => {
      const state = (await this.state(session))!
      if (!state.compactions.includes(marker)) {
        state.section = renderSection(state.shown.map((entry) => entry.lesson), this.limits.budget_tokens).section
        state.compactions.push(marker)
        await this.save(state)
      }
      await this.log(state)
      return state.section
    }, LOCK_OPTIONS)
  }

  async file(session: string, file: string): Promise<string> {
    return this.fileChecked(session, file).catch((error) => {
      log.warn("learn file delivery skipped", { error })
      return ""
    })
  }

  private async fileChecked(session: string, file: string): Promise<string> {
    if (!await this.exists()) return ""
    if (!await this.state(session)) return ""
    return Store.transaction(this.root, async () => {
      const state = (await this.state(session))!
      const relative = path.relative(this.root, path.resolve(this.directory, file.replace(/\\/g, "/"))).split(path.sep).join("/")
      if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return ""
      const touched = !state.touchedPaths.includes(relative)
      if (touched) state.touchedPaths.push(relative)
      if (!fileHookEnabled(this.config) || this.limits.file_lessons === 0 || state.shown.length >= this.limits.session_max_lessons) {
        if (touched) await this.save(state)
        return ""
      }
      const approved = await this.approved()
      const matches = selectFile(corpus(approved), relative, state.query, {
        limit: Math.min(this.limits.file_lessons, this.limits.session_max_lessons - state.shown.length),
        exclude: state.shown.map((entry) => identity(entry.name, entry.lesson.id)),
      })
      const rendered = renderSection(matches, this.limits.budget_tokens, `Team rules for ${singleLine(relative)}:`)
      const added = this.add(state, approved, rendered.lessons, "file", relative)
      if (touched || added.length) await this.save(state)
      if (!added.length) return ""
      await this.log(state)
      return rendered.section
    }, LOCK_OPTIONS)
  }

  /** Share executed-path selection between direct calls and batch inner calls. */
  async appendFileLessons(session: string, tool: string, args: Record<string, unknown>, result: { output: string; metadata?: unknown }): Promise<void> {
    if (!["read", "edit", "write", "patch", "apply_patch"].includes(tool)) return
    try {
      const paths: string[] = []
      if (typeof args.filePath === "string") paths.push(args.filePath)
      const changed = (result.metadata as { files?: { filePath: string; movePath?: string }[] } | undefined)?.files
      for (const file of changed ?? []) paths.push(file.filePath, ...(file.movePath ? [file.movePath] : []))
      for (const file of new Set(paths)) {
        const note = await this.file(session, file)
        if (note) result.output += `\n\n${note}`
      }
    } catch (error) {
      log.warn("learn file selection failed", { error })
    }
  }

  private async finishFlush() {
    const file = path.join(this.dir, ".flush.json")
    const raw = await read(this.root, file)
    if (raw === undefined) return
    const flush = Flush.parse(JSON.parse(raw))
    for (const name of new Set(flush.lessons.map((entry) => entry.name))) {
      const p = Store.paths(this.root, name)
      const usage = await Store.readUsage(this.root, name)
      const targets = new Map(flush.lessons.filter((entry) => entry.name === name).map((entry) => [entry.id, entry.applied]))
      let changed = false
      for (const [id, applied] of targets) {
        if ((usage[id] ?? 0) >= applied) continue
        usage[id] = applied
        changed = true
      }
      if (changed) {
        await assertLearnLock(this.root)
        await SafeFS.mkdir(this.root, p.learnDir)
        await Store.writeAtomic(this.root, p.usage, canonical(usage))
      }
    }
    const state = await this.state(flush.session, false)
    if (state) {
      state.counted = [...new Set([...state.counted, ...[...flush.lessons, ...flush.remote].map((entry) => identity(entry.name, entry.id))])]
      await this.save(state)
    }
    await assertLearnLock(this.root)
    await SafeFS.remove(this.root, file)
  }

  /**
   * Team lessons are counted on the server by the exact revision delivered (`public_id`), through an outbox
   * usage batch. The batch id is derived from the session and the revisions, so a flush retried after a crash
   * queues the same batch and the server counts it once.
   */
  private async queueUsage(session: string, name: string, entries: Shown[]) {
    const batches = new Map<string, { scope: Scope; items: Map<string, number> }>()
    for (const entry of entries) {
      if (!entry.public_id || !entry.scope) continue
      const key = scopeKey(entry.scope)
      const batch = batches.get(key) ?? { scope: entry.scope, items: new Map() }
      batch.items.set(entry.public_id, Math.min(50, (batch.items.get(entry.public_id) ?? 0) + 1))
      batches.set(key, batch)
    }
    if (!batches.size) return
    const outbox = await readOutbox(this.root, name)
    for (const [key, batch] of batches) {
      const ids = [...batch.items.keys()].sort()
      const batchId = uuidFrom(Store.sha256(JSON.stringify([session, name, key, ids])))
      if (outbox.usage.some((usage) => usage.batch_id === batchId)) continue
      outbox.usage.push({
        batch_id: batchId, scope: batch.scope, created_at: new Date().toISOString(),
        items: ids.map((id) => ({ public_id: id, applied: batch.items.get(id)!, helpful: 0, harmful: 0 })),
      })
    }
    await writeOutbox(this.root, name, outbox)
  }

  /** Update usage only on a harness flush; never feed changing counters into the frozen prompt. */
  async flush(session: string): Promise<void> {
    return this.flushChecked(session).catch((error) => {
      log.warn("learn flush skipped", { error })
      return undefined
    })
  }

  private async flushChecked(session: string): Promise<void> {
    if (!await this.exists() || !await this.state(session, false)) return
    await Store.transaction(this.root, async () => {
      // One project-wide journal is replayed before the next flush computes absolute targets.
      // Retrying after any store/state write boundary cannot count the same lesson twice.
      await this.finishFlush()
      const state = (await this.state(session, false))!
      const pending = state.shown.filter((entry) => !state.counted.includes(identity(entry.name, entry.lesson.id)))
      if (!pending.length) return
      // Count the snapshots actually returned, even if approved content was removed or became
      // unreadable afterward. Local usage supplies any increments from other sessions.
      const targets: z.infer<typeof Flush>["lessons"] = []
      const remote: z.infer<typeof Flush>["remote"] = []
      for (const name of new Set(pending.map((entry) => entry.name))) {
        const lessons = pending.filter((entry) => entry.name === name && entry.source !== "remote").map((entry) => entry.lesson)
        for (const lesson of await Store.mergeUsage(this.root, name, lessons))
          targets.push({ name, id: lesson.id, applied: lesson.applied + 1 })
        const team = pending.filter((entry) => entry.name === name && entry.source === "remote")
        remote.push(...team.map((entry) => ({ name, id: entry.lesson.id })))
        await this.queueUsage(session, name, team)
      }
      await Store.writeAtomic(this.root, path.join(this.dir, ".flush.json"), canonical({ session, lessons: targets, remote }))
      await this.finishFlush()
      await this.log((await this.state(session, false))!)
    }, LOCK_OPTIONS)
  }
}
