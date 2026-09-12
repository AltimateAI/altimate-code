// altimate_change - new file
import { describe, expect, test } from "bun:test"
import {
  attachReportSignature,
  bindingKey,
  buildAttachReport,
  errorCode,
  sanitizeDetail,
} from "../../../src/altimate/workspace/attach-report"

const declared = { keys: ["jira_search_issues", "echo", "ghost"], extensionKeys: ["pu_lineage"] }
const base = {
  bindingKey: "ssh://git@github.com/acme/jaffle-shop",
  cliVersion: "0.11.2",
  engineVersion: "0.7.2",
  declared,
  bridgeConnected: false,
  reportedAt: "2026-09-12T13:50:00.000Z",
}

describe("bindingKey", () => {
  test("prefers the git remote, falls back to the path, and is null with neither", () => {
    expect(bindingKey({ repoRemote: "ssh://a", projectPath: "/p" })).toBe("ssh://a")
    expect(bindingKey({ repoRemote: null, projectPath: "/p" })).toBe("/p")
    expect(bindingKey({ repoRemote: "", projectPath: null })).toBeNull()
  })
})

describe("sanitizeDetail", () => {
  test("keeps only a code and, for spawn failures, the command basename", () => {
    expect(sanitizeDetail("spawn /Users/x/bin/docker ENOENT", "spawn-failed")).toEqual({
      code: "ENOENT",
      command: "docker",
    })
    expect(sanitizeDetail("spawn C:\\Users\\x\\tools\\gh.exe ENOENT", "spawn-failed")).toEqual({
      code: "ENOENT",
      command: "gh.exe",
    })
    expect(sanitizeDetail("spawn altimate-e2e-missing-binary ENOENT", "spawn-failed")).toEqual({
      code: "ENOENT",
      command: "altimate-e2e-missing-binary",
    })
  })
  test("never forwards free text: paths, hosts and messages collapse to a code", () => {
    expect(sanitizeDetail("connect ECONNREFUSED 10.0.0.7:8443", "exception")).toEqual({ code: "ECONNREFUSED" })
    expect(sanitizeDetail("Invalid URL: http://[bad", "spawn-failed")).toEqual({ code: "invalid-url" })
    expect(sanitizeDetail("token expired for user@corp.example", "invalid-connection")).toEqual({ code: "other" })
    expect(sanitizeDetail(undefined, "spawn-failed")).toBeUndefined()
    expect(sanitizeDetail("", "spawn-failed")).toBeUndefined()
  })
  test("errorCode maps the recognised patterns", () => {
    expect(errorCode("Request timed out")).toBe("ETIMEDOUT")
    expect(errorCode("EACCES: permission denied")).toBe("EACCES")
    expect(errorCode("boom")).toBe("other")
  })
})

describe("buildAttachReport", () => {
  test("attached: declared vs delivered from the served set, unfulfilled sanitized", () => {
    const report = buildAttachReport({
      ...base,
      outcome: {
        kind: "attached",
        available: 1,
        declared: 3,
        missing: ["jira_search_issues", "ghost"],
        unfulfilled: [
          { key: "jira_search_issues", integrationId: "jira", reason: "invalid-connection" },
          { key: "ghost", integrationId: "mcp-ok", reason: "unknown-key" },
          { key: "pu_lineage", integrationId: "vscode-power-user", reason: "no-bridge" },
          {
            key: "whatever",
            integrationId: "mcp-missing-binary",
            reason: "spawn-failed",
            detail: "spawn /opt/tools/altimate-e2e-missing-binary ENOENT",
          },
        ],
      },
      present: new Set(["echo", "altimate_knowledge_search"]),
    })
    expect(report).toEqual({
      binding_key: base.bindingKey,
      outcome: "attached",
      cli_version: "0.11.2",
      engine_version: "0.7.2",
      bridge_connected: false,
      declared_keys: ["jira_search_issues", "echo", "ghost", "pu_lineage"],
      delivered_keys: ["echo"],
      unfulfilled: [
        { key: "jira_search_issues", integration_id: "jira", reason: "invalid-connection" },
        { key: "ghost", integration_id: "mcp-ok", reason: "unknown-key" },
        { key: "pu_lineage", integration_id: "vscode-power-user", reason: "no-bridge" },
        {
          key: "whatever",
          integration_id: "mcp-missing-binary",
          reason: "spawn-failed",
          detail: { code: "ENOENT", command: "altimate-e2e-missing-binary" },
        },
      ],
      reported_at: base.reportedAt,
    })
    expect(JSON.stringify(report)).not.toContain("/opt/tools")
  })
  test("attached without an allowlist reports what was served as delivered", () => {
    const report = buildAttachReport({
      ...base,
      declared: null,
      outcome: { kind: "attached", available: 2 },
      present: new Set(["echo", "dbt_build_model"]),
    })
    expect(report?.declared_keys).toEqual([])
    expect(report?.delivered_keys).toEqual(["echo", "dbt_build_model"])
  })
  test("failed outcomes carry the version the CLI saw, or null when the engine is missing", () => {
    expect(buildAttachReport({ ...base, outcome: { kind: "engine-missing", declared: 3 } })).toMatchObject({
      outcome: "engine-missing",
      engine_version: null,
      declared_keys: declared.keys.concat(declared.extensionKeys),
      delivered_keys: [],
    })
    expect(buildAttachReport({ ...base, outcome: { kind: "engine-too-old", found: "0.7.1" } })).toMatchObject({
      outcome: "engine-too-old",
      engine_version: "0.7.1",
    })
    expect(buildAttachReport({ ...base, outcome: { kind: "connect-failed", error: "x" } })).toMatchObject({
      outcome: "connect-failed",
      engine_version: "0.7.2",
    })
  })
  test("outcomes that are not about the engine produce no report", () => {
    expect(buildAttachReport({ ...base, outcome: { kind: "disabled" } })).toBeNull()
    expect(buildAttachReport({ ...base, outcome: { kind: "unbound" } })).toBeNull()
  })
  test("the signature ignores the timestamp and changes with the content", () => {
    const a = buildAttachReport({ ...base, outcome: { kind: "engine-too-old", found: "0.7.1" } })!
    const b = { ...a, reported_at: "2026-09-12T14:00:00.000Z" }
    const c = { ...a, engine_version: "0.7.0" }
    expect(attachReportSignature(a)).toBe(attachReportSignature(b))
    expect(attachReportSignature(a)).not.toBe(attachReportSignature(c))
  })
})
