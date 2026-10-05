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
import { estimateTokens, fileHookEnabled, renderSection, resolveLimits, retrieve, selectFile, selectStart, type Limits } from "./select"
import * as Store from "./store"

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

const Shown = z.object({
  name: z.string(),
  lesson: Lesson,
  tier: z.enum(["core", "retrieved", "request", "file"]),
  at: z.string(),
  queryHash: z.string(),
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
  compactions: z.array(z.string()),
  counted: z.array(z.string()),
})
type State = z.infer<typeof State>
type Approved = { name: string; lesson: Lesson }
// Stage 1 IDs are unique within a named store, not across the project's stores.
const identity = (name: string, id: string) => `${id}/${name}`
const corpus = (approved: Approved[]) => approved.map(({ name, lesson }) => ({ ...lesson, id: identity(name, lesson.id) }))
const Flush = z.object({
  session: z.string(),
  lessons: z.array(z.object({ name: z.string(), id: z.string(), applied: z.number().int().nonnegative() })),
})
export type Prepared = { section: string; requestNote: string }
const EMPTY: Prepared = { section: "", requestNote: "" }

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

  get active() { return this.enabled }
  get limits() { return this.resolved ??= resolveLimits(this.config) }

  constructor(readonly root: string, private readonly config: Partial<Limits> & { file_hook?: boolean } = {}, readonly directory = root) {
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
        if (raw === undefined) continue
        await SafeFS.assertSafePath(this.root, Store.paths(this.root, name).usage)
        await SafeFS.assertSafePath(this.root, path.join(Store.paths(this.root, name).learnDir, "shown.jsonl"))
        const lessons = await Store.mergeUsage(this.root, name, parse(raw))
        const grandfathered = lessons.some((lesson) => lesson.text.length > MAX_TEXT)
          ? await Store.grandfathered(this.root, name, { migrate: false }) : []
        for (const lesson of lessons) {
          const safe = sanitize(name, lesson, grandfathered)
          if (safe) result.push({ name, lesson: safe })
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
        state = { version: 1, session, firstMessage: message, query: redactedQuery, touchedPaths: previous?.touchedPaths ?? [], section: start.section, shown: [], requests: [], compactions: [], counted: previous?.counted ?? [] }
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
      state.counted = [...new Set([...state.counted, ...flush.lessons.map((entry) => identity(entry.name, entry.id))])]
      await this.save(state)
    }
    await assertLearnLock(this.root)
    await SafeFS.remove(this.root, file)
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
      for (const name of new Set(pending.map((entry) => entry.name))) {
        const lessons = pending.filter((entry) => entry.name === name).map((entry) => entry.lesson)
        for (const lesson of await Store.mergeUsage(this.root, name, lessons))
          targets.push({ name, id: lesson.id, applied: lesson.applied + 1 })
      }
      await Store.writeAtomic(this.root, path.join(this.dir, ".flush.json"), canonical({ session, lessons: targets }))
      await this.finishFlush()
      await this.log((await this.state(session, false))!)
    }, LOCK_OPTIONS)
  }
}
