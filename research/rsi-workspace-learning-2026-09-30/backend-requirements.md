# Workspace memory for learned rules — backend requirements

Date: 2026-10-02. Audience: workspace / backend team. Status: proposal for discussion.

## Summary

`altimate-code learn` turns user corrections and review feedback into short team rules ("lessons") that every later session loads automatically. It works today on one machine and, as a stopgap, is shared through a published workspace skill. We want to store each lesson as a workspace **memory** record instead, so lessons can be scoped (workspace-wide or one project), reviewed, and shared across projects and teammates.

The client side is ready to change. It cannot ship for teams without four backend changes, because each one is something only the server can enforce:

1. **Team-visible memory**: teammates must be able to read approved lessons.
2. **Verbatim storage**: lesson text must be stored exactly as written.
3. **A review state**: lessons are candidates until a maintainer approves them.
4. **Safe concurrent updates**: several projects and people write the same lesson set.

Two smaller asks: server-side filtering (workspace, project, status, kind) and a capacity allowance for learned records.

## Why this matters (evidence)

Measured on a dbt benchmark (held-out tasks, 9 runs per arm):

| Situation | Held-out pass |
|---|---|
| No lessons | 0/9 (Claude), 2/9 (Gemini) |
| Learned lessons loaded | 8–9/9 |
| A stale lesson left next to its replacement | **1/9** |
| An outdated playbook left as-is | **0/9** |

Lessons are worth sharing, and a wrong or stale lesson does more damage than having none. That is why sharing needs review and safe updates, not just visibility.

## Why the client cannot do this alone

| Need | What the backend does today | Why a client workaround is not enough |
|---|---|---|
| Teammates read approved lessons | `GET /datamates/memory/list` returns only the caller's records; every mirrored record is written with `visibility: "private"` (`memory-api.ts`). | The client cannot read records the server will not return to it. Today's workaround is a workspace skill, which holds all lessons in one file, can only be published by the workspace owner, and is last-writer-wins: when project B publishes, project A's lessons are overwritten. |
| Exact text | `POST /` runs an LLM extractor that rewrites the text, overwrites `memory_type` and `title`, may split one record into several, or decline and store nothing while returning 200. The client patches it back with a follow-up `PATCH`. | Lessons are compared by the code identifiers they mention (for example `_cents`) to detect contradictions, so a rewrite can hide a conflict. The create-then-patch repair is not atomic: a crash between the two leaves a rewritten lesson live, and a split cannot be repaired. |
| Review before a lesson reaches the team | No status on memory records; anything written is immediately readable by every session that reads it. | Approval enforced only in the client can be skipped by an older client, another tool, or a direct API call. The 1/9 result shows what an unreviewed stale lesson costs. |
| Safe concurrent writes | `PATCH` overwrites without a version check. | The client's lock only protects one machine. Two teammates or two projects updating the same lesson silently lose one update. |
| Workspace and project scoping | `list` is not scoped by workspace and ignores paging; the client filters after downloading everything. | Every session would download every lesson the user can see from every workspace. This grows with use and leaks lessons across workspaces into the prompt if a filter is missed. |
| Capacity | 50 memory blocks per scope, shared with the agent's own notes. | Learned rules would compete with ordinary memory for the same slots. |

## Requirements

Each requirement lists what we need and how we'll know it works. The API shape that follows is a suggestion.

**R1. Team visibility.** A memory record can be marked visible to all members of its workspace. Approved learned records are readable by every member's sessions in that workspace (and, for project-scoped records, in projects linked to it).
*Accept:* user B lists records and receives an approved learned record written by user A in the same workspace; a user outside the workspace does not.

**R2. Verbatim storage.** A create can skip the extractor and store text and metadata exactly as sent, as one record.
*Accept:* create then read returns byte-identical text and metadata; one create produces exactly one record; the response says whether it was stored.

**R3. Review state.** Learned records carry `status: candidate | approved | rejected | retired`. Only approved records are returned to sessions by default. Changing status is restricted to workspace maintainers (owner plus a maintainer role); any member can submit candidates.
*Accept:* a candidate is invisible to other members' default reads; a non-maintainer's attempt to approve returns 403; every status change is recorded with who and when.

**R4. Conditional updates.** Every record has a version; updates and status changes accept an expected version and fail with 409 if it changed.
*Accept:* two concurrent updates with the same expected version: one succeeds, one gets 409, neither is lost silently.

**R5. Server-side filtering and paging.** `list` filters by workspace, project, `kind`, `status`, `source`, and honours paging.
*Accept:* a session can request "approved learned rules for workspace W and project P" and receive only those, in pages.

**R6. Capacity for learned records.** Learned records do not count against the 50-block per-scope memory cap, or have their own cap (suggested: 200 per workspace, 100 per project).
*Accept:* writing learned records does not evict or block ordinary memory.

**R7. History.** Superseded and retired lessons are kept, not deleted, with a link to what replaced them.
*Accept:* a retired record can be read back with its replacement's id and the reason.

## Suggested record shape

| Field | Notes |
|---|---|
| `id`, `version` | `version` increments on every change (R4) |
| `workspace_id`, `project_id?` | no `project_id` means workspace-wide |
| `visibility` | `private` or `workspace` (R1); learned records use `workspace` |
| `kind` | `learned_rule` |
| `status` | `candidate`, `approved`, `rejected`, `retired` (R3) |
| `text` | one line, at most 240 characters, stored verbatim (R2) |
| `supersedes`, `coexists` | lesson ids, for contradiction handling |
| `helpful`, `harmful`, `applied` | counters updated by clients |
| `provenance` | redacted source of the lesson (correction, review comment, CI) |
| `created_by`, `approved_by`, `approved_at` | audit |
| `source` | `altimate-code`, as today |

## Suggested API (non-binding)

- `POST /datamates/memory` with `{ verbatim: true, ... }`: create, no extraction (R2).
- `GET /datamates/memory/list?workspace_id=&project_id=&kind=learned_rule&status=approved&page=`: filtered and paged (R5).
- `PATCH /datamates/memory/{id}` with `If-Match: <version>`: conditional update (R4).
- `POST /datamates/memory/{id}/approve | reject | retire` with `If-Match`: maintainer only (R3).
- `GET /datamates/memory/{id}/history`: status and text history (R7).

## What stays in the client

Capture, reflection, curation (lint, dedupe, contradiction and supersede rules, credential redaction), and the decision of what to propose. The server stores, scopes, authorizes, versions and audits. Sessions load approved lessons for their workspace and project into a stable part of the prompt.

## Out of scope

Server-side extraction or rewriting of lessons, embedding search over lessons, and any automatic approval.

## Open questions for the workspace team

1. Is a maintainer role already planned, or should approval be owner-only at first?
2. Should project-scoped lessons be visible in other projects of the same workspace (read-only), or only in their own project?
3. Can the extractor bypass be a per-request flag, or should learned records use a separate route?
4. Where should the review UI live: the workspace app, the CLI, or both at first?
5. Retention: how long are retired lessons kept?

## Rollout

1. Backend: R1–R5 behind a flag on one test tenant (`anandtest1`).
2. Client: switch `learn` storage from the skill file to memory records; keep the skill path as a fallback for workspaces without the flag.
3. Re-run the existing benchmark end to end on the test tenant (teammate receives approved lessons; stale lessons are retired; concurrent edits get 409).
4. Workspace app: a "Learned rules" review view.
