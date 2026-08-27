import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID, PartID } from "./schema"
import z from "zod"
// altimate_change start — upstream v1.17.9 repointed this to the Effect-Schema
// NamedError in @opencode-ai/core; this file's schema tree is zod (the SyncEvent
// event system below requires zod schemas), so keep the zod NamedError whose
// `.Schema` is a zod schema and `.create(name, z.object(...))` matches the calls.
import { NamedError } from "@opencode-ai/util/error"
// altimate_change end
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { SyncEvent } from "../sync"
import { Database, NotFoundError, and, desc, eq, inArray, lt, or } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect } from "effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export namespace MessageV2 {
  export function isMedia(mime: string) {
    return mime.startsWith("image/") || mime === "application/pdf"
  }

  // altimate_change start — deterministic tool-call id sanitation. Some
  // OpenAI-compatible servers emit non-string (numeric/object) tool-call ids;
  // providers reject any request whose tool_use/tool_result pair carries a
  // malformed or mismatched id. Valid non-empty strings pass through untouched.
  // Anything else is regenerated deterministically (FNV-1a over the JSON form),
  // so the SAME raw value always maps to the SAME id — the property that keeps
  // the call half and the result half of a pair consistent whether coerced at
  // ingestion (processor.ts) or defensively at replay (toModelMessagesEffect).
  export function sanitizeToolCallID(id: unknown): string {
    if (typeof id === "string" && id.length > 0) return id
    const raw = typeof id === "string" ? id : (JSON.stringify(id) ?? String(id))
    let hash = 0x811c9dc5
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return "call_" + (hash >>> 0).toString(16).padStart(8, "0")
  }
  // altimate_change end

  // altimate_change start — shared synthetic-attachment prompt text. Used both when
  // injecting tool-result media as a user message (below) and by the GitHub Copilot
  // plugin's imgMsg() heuristic so the two stay in sync.
  export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached image(s) from tool result:"
  // altimate_change end

  // altimate_change start — upstream v1.17.9 moved the branded IDs, LSP.Range and
  // Snapshot.FileDiff to Effect Schema. This file's schema tree (and the SyncEvent
  // event system) is zod, so reconstruct the zod equivalents locally. Shapes are
  // identical to the Effect-Schema sources (id/id.ts, lsp/lsp.ts, snapshot/index.ts).
  const SessionIDSchema = z.string().pipe(z.custom<SessionID>())
  const MessageIDSchema = z.string().pipe(z.custom<MessageID>())
  const PartIDSchema = z.string().pipe(z.custom<PartID>())

  const RangeSchema = z.object({
    start: z.object({ line: z.number(), character: z.number() }),
    end: z.object({ line: z.number(), character: z.number() }),
  })

  // Mirrors Snapshot.FileDiff: file/patch optional (legacy on-disk summary_diffs).
  const FileDiffSchema = z.object({
    file: z.string().optional(),
    patch: z.string().optional(),
    additions: z.number(),
    deletions: z.number(),
    status: z.enum(["added", "deleted", "modified"]).optional(),
  })
  // altimate_change end

  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const StructuredOutputError = NamedError.create(
    "StructuredOutputError",
    z.object({
      message: z.string(),
      retries: z.number(),
    }),
  )
  // altimate_change — upstream_fix: content-filter finishes are persisted as
  // assistant errors so the session surfaces provider blocking clearly.
  export const ContentFilterError = NamedError.create(
    "ContentFilterError",
    z.object({
      message: z.string(),
    }),
  )
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>
  export const ContextOverflowError = NamedError.create(
    "ContextOverflowError",
    z.object({ message: z.string(), responseBody: z.string().optional() }),
  )

  export const OutputFormatText = z
    .object({
      type: z.literal("text"),
    })
    .meta({
      ref: "OutputFormatText",
    })

  export const OutputFormatJsonSchema = z
    .object({
      type: z.literal("json_schema"),
      schema: z.record(z.string(), z.any()).meta({ ref: "JSONSchema" }),
      retryCount: z.number().int().min(0).default(2),
    })
    .meta({
      ref: "OutputFormatJsonSchema",
    })

  export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
    ref: "OutputFormat",
  })
  export type OutputFormat = z.infer<typeof Format>

  const PartBase = z.object({
    id: PartIDSchema,
    sessionID: SessionIDSchema,
    messageID: MessageIDSchema,
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: RangeSchema,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    // altimate_change — compaction markers persist the first retained tail message.
    tail_start_id: MessageIDSchema.optional(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string().optional(),
  }).meta({
    ref: "SubtaskPart",
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: MessageIDSchema,
    sessionID: SessionIDSchema,
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    format: Format.optional(),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: FileDiffSchema.array(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
      variant: z.string().optional(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    // altimate_change start — top-level variant mirrors Assistant.variant for
    // propagation (see prompt.ts:427/722 — assistant inherits variant from user)
    variant: z.string().optional(),
    // altimate_change end
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        StructuredOutputError.Schema,
        ContentFilterError.Schema,
        ContextOverflowError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: MessageIDSchema,
    modelID: ModelID.zod,
    providerID: ProviderID.zod,
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    structured: z.any().optional(),
    variant: z.string().optional(),
    finish: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: SyncEvent.define({
      type: "message.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionIDSchema,
        info: Info,
      }),
    }),
    Removed: SyncEvent.define({
      type: "message.removed",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionIDSchema,
        messageID: MessageIDSchema,
      }),
    }),
    PartUpdated: SyncEvent.define({
      type: "message.part.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionIDSchema,
        part: Part,
        time: z.number(),
      }),
    }),
    PartDelta: BusEvent.define(
      "message.part.delta",
      z.object({
        sessionID: SessionIDSchema,
        messageID: MessageIDSchema,
        partID: PartIDSchema,
        field: z.string(),
        delta: z.string(),
      }),
    ),
    PartRemoved: SyncEvent.define({
      type: "message.part.removed",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionIDSchema,
        messageID: MessageIDSchema,
        partID: PartIDSchema,
      }),
    }),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  const Cursor = z.object({
    id: MessageIDSchema,
    time: z.number(),
  })
  type Cursor = z.infer<typeof Cursor>

  export const cursor = {
    encode(input: Cursor) {
      return Buffer.from(JSON.stringify(input)).toString("base64url")
    },
    decode(input: string) {
      return Cursor.parse(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
    },
  }

  const info = (row: typeof MessageTable.$inferSelect) =>
    ({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
      // altimate_change start — upstream v1.17.9 made MessageTable.data an
      // Effect-Schema type that no longer structurally overlaps the zod-inferred
      // MessageV2.Info; cast through unknown (runtime shape is unchanged).
    }) as unknown as MessageV2.Info
  // altimate_change end

  const part = (row: typeof PartTable.$inferSelect) =>
    ({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
    }) as MessageV2.Part

  const older = (row: Cursor) =>
    or(
      lt(MessageTable.time_created, row.time),
      and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)),
    )

  function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
    const ids = rows.map((row) => row.id)
    const partByMessage = new Map<string, MessageV2.Part[]>()
    if (ids.length > 0) {
      const partRows = Database.use((db) =>
        db
          .select()
          .from(PartTable)
          .where(inArray(PartTable.message_id, ids))
          .orderBy(PartTable.message_id, PartTable.id)
          .all(),
      )
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  }

  export const toModelMessagesEffect = Effect.fnUntraced(function* (
    input: WithParts[],
    model: Provider.Model,
    // altimate_change start — toolOutputMaxChars caps tool output length for compaction
    options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
    // altimate_change end
  ) {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()
    // Track media from tool results that need to be injected as user messages
    // for providers that don't support media in tool results.
    //
    // OpenAI-compatible APIs only support string content in tool results, so we need
    // to extract media and inject as user messages. Other SDKs (anthropic, google,
    // bedrock) handle type: "content" with media parts natively.
    //
    // Only apply this workaround if the model actually supports image input -
    // otherwise there's no point extracting images.
    const supportsMediaInToolResults = (() => {
      if (model.api.npm === "@ai-sdk/anthropic") return true
      if (model.api.npm === "@ai-sdk/openai") return true
      if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
      if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
      if (model.api.npm === "@ai-sdk/google") {
        const id = model.api.id.toLowerCase()
        return id.includes("gemini-3") && !id.includes("gemini-2")
      }
      return false
    })()

    const toModelOutput = (output: unknown) => {
      // altimate_change — unwrap AI SDK v6 tool-result wrapper.
      if (output && typeof output === "object" && "output" in output && "toolCallId" in output)
        output = (output as { output: unknown }).output

      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const attachments = (outputObject.attachments ?? []).filter((attachment) => {
          return attachment.url.startsWith("data:") && attachment.url.includes(",")
        })

        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...attachments.map((attachment) => ({
              type: "media",
              mediaType: attachment.mime,
              data: iife(() => {
                const commaIndex = attachment.url.indexOf(",")
                return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
              }),
            })),
          ],
        }
      }

      return { type: "json", value: output as never }
    }

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // text/plain and directory files are converted into text parts, ignore them
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
            if (options?.stripMedia && isMedia(part.mime)) {
              userMessage.parts.push({
                type: "text",
                text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
              })
            } else {
              userMessage.parts.push({
                type: "file",
                url: part.url,
                mediaType: part.mime,
                filename: part.filename,
              })
            }
          }

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: "What did we do so far?",
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
      }

      if (msg.info.role === "assistant") {
        const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
        const media: Array<{ mime: string; url: string }> = []

        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        // altimate_change start — upstream_fix: preserve a non-empty separator
        // between Anthropic signed reasoning blocks during replay.
        const hasSignedReasoning = msg.parts.some((part) => {
          if (part.type !== "reasoning") return false
          return part.metadata?.anthropic?.signature != null
        })
        // altimate_change end
        for (const part of msg.parts) {
          if (part.type === "text") {
            // altimate_change — upstream_fix: AI SDK drops "", but Anthropic
            // signed reasoning needs a surviving separator.
            const text = part.text === "" && hasSignedReasoning ? " " : part.text
            assistantMessage.parts.push({
              type: "text",
              text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          }
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            toolNames.add(part.tool)
            // altimate_change start — defensive replay-side id coercion. Parts
            // persisted after the ingestion fix already carry sanitized string ids;
            // transcripts written before it may hold malformed (non-string) callIDs.
            // Computing the sanitized id ONCE per tool part and using it for every
            // rendered half guarantees the tool-call and its paired tool-result emit
            // identical toolCallId values, so provider pairing validation cannot 400.
            const replayCallID = sanitizeToolCallID(part.callID)
            // altimate_change end
            if (part.state.status === "completed") {
              // altimate_change start — toolOutputMaxChars truncates long tool output for compaction
              const rawOutputText = part.state.time.compacted
                ? "[Old tool result content cleared]"
                : part.state.output
              const maxChars = options?.toolOutputMaxChars
              const outputText =
                !part.state.time.compacted && maxChars !== undefined && rawOutputText.length > maxChars
                  ? `${rawOutputText.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${
                      rawOutputText.length - maxChars
                    } chars]`
                  : rawOutputText
              // altimate_change end
              const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

              // For providers that don't support media in tool results, extract media files
              // (images, PDFs) to be sent as a separate user message
              const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
              const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
              if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
                media.push(...mediaAttachments)
              }
              const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

              const output =
                finalAttachments.length > 0
                  ? {
                      text: outputText,
                      attachments: finalAttachments,
                    }
                  : outputText

              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                // altimate_change start — replay-side id coercion
                toolCallId: replayCallID,
                // altimate_change end
                input: part.state.input,
                output,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            }
            if (part.state.status === "error") {
              // altimate_change start — upstream_fix: preserve partial output from aborted tools.
              const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
              if (typeof output === "string") {
                assistantMessage.parts.push({
                  type: ("tool-" + part.tool) as `tool-${string}`,
                  state: "output-available",
                  toolCallId: replayCallID,
                  input: part.state.input,
                  output,
                  ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
                })
              } else {
                assistantMessage.parts.push({
                  type: ("tool-" + part.tool) as `tool-${string}`,
                  state: "output-error",
                  toolCallId: replayCallID,
                  input: part.state.input,
                  errorText: part.state.error,
                  ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
                })
              }
              // altimate_change end
            }
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
            if (part.state.status === "pending" || part.state.status === "running")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                // altimate_change start — replay-side id coercion
                toolCallId: replayCallID,
                // altimate_change end
                input: part.state.input,
                errorText: "[Tool execution was interrupted]",
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
          }
          if (part.type === "reasoning") {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
          // Inject pending media as a user message for providers that don't support
          // media (images, PDFs) in tool results
          if (media.length > 0) {
            result.push({
              id: MessageID.ascending(),
              role: "user",
              parts: [
                {
                  type: "text" as const,
                  text: SYNTHETIC_ATTACHMENT_PROMPT,
                },
                ...media.map((attachment) => ({
                  type: "file" as const,
                  url: attachment.url,
                  mediaType: attachment.mime,
                })),
              ],
            })
          }
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

    // altimate_change start — upstream v1.17.9 made convertToModelMessages async
    // (returns Promise<ModelMessage[]>); use Effect.promise so the Effect resolves
    // to ModelMessage[] rather than Promise<ModelMessage[]>.
    return yield* Effect.promise(() =>
      convertToModelMessages(
        result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
        {
          //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
          tools,
        },
      ),
    )
    // altimate_change end
  })

  export function toModelMessages(
    input: WithParts[],
    model: Provider.Model,
    // altimate_change start — toolOutputMaxChars caps tool output length for compaction
    options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
    // altimate_change end
  ): Promise<ModelMessage[]> {
    return Effect.runPromise(toModelMessagesEffect(input, model, options))
  }

  export function page(input: { sessionID: SessionID; limit: number; before?: string }) {
    const before = input.before ? cursor.decode(input.before) : undefined
    const where = before
      ? and(eq(MessageTable.session_id, input.sessionID), older(before))
      : eq(MessageTable.session_id, input.sessionID)
    const rows = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(where)
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .limit(input.limit + 1)
        .all(),
    )
    if (rows.length === 0) {
      const row = Database.use((db) =>
        db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
      )
      if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
      return {
        items: [] as MessageV2.WithParts[],
        more: false,
      }
    }

    const more = rows.length > input.limit
    const slice = more ? rows.slice(0, input.limit) : rows
    const items = hydrate(slice)
    items.reverse()
    const tail = slice.at(-1)
    return {
      items,
      more,
      cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
    }
  }

  export function* stream(sessionID: SessionID) {
    const size = 50
    let before: string | undefined
    while (true) {
      const next = page({ sessionID, limit: size, before })
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        yield next.items[i]
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
  }

  export function parts(message_id: MessageID) {
    const rows = Database.use((db) =>
      db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
    )
    return rows.map(
      (row) =>
        ({
          ...row.data,
          id: row.id,
          sessionID: row.session_id,
          messageID: row.message_id,
        }) as MessageV2.Part,
    )
  }

  export function get(input: { sessionID: SessionID; messageID: MessageID }): WithParts {
    const row = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
        .get(),
    )
    if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
    return {
      info: info(row),
      parts: parts(input.messageID),
    }
  }

  export function filterCompacted(msgs: Iterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    // altimate_change — retain the post-summary tail that compaction kept.
    let includeUntil: MessageID | undefined
    let tailMove: { summaryIndex: number; compactionIndex: number } | undefined
    for (const msg of msgs) {
      result.push(msg)
      if (includeUntil && msg.info.id === includeUntil) break
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      ) {
        const tailStart = msg.parts.find((part) => part.type === "compaction")?.tail_start_id
        if (tailStart) {
          includeUntil = tailStart
          tailMove = {
            summaryIndex: result.findIndex(
              (item) => item.info.role === "assistant" && item.info.summary && item.info.parentID === msg.info.id,
            ),
            compactionIndex: result.length - 1,
          }
          continue
        }
        break
      }
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
        completed.add(msg.info.parentID)
    }
    // altimate_change start — render compacted summary before the retained tail.
    if (tailMove && tailMove.summaryIndex >= 0) {
      const newer = result.slice(0, tailMove.summaryIndex)
      const summary = result.slice(tailMove.summaryIndex, tailMove.compactionIndex + 1)
      const tail = result.slice(tailMove.compactionIndex + 1)
      return [...newer, ...tail, ...summary].reverse()
    }
    // altimate_change end
    result.reverse()
    return result
  }

  export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
    return filterCompacted(stream(sessionID))
  })

  // altimate_change start — extract loop "latest message state" selection into a testable helper.
  // Message IDs are monotonic/chronological, so selection must be by id, not array position:
  // filterCompacted reorders messages (#27145), so picking the array-latest finished assistant
  // lands on the pre-compaction overflow assistant and bypasses the summary overflow guard.
  export interface Latest {
    user?: User
    assistant?: Assistant
    finished?: Assistant
    tasks: (CompactionPart | SubtaskPart)[]
  }

  export function latest(msgs: Iterable<MessageV2.WithParts>): Latest {
    const list = [...msgs]
    let user: User | undefined
    let assistant: Assistant | undefined
    let finished: Assistant | undefined
    for (const msg of list) {
      if (msg.info.role === "user") {
        if (!user || msg.info.id > user.id) user = msg.info as User
        continue
      }
      if (msg.info.role === "assistant") {
        const info = msg.info as Assistant
        if (!assistant || info.id > assistant.id) assistant = info
        if (info.finish && (!finished || info.id > finished.id)) finished = info
      }
    }
    const tasks: (CompactionPart | SubtaskPart)[] = []
    for (const msg of list) {
      if (finished && msg.info.id <= finished.id) continue
      for (const part of msg.parts) {
        if (part.type === "compaction" || part.type === "subtask") tasks.push(part)
      }
    }
    return { user, assistant, finished, tasks }
  }
  // altimate_change end

  export function fromError(
    e: unknown,
    ctx: { providerID: ProviderID; aborted?: boolean },
  ): NonNullable<Assistant["error"]> {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
        if (ctx.aborted) {
          return new MessageV2.AbortedError({ message: e.message }, { cause: e }).toObject()
        }
        return new MessageV2.APIError(
          {
            message: "Response decompression failed",
            isRetryable: true,
            metadata: {
              code: (e as FetchDecompressionError).code,
              message: e.message,
            },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const parsed = ProviderError.parseAPICallError({
          providerID: ctx.providerID,
          error: e,
        })
        if (parsed.type === "context_overflow") {
          return new MessageV2.ContextOverflowError(
            {
              message: parsed.message,
              responseBody: parsed.responseBody,
            },
            { cause: e },
          ).toObject()
        }

        return new MessageV2.APIError(
          {
            message: parsed.message,
            statusCode: parsed.statusCode,
            isRetryable: parsed.isRetryable,
            responseHeaders: parsed.responseHeaders,
            responseBody: parsed.responseBody,
            metadata: parsed.metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error && /OAuth token refresh failed/i.test(e.message):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
      default:
        try {
          const parsed = ProviderError.parseStreamError(e)
          if (parsed) {
            if (parsed.type === "context_overflow") {
              return new MessageV2.ContextOverflowError(
                {
                  message: parsed.message,
                  responseBody: parsed.responseBody,
                },
                { cause: e },
              ).toObject()
            }
            return new MessageV2.APIError(
              {
                message: parsed.message,
                isRetryable: parsed.isRetryable,
                responseBody: parsed.responseBody,
              },
              {
                cause: e,
              },
            ).toObject()
          }
        } catch {}
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
    }
  }
}
