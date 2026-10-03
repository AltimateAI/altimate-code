// altimate_change - new file
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Lesson, canonical, parse } from "./lesson"
import { assertLearnLock } from "./lock"
import { validateName } from "./playbook"
import { fileHookEnabled, lessonLine, matchesFile, renderSection, resolveLimits, retrieve, selectStart, type Limits } from "./select"
import * as Store from "./store"

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

async function read(file: string) {
  try {
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
      await fs.access(this.stateFile(session))
      this.enabled = true
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  async section(session: string): Promise<string> {
    const state = await this.state(session)
    if (!state) return ""
    this.enabled = true
    return state.section
  }

  private async exists() {
    try { await fs.access(this.dir); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }

  private stateFile(session: string) {
    return path.join(this.dir, ".sessions", Store.sha256(session) + ".json")
  }

  private async state(session: string) {
    const raw = await read(this.stateFile(session))
    if (raw === undefined) return undefined
    const state = State.parse(JSON.parse(raw))
    if (state.session !== session) throw new Error("Learn session state belongs to another session")
    return state
  }

  private async approved(): Promise<Approved[]> {
    const result: Approved[] = []
    const names = (await fs.readdir(this.dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    for (const name of names) {
      try { validateName(name) } catch { continue }
      // Read approved snapshots directly: migration/capture may write, and merely opening a
      // candidate-only project must not mutate it. Capture being off does NOT disable these
      // rules: a person already approved them. An unused project only pays the existence check.
      const raw = await read(Store.paths(this.root, name).approved)
      if (raw === undefined) continue
      for (const lesson of parse(raw)) result.push({ name, lesson })
    }
    return result
  }

  private async save(state: State) {
    await assertLearnLock(this.root)
    await fs.mkdir(path.dirname(this.stateFile(state.session)), { recursive: true })
    await Store.writeAtomic(this.root, this.stateFile(state.session), canonical(state))
  }

  /** Replay missing records after a restart; state is persisted before append-only attribution. */
  private async log(state: State) {
    for (const name of new Set(state.shown.map((entry) => entry.name))) {
      const file = path.join(Store.paths(this.root, name).learnDir, "shown.jsonl")
      const logged = new Set((await read(file) ?? "").split("\n").filter(Boolean).map((line) => {
        const record = JSON.parse(line)
        return `${record.session}\0${record.id}`
      }))
      const missing = state.shown.filter((entry) => entry.name === name && !logged.has(`${state.session}\0${entry.lesson.id}`))
      if (!missing.length) continue
      await assertLearnLock(this.root)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await assertLearnLock(this.root)
      await fs.appendFile(file, missing.map(({ lesson, tier, at, queryHash }) =>
        JSON.stringify({ session: state.session, id: lesson.id, tier, at, queryHash }) + "\n").join(""))
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

  private async initialQuery(query: string) {
    // Only inspect path-shaped words the user supplied; never traverse the project tree.
    const found = new Set<string>()
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
        const stat = await fs.stat(absolute).catch(() => undefined)
        if (stat?.isFile()) found.add(relative.split(path.sep).join("/"))
      }
    }
    return found.size ? `${query}\n${[...found].sort().join("\n")}` : query
  }

  async prepare(session: string, message: string, query: string): Promise<Prepared> {
    if (!await this.exists()) return { ...EMPTY }
    // Do not acquire the filesystem lock until there is existing delivery state or approved content.
    if (!await this.state(session) && !(await this.approved()).length) return { ...EMPTY }
    this.enabled = true
    return Store.transaction(this.root, async () => {
      let state = await this.state(session)
      if (state) {
        const previous = state.requests.find((request) => request.message === message)
        if (previous) {
          await this.log(state)
          return { section: state.section, requestNote: previous.note }
        }
      }
      const approved = await this.approved()
      if (!state && !approved.length) return { ...EMPTY }
      if (!state) {
        const initialQuery = await this.initialQuery(query)
        const start = selectStart(corpus(approved), initialQuery, this.limits)
        state = { version: 1, session, firstMessage: message, section: start.section, shown: [], requests: [], compactions: [], counted: [] }
        for (const item of start.lessons) this.add(state, approved, [item.lesson], item.tier, initialQuery)
        state.requests.push({ message, note: "" })
      } else {
        const matches = retrieve(corpus(approved), query, {
          limit: Math.min(this.limits.request_lessons, Math.max(0, this.limits.session_max_lessons - state.shown.length)),
          exclude: state.shown.map((entry) => identity(entry.name, entry.lesson.id)),
        })
        const added = this.add(state, approved, matches, "request", query)
        const note = added.length ? "Team rules for this request:\n" + added.map(lessonLine).join("\n") : ""
        state.requests.push({ message, note })
      }
      await this.save(state)
      await this.log(state)
      return { section: state.section, requestNote: state.requests.find((request) => request.message === message)!.note }
    })
  }

  async compact(session: string, marker: string): Promise<string> {
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
    })
  }

  async file(session: string, file: string): Promise<string> {
    if (!await this.exists()) return ""
    if (!fileHookEnabled(this.config) || this.limits.file_lessons === 0) return ""
    if (!await this.state(session)) return ""
    return Store.transaction(this.root, async () => {
      const state = (await this.state(session))!
      if (state.shown.length >= this.limits.session_max_lessons) return ""
      const relative = path.relative(this.root, path.resolve(this.directory, file)).split(path.sep).join("/")
      if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return ""
      const approved = await this.approved()
      const shown = new Set(state.shown.map((entry) => identity(entry.name, entry.lesson.id)))
      const matches = corpus(approved).filter((lesson) => !shown.has(lesson.id) && matchesFile(lesson, relative))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, this.limits.file_lessons)
      const added = this.add(state, approved, matches, "file", relative)
      if (!added.length) return ""
      await this.save(state)
      await this.log(state)
      return `Team rules for ${relative}:\n` + added.map(lessonLine).join("\n")
    })
  }

  private async finishFlush() {
    const file = path.join(this.dir, ".flush.json")
    const raw = await read(file)
    if (raw === undefined) return
    const flush = Flush.parse(JSON.parse(raw))
    for (const name of new Set(flush.lessons.map((entry) => entry.name))) {
      const approved = Store.paths(this.root, name).approved
      const snapshot = await read(approved)
      if (snapshot === undefined) continue
      const lessons = parse(snapshot)
      const targets = new Map(flush.lessons.filter((entry) => entry.name === name).map((entry) => [entry.id, entry.applied]))
      let changed = false
      for (const lesson of lessons) {
        const applied = targets.get(lesson.id)
        if (applied === undefined || lesson.applied >= applied) continue
        lesson.applied = applied
        changed = true
      }
      if (changed) await Store.writeAtomic(this.root, approved, canonical(lessons))
    }
    const state = await this.state(flush.session)
    if (state) {
      state.counted = [...new Set([...state.counted, ...flush.lessons.map((entry) => identity(entry.name, entry.id))])]
      await this.save(state)
    }
    await assertLearnLock(this.root)
    await fs.rm(file)
  }

  /** Update usage only on a harness flush; never feed changing counters into the frozen prompt. */
  async flush(session: string): Promise<void> {
    if (!await this.exists() || !await this.state(session)) return
    await Store.transaction(this.root, async () => {
      // One project-wide journal is replayed before the next flush computes absolute targets.
      // Retrying after any store/state write boundary cannot count the same lesson twice.
      await this.finishFlush()
      const state = (await this.state(session))!
      const pending = state.shown.filter((entry) => !state.counted.includes(identity(entry.name, entry.lesson.id)))
      if (!pending.length) return
      const targets: z.infer<typeof Flush>["lessons"] = []
      for (const name of new Set(pending.map((entry) => entry.name))) {
        const file = Store.paths(this.root, name).approved
        const raw = await read(file)
        if (raw === undefined) continue
        const ids = new Set(pending.filter((entry) => entry.name === name).map((entry) => entry.lesson.id))
        const lessons = parse(raw)
        for (const lesson of lessons)
          if (ids.has(lesson.id)) targets.push({ name, id: lesson.id, applied: lesson.applied + 1 })
      }
      await Store.writeAtomic(this.root, path.join(this.dir, ".flush.json"), canonical({ session, lessons: targets }))
      await this.finishFlush()
      // Lessons removed from the approved store still count as flushed for this session.
      const finished = (await this.state(session))!
      finished.counted = [...new Set([...finished.counted, ...pending.map((entry) => identity(entry.name, entry.lesson.id))])]
      await this.save(finished)
      await this.log(finished)
    })
  }
}
