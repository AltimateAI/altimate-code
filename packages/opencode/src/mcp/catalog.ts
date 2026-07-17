import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolAnnotationsSchema,
  ToolSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Effect } from "effect"
// altimate_change start — needed for the annotation-hint tolerance below (#792)
import z from "zod/v4"
// altimate_change end

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

// altimate_change start — Microsoft Fabric Core MCP returns `null` (instead of
// omitting the field) for `tool.annotations.{readOnlyHint,destructiveHint,
// idempotentHint,openWorldHint}`, which the SDK's strict schema (boolean,
// optional — no `null`) rejects. Accept `null` as "hint absent" here.
// See https://github.com/AltimateAI/altimate-code/issues/792.
const LenientToolAnnotationsSchema = ToolAnnotationsSchema.extend({
  readOnlyHint: z.boolean().nullable().optional(),
  destructiveHint: z.boolean().nullable().optional(),
  idempotentHint: z.boolean().nullable().optional(),
  openWorldHint: z.boolean().nullable().optional(),
})
// altimate_change end

// altimate_change start — exported (was module-private) and extended to also
// tolerate null annotation hints (#792); tests import this directly instead of
// duplicating a schema in mcp/index.ts.
export const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true })
    .extend({ annotations: LenientToolAnnotationsSchema.optional() })
    .array(),
})
// altimate_change end

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page = await list(cursor)
    result.push(...items(page))
    if (page.nextCursor === undefined) return result
    if (cursors.has(page.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${page.nextCursor}`)
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

export function defs(client: Client, timeout?: number) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT).pipe(Effect.catch(() => Effect.void))
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      const result = await client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal: options.abortSignal,
          timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
      if (result.isError)
        throw new Error(
          result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      if (result.structuredContent === undefined || result.structuredContent === null) return result
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      }
    },
  })
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      return Object.fromEntries(
        items.map((item) => [sanitizedClient + ":" + sanitize(item.name), { ...item, client: clientName }]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return paginate(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts,
  )
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources,
  )
}

function listTools(client: Client, timeout: number) {
  return Effect.tryPromise({
    try: () =>
      paginate(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, { timeout })
          } catch (error) {
            if (!(error instanceof Error)) throw error
            // altimate_change start — also retry for Fabric-style null-annotation
            // validation errors, not just outputSchema-reference errors (#792).
            // Both matchers are narrow (message-content based) so transport
            // failures and the pagination duplicate-cursor guard still rethrow.
            if (!isOutputSchemaValidationError(error) && !isAnnotationHintValidationError(error)) throw error
            return client
              .request({ method: "tools/list", params }, TolerantListToolsResultSchema, { timeout })
              .then((result) => ({ ...result, tools: result.tools.map(normalizeAnnotationHints) }))
            // altimate_change end
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

// altimate_change start — classify Fabric-style null-annotation-hint validation
// errors (#792). Keyed off the SDK's Zod validation-error message shape (a
// JSON array of issues with `"path": [..., "annotations", "<hint>"]`), never
// off transport or pagination-guard error text.
function isAnnotationHintValidationError(error: Error) {
  // Require the hint to appear as a path segment *immediately after* `annotations`
  // INSIDE a serialized Zod issue `"path"` array (e.g.
  // `"path":[...,"annotations","destructiveHint"]`). Matching the tokens
  // independently anywhere in the message would let an unrelated validation error
  // (a different field) whose text merely happens to mention these words trip the
  // tolerant retry; scoping the adjacency to the `"path"` array pins it to a genuine
  // annotation-hint error while still matching the real SDK/Fabric payload.
  return /"path"\s*:\s*\[[^\]]*"annotations"\s*,\s*"(readOnlyHint|destructiveHint|idempotentHint|openWorldHint)"/.test(
    error.message,
  )
}

// Collapse the `null` hint values the tolerant schema accepts back to `undefined`
// so tools returned from the fallback path match the SDK's strict `Tool` type
// (and downstream code never has to special-case `null` vs `undefined`).
function normalizeAnnotationHints(tool: {
  annotations?: {
    title?: string
    readOnlyHint?: boolean | null
    destructiveHint?: boolean | null
    idempotentHint?: boolean | null
    openWorldHint?: boolean | null
  }
}): MCPToolDef {
  return {
    ...tool,
    annotations: tool.annotations
      ? {
          ...tool.annotations,
          readOnlyHint: tool.annotations.readOnlyHint ?? undefined,
          destructiveHint: tool.annotations.destructiveHint ?? undefined,
          idempotentHint: tool.annotations.idempotentHint ?? undefined,
          openWorldHint: tool.annotations.openWorldHint ?? undefined,
        }
      : undefined,
  } as MCPToolDef
}
// altimate_change end

export * as McpCatalog from "./catalog"
