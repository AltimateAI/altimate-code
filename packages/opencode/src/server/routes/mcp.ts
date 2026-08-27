import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { MCP } from "../../mcp"
// altimate_change start — workspace mode owns the datamate key
import { DATAMATE_KEY } from "../../altimate/datamate-transport"
import { managedWorkspace } from "../../altimate/workspace/engine-overlay"
// altimate_change end
// altimate_change start — Config.Mcp + MCP.Status migrated to Effect Schema in v1.17.9; convert to zod for HTTP schemas
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { zod } from "@/util/effect-zod"
// altimate_change end
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const McpRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get MCP status",
        description: "Get the status of all Model Context Protocol (MCP) servers.",
        operationId: "mcp.status",
        responses: {
          200: {
            description: "MCP server status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), zod(MCP.Status))),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await MCP.status())
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Add MCP server",
        description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
        operationId: "mcp.add",
        responses: {
          200: {
            description: "MCP server added successfully",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), zod(MCP.Status))),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          name: z.string(),
          config: zod(ConfigMCPV1.Info),
        }),
      ),
      async (c) => {
        const { name, config } = c.req.valid("json")
        // altimate_change start — workspace mode owns the `datamate` key
        const managed = name === DATAMATE_KEY ? managedWorkspace() : null
        if (managed) {
          return c.json(
            { error: `MCP server "${name}" is managed by workspace "${managed.name}" in this project` },
            400,
          )
        }
        // altimate_change end
        const result = await MCP.add(name, config)
        return c.json(result.status)
      },
    )
    .post(
      "/:name/auth",
      describeRoute({
        summary: "Start MCP OAuth",
        description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
        operationId: "mcp.auth.start",
        responses: {
          200: {
            description: "OAuth flow started",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    authorizationUrl: z.string().describe("URL to open in browser for authorization"),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        const supportsOAuth = await MCP.supportsOAuth(name)
        if (!supportsOAuth) {
          return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
        }
        const result = await MCP.startAuth(name)
        // altimate_change start — upstream_fix: return only the documented `authorizationUrl`. startAuth
        // also carries `oauthState` (and a live MCP client on the already-authenticated path); returning
        // the raw result leaked OAuth state + a non-serializable client object (or 500'd on serialize).
        return c.json({ authorizationUrl: result.authorizationUrl })
        // altimate_change end
      },
    )
    .post(
      "/:name/auth/callback",
      describeRoute({
        summary: "Complete MCP OAuth",
        description:
          "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
        operationId: "mcp.auth.callback",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: {
              "application/json": {
                schema: resolver(zod(MCP.Status)),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          code: z.string().describe("Authorization code from OAuth callback"),
        }),
      ),
      async (c) => {
        const name = c.req.param("name")
        const { code } = c.req.valid("json")
        const status = await MCP.finishAuth(name, code)
        return c.json(status)
      },
    )
    .post(
      "/:name/auth/authenticate",
      describeRoute({
        summary: "Authenticate MCP OAuth",
        description: "Start OAuth flow and wait for callback (opens browser)",
        operationId: "mcp.auth.authenticate",
        responses: {
          200: {
            description: "OAuth authentication completed",
            content: {
              "application/json": {
                schema: resolver(zod(MCP.Status)),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        const supportsOAuth = await MCP.supportsOAuth(name)
        if (!supportsOAuth) {
          return c.json({ error: `MCP server ${name} does not support OAuth` }, 400)
        }
        const status = await MCP.authenticate(name)
        return c.json(status)
      },
    )
    .delete(
      "/:name/auth",
      describeRoute({
        summary: "Remove MCP OAuth",
        description: "Remove OAuth credentials for an MCP server",
        operationId: "mcp.auth.remove",
        responses: {
          200: {
            description: "OAuth credentials removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const name = c.req.param("name")
        await MCP.removeAuth(name)
        return c.json({ success: true as const })
      },
    )
    .post(
      "/:name/connect",
      describeRoute({
        description: "Connect an MCP server",
        operationId: "mcp.connect",
        responses: {
          200: {
            description: "MCP server connected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await MCP.connect(name)
        return c.json(true)
      },
    )
    .post(
      "/:name/disconnect",
      describeRoute({
        description: "Disconnect an MCP server",
        operationId: "mcp.disconnect",
        responses: {
          200: {
            description: "MCP server disconnected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const { name } = c.req.valid("param")
        await MCP.disconnect(name)
        return c.json(true)
      },
    ),
)
