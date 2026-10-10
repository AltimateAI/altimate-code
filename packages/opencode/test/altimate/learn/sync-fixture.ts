// altimate_change - new file
//
// An in-memory learned-lessons server implementing the backend's wire contract
// (/datamates/{id}/lessons/{sync,submissions,batch,usage}) plus the binding lookup the sync gate uses,
// served over real HTTP so the client's request, timeout and error mapping run unchanged.
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type Status = "candidate" | "approved" | "rejected" | "retired" | "removed"
export interface Row {
  id: number
  public_id: string
  repo_identity: string | null
  store: string
  lesson_key: string
  text: string
  tags: string[]
  trigger_paths: string[]
  coexists: { lesson_key: string; source_text_hash: string; target_text_hash: string }[]
  pinned: boolean
  status: Status
  change_type: "add" | "edit" | "remove"
  replaces: { public_id: string; version: number }[]
  origin: string
  created_by: number
  submission_hash: string
  content_hash: string
  version: number
  helpful: number
  harmful: number
  applied: number
  updated_at: string
  status_reason?: string
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
function canonical(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, ordered(x)])) : v
  return JSON.stringify(ordered(value))
}
export const materialHash = (r: Pick<Row, "change_type" | "text" | "tags" | "trigger_paths" | "coexists" | "pinned" | "replaces">) =>
  sha(canonical({ change_type: r.change_type, text: r.text, tags: r.tags, trigger_paths: r.trigger_paths, coexists: r.coexists, pinned: r.pinned, replaces: r.replaces }))

/** github remotes, SSH or HTTPS, to one identity (a stand-in for the backend's `repo_identity`). */
export const repoIdentity = (remote: string) =>
  "https://" + remote.replace(/^git@([^:]+):/, "$1/").replace(/^ssh:\/\/git@/, "").replace(/^https?:\/\//, "").replace(/\.git$/, "")

export interface Server {
  url: string
  rows: Row[]
  requests: { method: string; path: string; body: any; user: number }[]
  usageReceipts: Map<string, string>
  bindings: Map<string, number>
  revision: number
  share: boolean
  /** Answer every lesson route with FastAPI's bare 404 (an older backend). */
  routesMissing: boolean
  /** Fail the next N lesson requests with 503. */
  failNext: number
  /** Delay every lesson response. */
  delayMs: number
  datamateId: number
  owner: number
  users: Map<string, number>
  approve(publicId: string): Row
  reject(publicId: string, reason?: string): Row
  retire(publicId: string): Row
  editCandidate(publicId: string, text: string): Row
  add(row: Partial<Row> & Pick<Row, "lesson_key" | "text">, remote?: string): Row
  stop(): void
}

export function startServer(opts: { datamateId?: number } = {}): Server {
  let nextId = 1
  const now = () => new Date(Date.now() + nextId).toISOString()
  const server: Server = {
    url: "", rows: [], requests: [], usageReceipts: new Map(), bindings: new Map(), revision: 0, share: false,
    routesMissing: false, failNext: 0, delayMs: 0, datamateId: opts.datamateId ?? 7, owner: 1, users: new Map([["owner-key", 1], ["key-a", 2], ["key-b", 3]]),
    approve(publicId) {
      const row = find(publicId, "candidate")
      for (const ref of row.replaces) {
        const target = server.rows.find((r) => r.public_id === ref.public_id)!
        Object.assign(target, { status: "retired", status_reason: `superseded`, version: target.version + 1, updated_at: now() })
      }
      Object.assign(row, { status: row.change_type === "remove" ? "removed" : "approved", version: row.version + 1, updated_at: now() })
      server.revision++
      return row
    },
    reject(publicId, reason = "no") {
      const row = find(publicId, "candidate")
      return Object.assign(row, { status: "rejected", status_reason: reason, version: row.version + 1, updated_at: now() })
    },
    retire(publicId) {
      const row = find(publicId, "approved")
      Object.assign(row, { status: "retired", version: row.version + 1, updated_at: now() })
      server.revision++
      return row
    },
    editCandidate(publicId, text) {
      const row = find(publicId, "candidate")
      Object.assign(row, { text, version: row.version + 1, updated_at: now() })
      row.content_hash = materialHash(row)
      return row
    },
    add(input, remote) {
      const row: Row = {
        id: nextId++, public_id: randomUUID(), repo_identity: remote ? repoIdentity(remote) : null, store: "team-playbook",
        tags: [], trigger_paths: [], coexists: [], pinned: false, status: "approved", change_type: "add", replaces: [],
        origin: "ui", created_by: 1, version: 1, helpful: 0, harmful: 0, applied: 0, updated_at: now(),
        submission_hash: "", content_hash: "", ...input,
      }
      row.submission_hash = row.content_hash = materialHash(row)
      server.rows.push(row)
      if (row.status === "approved") server.revision++
      return row
    },
    stop() { http.stop(true) },
  }
  function find(publicId: string, status: Status) {
    const row = server.rows.find((r) => r.public_id === publicId)
    if (!row || row.status !== status) throw new Error(`no ${status} row ${publicId}`)
    return row
  }
  /** Bindings match by identity, as the backend's `get_binding_by_remote` does (SSH and HTTPS are one repo). */
  const boundTo = (remote: string) => [...server.bindings].find(([key]) => repoIdentity(key) === repoIdentity(remote))?.[1]
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const coded = (status: number, code: string, extra: Record<string, unknown> = {}) => json({ detail: { code, message: code, ...extra } }, status)
  const inScope = (row: Row, identity: string, store: string) =>
    row.store === store && (row.repo_identity === null || row.repo_identity === identity || server.share)
  const lessonOut = (row: Row, live: Row[]) => ({
    public_id: row.public_id, lesson_key: row.lesson_key, repo_identity: row.repo_identity, store: row.store, text: row.text,
    tags: row.tags, trigger_paths: row.trigger_paths, pinned: row.pinned,
    coexists: row.coexists.filter((ref) => {
      const target = live.find((l) => l.lesson_key === ref.lesson_key)
      return target && sha(row.text) === ref.source_text_hash && sha(target.text) === ref.target_text_hash
    }).map((ref) => ref.lesson_key),
    helpful: row.helpful, harmful: row.harmful, applied: row.applied, version: row.version, updated_at: row.updated_at,
  })

  const http = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      const user = server.users.get(key)
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined)
      server.requests.push({ method: request.method, path: url.pathname + url.search, body, user: user ?? 0 })
      if (!user) return json({ detail: "Invalid token" }, 401)
      if (url.pathname === "/datamate-project-bindings/by-remote") {
        const remote = url.searchParams.get("repo_remote") ?? ""
        const datamate = boundTo(remote)
        if (datamate === undefined) return json({ detail: "Not found" }, 404)
        return json({
          binding: { id: 1, datamate_id: datamate, datamate_name: "Analytics", repo_remote: remote, project_path: null },
          datamate: { id: datamate, name: "Analytics" },
        })
      }
      if (url.pathname.startsWith("/datamate-project-bindings/")) return json({ detail: "Not found" }, 404)
      const match = /^\/datamates\/(\d+)\/lessons\/(sync|submissions|batch|usage)$/.exec(url.pathname)
      if (!match || server.routesMissing) return json({ detail: "Not Found" }, 404)
      if (server.delayMs) await Bun.sleep(server.delayMs)
      if (server.failNext > 0) {
        server.failNext--
        return json({ detail: "unavailable" }, 503)
      }
      if (Number(match[1]) !== server.datamateId) return coded(404, "workspace_not_found")
      const route = match[2]
      const bound = (remote: string) => (boundTo(remote) === server.datamateId ? repoIdentity(remote) : undefined)
      if (route === "sync") {
        const identity = bound(body.repo_remote)
        if (!identity) return coded(422, "repo_not_bound")
        const store = body.store ?? "team-playbook"
        const live = server.rows.filter((r) => r.status === "approved" && inScope(r, identity, store))
        const tombstones = (body.local_keys as string[]).flatMap((k) => [identity, null].flatMap((scope) => {
          const terminal = server.rows.some((r) => r.store === store && r.repo_identity === scope && r.lesson_key === k && (r.status === "retired" || r.status === "removed"))
          const alive = server.rows.some((r) => r.store === store && r.repo_identity === scope && r.lesson_key === k && r.status === "approved")
          return terminal && !alive ? [{ repo_identity: scope, store, lesson_key: k }] : []
        }))
        const unchanged = body.known_revision === server.revision
        return json({
          unchanged, revision: server.revision, repo_identity: identity, share_lessons_across_repos: server.share,
          pending_count: server.rows.filter((r) => r.status === "candidate" && r.store === store).length,
          lessons: unchanged ? [] : live.map((r) => lessonOut(r, live)), tombstones,
        })
      }
      if (route === "submissions") {
        const since = url.searchParams.get("since")
        return json(server.rows.filter((r) => r.created_by === user && (!since || r.updated_at >= since))
          .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))
          .map((r) => ({
            public_id: r.public_id, lesson_key: r.lesson_key, repo_identity: r.repo_identity, store: r.store, status: r.status,
            version: r.version, submission_hash: r.submission_hash, content_hash: r.content_hash, status_reason: r.status_reason ?? null, updated_at: r.updated_at,
          })))
      }
      if (route === "usage") {
        const hash = sha(canonical(body.items))
        const seen = server.usageReceipts.get(body.batch_id)
        if (seen && seen !== hash) return coded(409, "batch_conflict")
        if (seen) return json({ duplicate: true, applied_items: body.items.length })
        server.usageReceipts.set(body.batch_id, hash)
        for (const item of body.items) {
          const row = server.rows.find((r) => r.public_id === item.public_id)
          if (row) Object.assign(row, { applied: row.applied + item.applied, helpful: row.helpful + item.helpful, harmful: row.harmful + item.harmful })
        }
        return json({ duplicate: false, applied_items: body.items.length })
      }
      // batch
      const identity = bound(body.repo_remote)
      if (!identity) return coded(422, "repo_not_bound")
      const store = body.store ?? "team-playbook"
      const results = (body.items as any[]).map((item) => {
        const hash = materialHash(item)
        const base = { lesson_key: item.lesson_key, submission_hash: hash, public_id: null, version: null, status: null, duplicate: false, error_code: null, error_detail: null, existing: null }
        const mine = server.rows.filter((r) => r.store === store && r.repo_identity === identity && r.lesson_key === item.lesson_key && r.created_by === user)
        const duplicate = mine.find((r) => r.submission_hash === hash)
        if (duplicate) return { ...base, public_id: duplicate.public_id, version: duplicate.version, status: duplicate.status, duplicate: true }
        const open = mine.find((r) => r.status === "candidate")
        if (item.revises_public_id) {
          if (!open || open.public_id !== item.revises_public_id || open.version !== item.revises_version)
            return { ...base, error_code: "version_conflict", existing: open ? { public_id: open.public_id, version: open.version } : null }
          Object.assign(open, { status: "rejected", status_reason: "revised", version: open.version + 1, updated_at: now() })
        } else if (open) return { ...base, error_code: "open_proposal_exists", existing: { public_id: open.public_id, version: open.version } }
        if (item.change_type === "add" && item.replaces.length) return { ...base, error_code: "bad_target" }
        if (item.change_type !== "add") {
          if (!item.replaces.length) return { ...base, error_code: "bad_target" }
          for (const ref of item.replaces) {
            const target = server.rows.find((r) => r.public_id === ref.public_id)
            if (!target || target.status !== "approved" || target.version !== ref.version || !inScope(target, identity, store))
              return { ...base, error_code: "bad_target" }
          }
          if (item.change_type === "edit" && item.replaces.length === 1) {
            const target = server.rows.find((r) => r.public_id === item.replaces[0].public_id)!
            if (target.lesson_key === item.lesson_key && target.text === item.text && target.pinned === item.pinned &&
              canonical(target.tags) === canonical(item.tags) && canonical(target.trigger_paths) === canonical(item.trigger_paths))
              return { ...base, error_code: "no_change" }
          }
        }
        const row: Row = {
          id: nextId++, public_id: randomUUID(), repo_identity: identity, store, lesson_key: item.lesson_key, text: item.text,
          tags: item.tags, trigger_paths: item.trigger_paths, coexists: item.coexists, pinned: item.pinned, status: "candidate",
          change_type: item.change_type, replaces: item.replaces, origin: item.origin, created_by: user,
          submission_hash: hash, content_hash: hash, version: 1, helpful: 0, harmful: 0, applied: 0, updated_at: now(),
        }
        server.rows.push(row)
        return { ...base, public_id: row.public_id, version: 1, status: "candidate" }
      })
      return json({ results })
    },
  })
  server.url = `http://127.0.0.1:${http.port}`
  return server
}

/** A credentials file in a private home; `OPENCODE_TEST_HOME` is restored by the returned function. */
export async function sandboxHome() {
  const original = process.env.OPENCODE_TEST_HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "learn-sync-home-"))
  await fs.mkdir(path.join(home, ".altimate"), { recursive: true })
  process.env.OPENCODE_TEST_HOME = home
  return {
    home,
    async signIn(url: string, apiKey: string, tenant = "acme") {
      await fs.writeFile(path.join(home, ".altimate", "altimate.json"), JSON.stringify({ altimateUrl: url, altimateInstanceName: tenant, altimateApiKey: apiKey }))
      return { url, instance: tenant, apiKey }
    },
    async restore() {
      if (original === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = original
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

/** Environment for sync: the test preload turns workspaces off. */
export function syncEnv() {
  const keys = ["ALTIMATE_DISABLE_WORKSPACE", "ALTIMATE_LEARN_SYNC", "ALTIMATE_LEARN"] as const
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.ALTIMATE_DISABLE_WORKSPACE = "0"
  delete process.env.ALTIMATE_LEARN_SYNC
  delete process.env.ALTIMATE_LEARN
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/** A project checkout with an `origin` remote. */
export async function checkout(remote: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "learn-sync-repo-")))
  for (const args of [["init", "-q"], ["remote", "add", "origin", remote]]) {
    const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" })
    await proc.exited
  }
  return root
}
