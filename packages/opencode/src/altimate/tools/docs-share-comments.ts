import fs from "node:fs"
import path from "node:path"
import z from "zod"
import { Tool } from "../../tool/tool"
import {
  listSharedDocs,
  listTenantUsers,
  replyToThread,
  resolveThread,
  type DocsShare,
  type DocsShareThread,
  type DocsShareUser,
} from "../api/docs-share"

/** One open thread, as `list` returns it: the model it is on, where, and who said what. */
export interface OpenThread {
  share_id: number
  share_name: string
  project: string
  group_id: number
  file_path?: string
  unique_id?: string
  column?: string
  field?: string
  highlight?: string
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
  messages: { id: number; user_id: number; author: string; at: string; text: string }[]
}

export function userName(users: DocsShareUser[], id: number): string {
  const u = users.find((x) => x.id === id)
  if (!u) return `user ${id}`
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ")
  return u.display_name || full || u.email || `user ${id}`
}

/** The open ("Pending") threads of the shares, with each message's author named. */
export function openThreads(shares: DocsShare[], users: DocsShareUser[]): OpenThread[] {
  const out: OpenThread[] = []
  for (const share of shares) {
    for (const group of share.conversation_group ?? ([] as DocsShareThread[])) {
      if (group.status !== "Pending") continue
      out.push({
        share_id: share.share_id,
        share_name: share.name,
        project: share.project_name,
        group_id: group.conversation_group_id,
        file_path: group.meta?.filePath,
        unique_id: group.meta?.uniqueId,
        column: group.meta?.column,
        field: group.meta?.field,
        highlight: group.meta?.highlight,
        range: group.meta?.range,
        messages: (group.conversations ?? []).map((m) => ({
          id: m.conversation_id,
          user_id: m.user_id,
          author: userName(users, m.user_id),
          at: m.timestamp,
          text: m.message,
        })),
      })
    }
  }
  return out
}

/** The `name:` of the dbt project that holds the working directory, when there is one. */
function currentProjectName(): string | undefined {
  let dir = path.resolve(process.cwd())
  while (true) {
    const file = path.join(dir, "dbt_project.yml")
    if (fs.existsSync(file)) {
      const match = /^name:\s*['"]?([^'"\s#]+)/m.exec(fs.readFileSync(file, "utf8"))
      return match?.[1]
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function failure(title: string, output: string, error: string) {
  return { title, metadata: { success: false, error }, output }
}

function formatThreads(threads: OpenThread[]): string {
  if (!threads.length) return "No open comment threads."
  const lines: string[] = [`${threads.length} open comment thread${threads.length === 1 ? "" : "s"}`]
  for (const t of threads) {
    const where = [
      t.file_path ?? t.unique_id ?? "(no file)",
      t.column && `column ${t.column}`,
      t.range && `line ${t.range.start.line + 1}`,
    ]
      .filter(Boolean)
      .join(", ")
    lines.push("", `[share ${t.share_id}, thread ${t.group_id}] ${where}`)
    if (t.highlight) lines.push(`  on: ${t.highlight}`)
    for (const m of t.messages) lines.push(`  ${m.author}: ${m.text}`)
  }
  return lines.join("\n")
}

export const DocsShareCommentsTool = Tool.define("docs_share_comments", {
  description:
    "Comment threads on shared dbt docs: `list` the open threads for a dbt project (with the people's names), `reply` to a thread, or `resolve` it. `reply` and `resolve` post to the shared docs under the signed-in user's name and need write permission; a read-only call refuses them.",
  parameters: z.object({
    action: z.enum(["list", "reply", "resolve"]).describe("What to do"),
    project: z
      .string()
      .optional()
      .describe("dbt project name the shared docs belong to (default: the project holding the working directory)"),
    share_id: z.number().int().optional().describe("Shared docs id (reply, resolve)"),
    group_id: z.number().int().optional().describe("Comment thread id (reply, resolve)"),
    text: z.string().optional().describe("Reply text (reply)"),
  }),
  async execute(args, ctx) {
    if (args.action === "list") {
      const project = args.project ?? currentProjectName()
      if (!project) {
        return failure(
          "docs_share_comments: no project",
          "No dbt project name: pass `project`, or run from inside a dbt project.",
          "no_project",
        )
      }
      try {
        const [shares, users] = await Promise.all([listSharedDocs([project]), listTenantUsers().catch(() => [])])
        const threads = openThreads(shares, users)
        return {
          title: `Comments: ${threads.length} open`,
          metadata: { success: true, project, count: threads.length, threads },
          output: formatThreads(threads),
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return failure("docs_share_comments: ERROR", `Could not load the comment threads: ${msg}`, msg)
      }
    }

    // Posting speaks for the person: a call without write permission (MCP, `tool run` without
    // --allow-write) and a plan-mode call are read-only and refuse.
    if (ctx.extra?.forceReadOnly === true || ctx.agent === "plan") {
      return failure(
        `docs_share_comments: ${args.action} refused`,
        `${args.action} posts to the shared docs, so it needs write permission: this call is read-only. Re-run with --allow-write.`,
        "read_only",
      )
    }
    if (args.share_id === undefined || args.group_id === undefined) {
      return failure(
        `docs_share_comments: ${args.action}`,
        `${args.action} needs share_id and group_id.`,
        "missing_ids",
      )
    }
    try {
      if (args.action === "reply") {
        const text = args.text?.trim()
        if (!text) return failure("docs_share_comments: reply", "reply needs non-empty text.", "missing_text")
        const res = await replyToThread(args.share_id, args.group_id, text)
        return {
          title: `Comments: replied to thread ${args.group_id}`,
          metadata: { success: res?.ok !== false, share_id: args.share_id, group_id: args.group_id },
          output: `Replied to thread ${args.group_id} on share ${args.share_id}.`,
        }
      }
      const res = await resolveThread(args.share_id, args.group_id)
      return {
        title: `Comments: resolved thread ${args.group_id}`,
        metadata: { success: res?.ok !== false, share_id: args.share_id, group_id: args.group_id },
        output: `Resolved thread ${args.group_id} on share ${args.share_id}.`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return failure("docs_share_comments: ERROR", `Could not ${args.action} the thread: ${msg}`, msg)
    }
  },
})
