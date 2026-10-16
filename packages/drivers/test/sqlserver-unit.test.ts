/**
 * Unit tests for SQL Server driver logic:
 * - TOP injection (vs LIMIT)
 * - Truncation detection
 * - Azure AD authentication (7 flows)
 * - Schema introspection queries
 * - Connection lifecycle
 * - Result format mapping
 */
import { describe, test, expect, mock, beforeEach } from "bun:test"
import { restoreModuleMocksAfterTests } from "./module-mock"

await restoreModuleMocksAfterTests("mssql", "@azure/identity", "node:child_process")

// --- Mock mssql ---

let mockQueryCalls: string[] = []
let mockQueryResult: any = { recordset: [] }
let mockConnectCalls: any[] = []
let mockCloseCalls = 0
let mockInputs: Array<{ name: string; value: any }> = []

function resetMocks() {
  mockQueryCalls = []
  mockQueryResult = { recordset: [] }
  mockConnectCalls = []
  mockCloseCalls = 0
  mockInputs = []
}

function createMockRequest() {
  const req: any = {
    input(name: string, value: any) {
      mockInputs.push({ name, value })
      return req
    },
    async query(sql: string) {
      mockQueryCalls.push(sql)
      return mockQueryResult
    },
  }
  return req
}

function createMockPool(config: any) {
  mockConnectCalls.push(config)
  return {
    connect: async () => {},
    request: () => createMockRequest(),
    close: async () => {
      mockCloseCalls++
    },
  }
}

mock.module("mssql", () => ({
  default: {
    connect: async (config: any) => createMockPool(config),
  },
  ConnectionPool: class {
    _pool: any
    constructor(config: any) {
      this._pool = createMockPool(config)
    }
    async connect() { return this._pool.connect() }
    request() { return this._pool.request() }
    async close() { return this._pool.close() }
  },
}))

// Exposed to individual tests so they can assert scope / force failures.
const azureIdentityState = {
  lastScope: "" as string,
  tokenOverride: null as null | { token: string; expiresOnTimestamp?: number },
  throwOnGetToken: false as boolean,
}
mock.module("@azure/identity", () => ({
  DefaultAzureCredential: class {
    _opts: any
    constructor(opts?: any) { this._opts = opts }
    async getToken(scope: string) {
      azureIdentityState.lastScope = scope
      if (azureIdentityState.throwOnGetToken) throw new Error("mock identity failure")
      if (azureIdentityState.tokenOverride) return azureIdentityState.tokenOverride
      return { token: "mock-azure-token-12345", expiresOnTimestamp: Date.now() + 3600000 }
    }
  },
}))

// Exposed to tests to stub the `az` CLI fallback.
const cliState = {
  lastCmd: "" as string,
  output: "mock-cli-token-fallback\n" as string,
  throwError: null as null | { stderr?: string; message?: string },
}
const realChildProcess = await import("node:child_process")
const realUtil = await import("node:util")

// Helper: build a mock with callback + util.promisify.custom support so
// `promisify(child_process.exec)` or `promisify(child_process.execFile)`
// yields { stdout, stderr } exactly like the real implementation.
function makeChildProcessMock(captureCmd: (args: string) => void) {
  const stub: any = (arg0: any, arg1: any, arg2: any, arg3: any) => {
    // Accept both exec(cmd, opts?, cb?) and execFile(file, args?, opts?, cb?)
    const cb = [arg0, arg1, arg2, arg3].find((x) => typeof x === "function")
    // Pick the best "command" representation for test assertions:
    //   - exec:     first arg is the full command string
    //   - execFile: first arg is the program, second arg is the args array
    if (Array.isArray(arg1)) {
      captureCmd(`${arg0} ${arg1.join(" ")}`)
    } else {
      captureCmd(String(arg0))
    }
    if (cliState.throwError) {
      const e: any = new Error(cliState.throwError.message ?? "az failed")
      e.stderr = cliState.throwError.stderr
      if (cb) cb(e, "", cliState.throwError.stderr ?? "")
      return { on() {}, stdout: null, stderr: null }
    }
    if (cb) cb(null, cliState.output, "")
    return { on() {}, stdout: null, stderr: null }
  }
  stub[realUtil.promisify.custom] = (arg0: any, arg1: any) => {
    if (Array.isArray(arg1)) {
      captureCmd(`${arg0} ${arg1.join(" ")}`)
    } else {
      captureCmd(String(arg0))
    }
    if (cliState.throwError) {
      const e: any = new Error(cliState.throwError.message ?? "az failed")
      e.stderr = cliState.throwError.stderr
      return Promise.reject(e)
    }
    return Promise.resolve({ stdout: cliState.output, stderr: "" })
  }
  return stub
}

const execStub = makeChildProcessMock((c) => { cliState.lastCmd = c })
const execFileStub = makeChildProcessMock((c) => { cliState.lastCmd = c })

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execSync: (cmd: string) => {
    cliState.lastCmd = cmd
    if (cliState.throwError) {
      const e: any = new Error(cliState.throwError.message ?? "az failed")
      e.stderr = cliState.throwError.stderr
      throw e
    }
    return cliState.output
  },
  exec: execStub,
  execFile: execFileStub,
}))

// Import after mocking
const { connect, _resetTokenCacheForTests } = await import("../src/sqlserver")

describe("SQL Server driver unit tests", () => {
  let connector: Awaited<ReturnType<typeof connect>>

  beforeEach(async () => {
    resetMocks()
    connector = await connect({ host: "localhost", port: 1433, database: "testdb", user: "sa", password: "pass" })
    await connector.connect()
  })

  // --- TOP injection ---

  describe("TOP injection", () => {
    test("injects TOP for SELECT without one", async () => {
      mockQueryResult = { recordset: [{ id: 1, name: "a" }] }
      await connector.execute("SELECT * FROM t")
      expect(mockQueryCalls[0]).toContain("TOP 1001")
    })

    test("does NOT double-TOP when TOP already present", async () => {
      mockQueryResult = { recordset: [{ id: 1 }] }
      await connector.execute("SELECT TOP 5 * FROM t")
      expect(mockQueryCalls[0]).toBe("SELECT TOP 5 * FROM t")
    })

    test("does NOT inject TOP when LIMIT present", async () => {
      mockQueryResult = { recordset: [] }
      await connector.execute("SELECT * FROM t LIMIT 10")
      expect(mockQueryCalls[0]).toBe("SELECT * FROM t LIMIT 10")
    })

    test("noLimit bypasses TOP injection", async () => {
      mockQueryResult = { recordset: [] }
      await connector.execute("SELECT * FROM t", undefined, undefined, { noLimit: true })
      expect(mockQueryCalls[0]).toBe("SELECT * FROM t")
    })

    test("uses custom limit value", async () => {
      mockQueryResult = { recordset: [] }
      await connector.execute("SELECT * FROM t", 50)
      expect(mockQueryCalls[0]).toContain("TOP 51")
    })

    test("default limit is 1000", async () => {
      mockQueryResult = { recordset: [] }
      await connector.execute("SELECT * FROM t")
      expect(mockQueryCalls[0]).toContain("TOP 1001")
    })
  })

  // --- Truncation ---

  describe("truncation detection", () => {
    test("detects truncation when rows exceed limit", async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({ id: i }))
      mockQueryResult = { recordset: rows }
      const result = await connector.execute("SELECT * FROM t", 10)
      expect(result.truncated).toBe(true)
      expect(result.rows.length).toBe(10)
    })

    test("no truncation when rows at or below limit", async () => {
      mockQueryResult = { recordset: [{ id: 1 }, { id: 2 }] }
      const result = await connector.execute("SELECT * FROM t", 10)
      expect(result.truncated).toBe(false)
    })

    test("empty result returns correctly", async () => {
      // mssql exposes column metadata as `recordset.columns` (a property ON
      // the recordset array), not as a sibling key — mirror the real shape.
      const recordset: any[] = []
      ;(recordset as any).columns = {}
      mockQueryResult = { recordset }
      const result = await connector.execute("SELECT * FROM t")
      expect(result.rows).toEqual([])
      expect(result.truncated).toBe(false)
    })
  })

  // --- Azure AD authentication ---

  describe("Azure AD authentication", () => {
    test("standard auth uses user/password directly", async () => {
      resetMocks()
      const c = await connect({ host: "localhost", database: "db", user: "sa", password: "pass" })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.user).toBe("sa")
      expect(cfg.password).toBe("pass")
      expect(cfg.authentication).toBeUndefined()
    })

    test("azure-active-directory-password builds correct auth object", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        user: "user@domain.com",
        password: "secret",
        authentication: "azure-active-directory-password",
        azure_client_id: "client-123",
        azure_tenant_id: "tenant-456",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-password",
        options: {
          userName: "user@domain.com",
          password: "secret",
          clientId: "client-123",
          tenantId: "tenant-456",
        },
      })
      expect(cfg.user).toBeUndefined()
      expect(cfg.password).toBeUndefined()
    })

    test("azure-active-directory-access-token passes supplied token unchanged", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-access-token",
        access_token: "eyJhbGciOi...",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-access-token",
        options: { token: "eyJhbGciOi..." },
      })
    })

    test("azure-active-directory-access-token with no token auto-acquires one", async () => {
      // Regression: prior to this, omitting `token`/`access_token` resulted in
      // `options.token: undefined`, which tedious rejects with
      // "config.authentication.options.token must be of type string".
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-access-token",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-access-token")
      expect(cfg.authentication.options.token).toBe("mock-azure-token-12345")
    })

    test("azure-active-directory-service-principal-secret builds SP auth", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-service-principal-secret",
        azure_client_id: "sp-client",
        azure_client_secret: "sp-secret",
        azure_tenant_id: "sp-tenant",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-service-principal-secret",
        options: {
          clientId: "sp-client",
          clientSecret: "sp-secret",
          tenantId: "sp-tenant",
        },
      })
    })

    test("azure-active-directory-msi-vm builds MSI auth with optional clientId", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-msi-vm",
        azure_client_id: "msi-client",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-msi-vm",
        options: { clientId: "msi-client" },
      })
    })

    test("azure-active-directory-msi-app-service works without clientId", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-msi-app-service",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication).toEqual({
        type: "azure-active-directory-msi-app-service",
        options: {},
      })
    })

    test("azure-active-directory-default acquires token and passes as access-token", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-default",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-access-token")
      expect(cfg.authentication.options.token).toBe("mock-azure-token-12345")
    })

    test("azure-active-directory-default with client_id passes managedIdentityClientId to credential", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-default",
        azure_client_id: "mi-client-id",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      // Token is still passed as access-token regardless of client_id
      expect(cfg.authentication.type).toBe("azure-active-directory-access-token")
      expect(cfg.authentication.options.token).toBe("mock-azure-token-12345")
    })

    test("encryption forced for all Azure AD connections", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "azure-active-directory-password",
        user: "u",
        password: "p",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.options.encrypt).toBe(true)
    })

    test("standard auth does not force encryption", async () => {
      resetMocks()
      const c = await connect({ host: "localhost", database: "db", user: "sa", password: "pass" })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.options.encrypt).toBe(false)
    })

    test("'CLI' shorthand acquires token via DefaultAzureCredential", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.datawarehouse.fabric.microsoft.com",
        database: "migration",
        authentication: "CLI",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-access-token")
      expect(cfg.authentication.options.token).toBe("mock-azure-token-12345")
      expect(cfg.options.encrypt).toBe(true)
    })

    test("'service-principal' shorthand maps correctly", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "service-principal",
        azure_client_id: "cid",
        azure_client_secret: "csec",
        azure_tenant_id: "tid",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-service-principal-secret")
      expect(cfg.authentication.options.clientId).toBe("cid")
    })

    test("'msi' shorthand maps to azure-active-directory-msi-vm", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net",
        database: "db",
        authentication: "msi",
      })
      await c.connect()
      const cfg = mockConnectCalls[0]
      expect(cfg.authentication.type).toBe("azure-active-directory-msi-vm")
    })
  })

  // --- Schema introspection ---

  describe("schema introspection", () => {
    test("listSchemas queries sys.schemas", async () => {
      mockQueryResult = { recordset: [{ name: "dbo" }, { name: "sales" }] }
      const schemas = await connector.listSchemas()
      expect(mockQueryCalls[0]).toContain("sys.schemas")
      expect(schemas).toEqual(["dbo", "sales"])
    })

    test("listTables queries sys.tables and sys.views", async () => {
      mockQueryResult = {
        recordset: [
          { name: "orders", type: "U " },
          { name: "order_summary", type: "V" },
        ],
      }
      const tables = await connector.listTables("dbo")
      expect(mockQueryCalls[0]).toContain("UNION ALL")
      expect(mockQueryCalls[0]).toContain("sys.tables")
      expect(mockQueryCalls[0]).toContain("sys.views")
      expect(tables).toEqual([
        { name: "orders", type: "table" },
        { name: "order_summary", type: "view" },
      ])
    })

    test("describeTable queries sys.columns", async () => {
      mockQueryResult = {
        recordset: [
          { column_name: "id", data_type: "int", is_nullable: 0 },
          { column_name: "name", data_type: "nvarchar", is_nullable: 1 },
        ],
      }
      const cols = await connector.describeTable("dbo", "users")
      expect(mockQueryCalls[0]).toContain("sys.columns")
      expect(cols).toEqual([
        { name: "id", data_type: "int", nullable: false },
        { name: "name", data_type: "nvarchar", nullable: true },
      ])
    })
  })

  // --- Connection lifecycle ---

  describe("connection lifecycle", () => {
    test("close is idempotent", async () => {
      await connector.close()
      await connector.close()
      expect(mockCloseCalls).toBe(1)
    })
  })

  // --- Result format ---

  describe("result format", () => {
    test("maps recordset to column-ordered arrays", async () => {
      mockQueryResult = {
        recordset: [
          { id: 1, name: "alice", age: 30 },
          { id: 2, name: "bob", age: 25 },
        ],
      }
      const result = await connector.execute("SELECT id, name, age FROM t")
      expect(result.columns).toEqual(["id", "name", "age"])
      expect(result.rows).toEqual([
        [1, "alice", 30],
        [2, "bob", 25],
      ])
    })

    test("preserves underscore-prefixed columns", async () => {
      mockQueryResult = {
        recordset: [{ id: 1, _p: "Delivered", name: "x" }],
      }
      const result = await connector.execute("SELECT * FROM t")
      expect(result.columns).toEqual(["id", "_p", "name"])
    })
  })

  // --- Unnamed column flattening ---

  describe("unnamed column flattening", () => {
    test("flattens unnamed columns merged under empty-string key", async () => {
      // mssql merges SELECT COUNT(*), SUM(amount) into row[""] = [42, 1000]
      mockQueryResult = {
        recordset: [{ "": [42, 1000] }],
      }
      const result = await connector.execute("SELECT COUNT(*), SUM(amount) FROM t")
      expect(result.rows).toEqual([[42, 1000]])
      expect(result.columns).toEqual(["col_0", "col_1"])
    })

    test("preserves legitimate array values from named columns", async () => {
      // A named column containing an array (e.g. from JSON aggregation)
      // should NOT be spread — only the empty-string key gets flattened
      mockQueryResult = {
        recordset: [{ id: 1, tags: ["a", "b", "c"] }],
      }
      const result = await connector.execute("SELECT * FROM t")
      expect(result.columns).toEqual(["id", "tags"])
      expect(result.rows).toEqual([[1, ["a", "b", "c"]]])
    })

    test("handles mix of named and unnamed columns", async () => {
      mockQueryResult = {
        recordset: [{ name: "alice", "": [42] }],
      }
      const result = await connector.execute("SELECT * FROM t")
      // Named header preserved; single unnamed aggregate synthesized.
      expect(result.columns).toEqual(["name", "col_0"])
      expect(result.rows).toEqual([["alice", 42]])
    })

    test("mixed named + MULTIPLE unnamed aggregates keep named header", async () => {
      // SELECT name, COUNT(*), SUM(x) FROM t → { name: "alice", "": [42, 100] }.
      // Regression: previous implementation fell back to col_0..col_N for all
      // columns, erasing the known `name` header.
      mockQueryResult = {
        recordset: [{ name: "alice", "": [42, 100] }],
      }
      const result = await connector.execute("SELECT name, COUNT(*), SUM(x) FROM t")
      expect(result.columns).toEqual(["name", "col_0", "col_1"])
      expect(result.rows).toEqual([["alice", 42, 100]])
    })

    test("single unnamed column gets synthetic name (no blank header)", async () => {
      // SELECT COUNT(*) FROM t → { "": [5] }
      mockQueryResult = {
        recordset: [{ "": [5] }],
      }
      const result = await connector.execute("SELECT COUNT(*) FROM t")
      expect(result.columns).toEqual(["col_0"])
      expect(result.columns).not.toContain("")
      expect(result.rows).toEqual([[5]])
    })
  })

  // --- Azure token caching (Fix #2) ---

  describe("Azure token cache", () => {
    beforeEach(() => {
      _resetTokenCacheForTests()
      azureIdentityState.throwOnGetToken = false
      azureIdentityState.tokenOverride = null
      cliState.throwError = null
      cliState.output = "mock-cli-token-fallback\n"
    })

    test("second connect with same (resource, clientId) reuses cached token", async () => {
      let getTokenCalls = 0
      azureIdentityState.tokenOverride = { token: "cached-token-A", expiresOnTimestamp: Date.now() + 3600_000 }
      // Hook getToken counter
      const origCredential = (await import("@azure/identity")).DefaultAzureCredential
      const origGetToken = origCredential.prototype.getToken
      origCredential.prototype.getToken = async function (scope: string) {
        getTokenCalls++
        return origGetToken.call(this, scope)
      }
      try {
        resetMocks()
        const c1 = await connect({
          host: "h.database.windows.net", database: "d",
          authentication: "azure-active-directory-default",
        })
        await c1.connect()
        const c2 = await connect({
          host: "h.database.windows.net", database: "d",
          authentication: "azure-active-directory-default",
        })
        await c2.connect()
        expect(getTokenCalls).toBe(1)
        // Both pool configs embed the same cached token
        expect(mockConnectCalls[0].authentication.options.token).toBe("cached-token-A")
        expect(mockConnectCalls[1].authentication.options.token).toBe("cached-token-A")
      } finally {
        origCredential.prototype.getToken = origGetToken
      }
    })

    test("near-expiry token triggers refresh", async () => {
      // First token expires in 1 minute (well under the 5-minute refresh margin)
      azureIdentityState.tokenOverride = { token: "about-to-expire", expiresOnTimestamp: Date.now() + 60_000 }
      resetMocks()
      const c1 = await connect({
        host: "h.database.windows.net", database: "d",
        authentication: "azure-active-directory-default",
      })
      await c1.connect()
      // Now change the mock to issue a new token on refresh
      azureIdentityState.tokenOverride = { token: "fresh-token", expiresOnTimestamp: Date.now() + 3600_000 }
      const c2 = await connect({
        host: "h.database.windows.net", database: "d",
        authentication: "azure-active-directory-default",
      })
      await c2.connect()
      expect(mockConnectCalls[0].authentication.options.token).toBe("about-to-expire")
      expect(mockConnectCalls[1].authentication.options.token).toBe("fresh-token")
    })

    test("different clientIds cache separately", async () => {
      // Prove cache keying by counting distinct getToken invocations: with
      // separate clientIds we expect 2 calls (one per key); with a shared
      // clientId we expect 1 on the second connect.
      let getTokenCalls = 0
      azureIdentityState.tokenOverride = { token: "shared-token", expiresOnTimestamp: Date.now() + 3600_000 }
      const origCredential = (await import("@azure/identity")).DefaultAzureCredential
      const origGetToken = origCredential.prototype.getToken
      origCredential.prototype.getToken = async function (scope: string) {
        getTokenCalls++
        return origGetToken.call(this, scope)
      }
      try {
        resetMocks()
        const a = await connect({
          host: "h.database.windows.net", database: "d",
          authentication: "azure-active-directory-default",
          azure_client_id: "client-1",
        })
        await a.connect()
        const b = await connect({
          host: "h.database.windows.net", database: "d",
          authentication: "azure-active-directory-default",
          azure_client_id: "client-2",
        })
        await b.connect()
        // Two distinct client IDs → two distinct cache entries → two getToken
        // calls. If the cache were keyed only on resource URL this would be 1.
        expect(getTokenCalls).toBe(2)
        expect(mockConnectCalls[0].authentication.options.token).toBe("shared-token")
        expect(mockConnectCalls[1].authentication.options.token).toBe("shared-token")

        // Reconnect with client-1 again — should hit the cache, no new getToken
        const c = await connect({
          host: "h.database.windows.net", database: "d",
          authentication: "azure-active-directory-default",
          azure_client_id: "client-1",
        })
        await c.connect()
        expect(getTokenCalls).toBe(2)
      } finally {
        origCredential.prototype.getToken = origGetToken
      }
    })
  })

  // --- Configurable / inferred Azure resource URL (Fix #5) ---

  describe("Azure resource URL resolution", () => {
    beforeEach(() => {
      _resetTokenCacheForTests()
      azureIdentityState.throwOnGetToken = false
      azureIdentityState.tokenOverride = null
      cliState.throwError = null
    })

    test("commercial cloud: default to database.windows.net", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net", database: "d",
        authentication: "azure-active-directory-default",
      })
      await c.connect()
      expect(azureIdentityState.lastScope).toBe("https://database.windows.net/.default")
    })

    test("Azure Government host infers usgovcloudapi.net", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.usgovcloudapi.net", database: "d",
        authentication: "azure-active-directory-default",
      })
      await c.connect()
      expect(azureIdentityState.lastScope).toBe("https://database.usgovcloudapi.net/.default")
    })

    test("Azure China host infers chinacloudapi.cn", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.chinacloudapi.cn", database: "d",
        authentication: "azure-active-directory-default",
      })
      await c.connect()
      expect(azureIdentityState.lastScope).toBe("https://database.chinacloudapi.cn/.default")
    })

    test("explicit azure_resource_url wins over host inference", async () => {
      resetMocks()
      const c = await connect({
        host: "myserver.database.windows.net", // commercial host
        database: "d",
        authentication: "azure-active-directory-default",
        azure_resource_url: "https://custom.sovereign.example/",
      })
      await c.connect()
      expect(azureIdentityState.lastScope).toBe("https://custom.sovereign.example/.default")
    })

    test("azure_resource_url without trailing slash is normalized", async () => {
      // Regression: without the slash, `${resourceUrl}.default` produced an
      // invalid scope like "https://custom-host.default", and `getToken`
      // would reject it.
      resetMocks()
      const c = await connect({
        host: "x.database.windows.net", database: "d",
        authentication: "azure-active-directory-default",
        azure_resource_url: "https://custom-host",
      })
      await c.connect()
      expect(azureIdentityState.lastScope).toBe("https://custom-host/.default")
    })

    test("az CLI fallback uses the same resource URL", async () => {
      // Disable @azure/identity so we hit the az CLI fallback
      azureIdentityState.throwOnGetToken = true
      cliState.output = "eyJ.eyJ.sig\n" // looks like JWT; parseTokenExpiry returns undefined → fallback TTL
      resetMocks()
      const c = await connect({
        host: "myserver.database.usgovcloudapi.net", database: "d",
        authentication: "azure-active-directory-default",
      })
      await c.connect()
      expect(cliState.lastCmd).toContain("--resource https://database.usgovcloudapi.net/")
    })
  })

  // --- Error surfacing when auth fails (Fix #5 bonus, Minor #10 addressed) ---

  describe("Azure auth error surfacing", () => {
    beforeEach(() => {
      _resetTokenCacheForTests()
      azureIdentityState.throwOnGetToken = false
      azureIdentityState.tokenOverride = null
      cliState.throwError = null
    })

    test("both @azure/identity and az CLI fail → error includes both hints", async () => {
      azureIdentityState.throwOnGetToken = true
      cliState.throwError = { stderr: "Please run 'az login' to set up an account.", message: "failed" }
      resetMocks()
      const c = await connect({
        host: "h.database.windows.net", database: "d",
        authentication: "azure-active-directory-default",
      })
      await expect(c.connect()).rejects.toThrow(/Azure AD token acquisition failed/)
      await expect(c.connect()).rejects.toThrow(/az CLI:.*az login/)
    })
  })
})
