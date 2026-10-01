// Local fake of the Altimate workspace backend. Wire contract derived from
// packages/opencode/src/altimate/workspace/{api-client,skill-sync,skill-publish,memory-api}.ts.
//
// Env: PORT (18787), FAKE_STATE (./state.json), FAKE_TENANT (demo),
//      FAKE_TOKENS (JSON {token: {user_id, email}}; default token-user-a / token-user-b),
//      FAKE_SEED_REMOTE (optional git remote; seeds a shared workspace owned by user 1 bound to it).
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const PORT = Number(process.env.PORT ?? 18787)
const STATE_FILE = process.env.FAKE_STATE ?? "./state.json"
const TENANT = process.env.FAKE_TENANT ?? "demo"
const TOKENS: Record<string, { user_id: number; email: string }> = process.env.FAKE_TOKENS
  ? JSON.parse(process.env.FAKE_TOKENS)
  : {
      "token-user-a": { user_id: 1, email: "a@demo.test" },
      "token-user-b": { user_id: 2, email: "b@demo.test" },
    }
const PAGE_SIZE = 50

type Workspace = { id: number; name: string; user_id: number; privacy: "private" | "shared"; memory_enabled: boolean; description: string | null }
type Binding = { id: number; datamate_id: number; repo_remote: string | null; project_path: string | null; created_at: string }
type SkillFile = { path: string; content: string }
type Skill = { public_id: string; name: string; description: string; created_by: number; privacy: string; files: SkillFile[]; attached_datamate_ids: number[]; created_at: string; updated_at: string }
type Memory = { id: string; user_id: number; memory: string; metadata: Record<string, unknown>; created_at: string; updated_at: string }
type State = { seq: number; workspaces: Workspace[]; bindings: Binding[]; skills: Skill[]; memories: Memory[] }

const fresh = (): State => ({ seq: 100, workspaces: [], bindings: [], skills: [], memories: [] })
const state: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : fresh()
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
const nextId = () => ++state.seq
// Strictly increasing so `updated_at` (the client's only change signal) always moves on a write.
let lastTs = 0
const now = () => new Date((lastTs = Math.max(Date.now(), lastTs + 1))).toISOString()

if (process.env.FAKE_SEED_REMOTE && state.workspaces.length === 0) {
  const ws: Workspace = { id: nextId(), name: "rsi-demo", user_id: 1, privacy: "shared", memory_enabled: true, description: null }
  state.workspaces.push(ws)
  state.bindings.push({ id: nextId(), datamate_id: ws.id, repo_remote: process.env.FAKE_SEED_REMOTE, project_path: null, created_at: now() })
  save()
}

class HttpError extends Error {
  constructor(public status: number, public detail: unknown) { super(String(detail)) }
}
const json = (body: unknown, status = 200) => Response.json(body, { status })
const visible = (ws: Workspace, uid: number) => ws.user_id === uid || ws.privacy === "shared"
const wsOf = (id: number) => state.workspaces.find((w) => w.id === id)
const bindingView = (b: Binding) => ({ ...b, datamate_name: wsOf(b.datamate_id)?.name ?? "" })
const wsView = (w: Workspace) => ({ id: w.id, name: w.name, description: w.description, memory_enabled: w.memory_enabled, user_id: w.user_id, privacy: w.privacy, integrations: [] })
const skillSummary = (s: Skill) => ({ public_id: s.public_id, name: s.name, description: s.description, created_by: s.created_by, privacy: s.privacy, file_count: s.files.length, attached_datamate_ids: s.attached_datamate_ids, created_at: s.created_at, updated_at: s.updated_at })
const skillDetail = (s: Skill) => ({ skill: { ...skillSummary(s), files: s.files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content, "utf8") })), content: s.files.find((f) => f.path === "SKILL.md")?.content ?? "" } })

function findBinding(q: URLSearchParams, uid: number, by: "remote" | "path") {
  const b = by === "remote"
    ? state.bindings.find((x) => x.repo_remote === q.get("repo_remote"))
    : state.bindings.find((x) => x.project_path === q.get("project_path"))
  const ws = b && wsOf(b.datamate_id)
  // A private workspace's binding is invisible to everyone but its owner: 404, as the real server does.
  if (!b || !ws || !visible(ws, uid)) throw new HttpError(404, "No binding for this project")
  return { b, ws }
}

function bindProject(uid: number, datamate_id: number, remote: string | null, path: string | null) {
  const ws = wsOf(datamate_id)
  if (!ws || !visible(ws, uid)) throw new HttpError(404, "Workspace not found")
  if (ws.user_id !== uid) throw new HttpError(403, "Only the workspace owner can bind projects to it")
  const clash = state.bindings.find((x) => (remote && x.repo_remote === remote) || (path && x.project_path === path))
  if (clash) {
    const other = wsOf(clash.datamate_id)
    throw new HttpError(409, {
      message: "This project is already bound to a workspace",
      existing_datamate_id: clash.datamate_id,
      existing_datamate_name: other && visible(other, uid) ? other.name : null,
      ...(remote ? { repo_remote: remote } : { project_path: path }),
    })
  }
  const b: Binding = { id: nextId(), datamate_id, repo_remote: remote, project_path: path, created_at: now() }
  state.bindings.push(b)
  return b
}

function rebind(q: { remote?: string; path?: string }, target: number, expected: number | undefined, uid: number) {
  const b = state.bindings.find((x) => (q.remote ? x.repo_remote === q.remote : x.project_path === q.path))
  if (!b) throw new HttpError(404, "No binding for this project")
  if (expected !== undefined && b.datamate_id !== expected)
    throw new HttpError(412, { message: "The project is bound to a different workspace than expected", actual_current_datamate_id: b.datamate_id, expected_current_datamate_id: expected })
  const ws = wsOf(target)
  if (!ws || !visible(ws, uid)) throw new HttpError(404, "Workspace not found")
  if (ws.user_id !== uid) throw new HttpError(403, "Only the workspace owner can bind projects to it")
  b.datamate_id = target
  return b
}

async function route(req: Request, url: URL): Promise<Response> {
  const m = req.method
  const p = url.pathname.replace(/\/+$/, "") || "/"
  const q = url.searchParams
  const body = async () => (await req.json().catch(() => ({}))) as any

  if (p === "/__debug/state") return json(state)
  if (p === "/__debug/reset" && m === "POST") { Object.assign(state, fresh()); save(); return json({ ok: true }) }

  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
  const me = TOKENS[tok]
  if (!me) throw new HttpError(401, "Invalid API key")
  if (req.headers.get("x-tenant") !== TENANT) throw new HttpError(403, "Invalid tenant")
  const uid = me.user_id
  let r: RegExpMatchArray | null

  if (p === "/dbt/v3/validate-credentials") return json({ ok: true })
  if (p === "/users/me") return json({ id: uid, email: me.email })

  // --- bindings ---
  if (p === "/datamate-project-bindings/by-remote" || p === "/datamate-project-bindings/by-path") {
    const by = p.endsWith("remote") ? "remote" : "path"
    if (m === "GET") { const { b, ws } = findBinding(q, uid, by); return json({ binding: bindingView(b), datamate: wsView(ws) }) }
    if (m === "PUT") {
      const j = await body()
      const b = rebind(by === "remote" ? { remote: j.repo_remote } : { path: j.project_path }, j.target_datamate_id, j.expected_current_datamate_id, uid)
      save(); return json({ binding: bindingView(b) })
    }
  }
  if (p === "/datamate-project-bindings") {
    if (m === "POST") {
      const j = await body()
      const clash = state.bindings.find((x) => (j.repo_remote && x.repo_remote === j.repo_remote) || (j.project_path && x.project_path === j.project_path))
      if (clash) bindProject(uid, clash.datamate_id, j.repo_remote, j.project_path) // throws the 409/403/404
      const ws: Workspace = { id: nextId(), name: j.name, user_id: uid, privacy: "private", memory_enabled: true, description: j.description ?? null }
      state.workspaces.push(ws)
      const b = bindProject(uid, ws.id, j.repo_remote ?? null, j.project_path ?? null)
      save(); return json({ datamate: wsView(ws), binding: bindingView(b), manage_url: `http://localhost:${PORT}/manage/${ws.id}` }, 201)
    }
    if (m === "DELETE") {
      const i = state.bindings.findIndex((x) => (q.get("repo_remote") ? x.repo_remote === q.get("repo_remote") : x.project_path === q.get("project_path")))
      if (i < 0) throw new HttpError(404, "No binding for this project")
      state.bindings.splice(i, 1); save(); return new Response(null, { status: 204 })
    }
  }
  if (p === "/datamate-project-bindings/bind" && m === "POST") {
    const j = await body()
    const b = bindProject(uid, j.datamate_id, j.repo_remote ?? null, j.project_path ?? null)
    save(); return json({ binding: bindingView(b) }, 201)
  }

  // --- datamates (workspaces) ---
  if (p === "/datamates" && m === "GET") return json({ datamates: state.workspaces.filter((w) => visible(w, uid)).map(wsView) })
  if (p === "/datamates" && m === "POST") {
    const j = await body()
    const ws: Workspace = { id: nextId(), name: j.name, user_id: uid, privacy: j.privacy === "shared" ? "shared" : "private", memory_enabled: j.memory_enabled ?? false, description: j.description ?? null }
    state.workspaces.push(ws); save(); return json({ id: ws.id })
  }
  if (p === "/datamate_integrations") return json([])

  // --- memory (per-user private) --- must precede /datamates/{id}
  if (p === "/datamates/memory" && m === "POST") {
    const j = await body()
    const text = j.messages?.map((x: any) => x.content).join("\n") ?? ""
    const rec: Memory = { id: crypto.randomUUID(), user_id: uid, memory: text, metadata: j.memory_options?.metadata ?? {}, created_at: now(), updated_at: now() }
    state.memories.push(rec); save()
    return json({ message: "Memory added", result: { results: [{ id: rec.id, memory: rec.memory, event: "ADD" }] } })
  }
  if (p === "/datamates/memory/list" && m === "GET") {
    const include = q.get("include_sources")
    // Mirrors the backend: records tagged with a `source` are hidden unless the caller opts in by name.
    return json(state.memories.filter((x) => x.user_id === uid && (!x.metadata.source || x.metadata.source === include)).map(({ user_id, ...rest }) => rest))
  }
  if ((r = p.match(/^\/datamates\/memory\/([^/]+)$/)) && m === "PATCH") {
    const rec = state.memories.find((x) => x.id === decodeURIComponent(r![1]) && x.user_id === uid)
    if (!rec) throw new HttpError(404, "Memory not found")
    const j = await body()
    rec.memory = j.memory ?? rec.memory
    rec.metadata = j.metadata ?? rec.metadata // replaced wholesale, as the client assumes
    rec.updated_at = now(); save(); return json({ message: "Memory updated" })
  }

  if ((r = p.match(/^\/datamates\/(\d+)(\/summary)?$/))) {
    const ws = wsOf(Number(r[1]))
    if (!ws || !visible(ws, uid)) throw new HttpError(404, "Workspace not found")
    if (m === "GET") return json(wsView(ws))
    if (ws.user_id !== uid) throw new HttpError(403, "Forbidden")
    if (m === "PATCH") { Object.assign(ws, await body()); save(); return json(wsView(ws)) }
    if (m === "DELETE") { state.workspaces = state.workspaces.filter((w) => w !== ws); state.bindings = state.bindings.filter((b) => b.datamate_id !== ws.id); save(); return json({ ok: true }) }
  }

  // --- skills (tenant-wide, attached to workspaces) ---
  if (p === "/skills" && m === "GET") {
    const dm = q.get("datamate_id")
    let rows = state.skills
    if (dm) {
      const ws = wsOf(Number(dm))
      if (!ws || !visible(ws, uid)) throw new HttpError(404, "Workspace not found")
      rows = rows.filter((s) => s.attached_datamate_ids.includes(ws.id))
    } else rows = rows.filter((s) => s.created_by === uid)
    const page = Math.max(1, Number(q.get("page") ?? 1))
    const pages = Math.ceil(rows.length / PAGE_SIZE)
    return json({ items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(skillSummary), total: rows.length, page, size: PAGE_SIZE, pages })
  }
  if (p === "/skills" && m === "POST") {
    const j = await body()
    if (state.skills.some((s) => s.created_by === uid && s.name === j.name)) throw new HttpError(409, `A skill named "${j.name}" already exists`)
    const s: Skill = { public_id: `sk_${nextId()}`, name: j.name, description: j.description ?? "", created_by: uid, privacy: j.privacy ?? "private", files: j.files ?? [], attached_datamate_ids: [], created_at: now(), updated_at: now() }
    state.skills.push(s); save(); return json(skillDetail(s), 201)
  }
  if ((r = p.match(/^\/skills\/([^/]+)(?:\/(datamates)|\/files\/(.+))?$/))) {
    const s = state.skills.find((x) => x.public_id === decodeURIComponent(r![1]))
    // A skill is readable by its creator or by anyone who can see a workspace it is attached to.
    const canRead = s && (s.created_by === uid || s.attached_datamate_ids.some((id) => { const w = wsOf(id); return w && visible(w, uid) }))
    if (!s || !canRead) throw new HttpError(404, "Skill not found")
    if (r[3]) {
      const path = r[3].split("/").map(decodeURIComponent).join("/")
      const f = s.files.find((x) => x.path === path)
      if (!f) throw new HttpError(404, "File not found")
      return json({ path: f.path, content: f.content })
    }
    if (m === "GET" && !r[2]) return json(skillDetail(s))
    if (s.created_by !== uid) throw new HttpError(403, "Only the skill's creator can modify it")
    if (r[2] === "datamates" && m === "PUT") {
      const ids: number[] = (await body()).datamate_ids ?? []
      // Attaching needs ownership; a workspace the caller doesn't own answers 404.
      if (ids.some((id) => wsOf(id)?.user_id !== uid)) throw new HttpError(404, "Workspace not found")
      s.attached_datamate_ids = ids; s.updated_at = now(); save(); return json({ attached_datamate_ids: ids })
    }
    if (m === "PATCH") {
      const j = await body()
      if (j.name && state.skills.some((x) => x !== s && x.created_by === uid && x.name === j.name)) throw new HttpError(409, `A skill named "${j.name}" already exists`)
      if (j.files && !j.replace_bundle && s.files.some((f) => !j.files.some((n: SkillFile) => n.path === f.path)))
        throw new HttpError(409, "files would delete existing paths; pass replace_bundle to replace the whole bundle")
      if (j.name) s.name = j.name
      if (j.description !== undefined) s.description = j.description
      if (j.files) s.files = j.files
      s.updated_at = now(); save(); return json(skillDetail(s))
    }
    if (m === "DELETE") { state.skills = state.skills.filter((x) => x !== s); save(); return new Response(null, { status: 204 }) }
  }

  // Anything else (engine, MCP, telemetry...) is "not here" — clients treat 404 as absent.
  throw new HttpError(404, "Not Found")
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    let res: Response
    try {
      res = await route(req, url)
    } catch (e) {
      res = e instanceof HttpError ? json({ detail: e.detail }, e.status) : json({ detail: String(e) }, 500)
    }
    console.log(`${req.method} ${url.pathname}${url.search} ${res.status}`)
    return res
  },
})
console.log(`fake altimate backend on :${PORT} tenant=${TENANT} state=${STATE_FILE} users=${Object.values(TOKENS).map((u) => u.email).join(",")}`)
