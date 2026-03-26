import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { execSync } from "child_process"
import { createConnection } from "net"
import type { Connector, ConnectorResult, SchemaColumn } from "@altimateai/drivers/types"

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

const HAS_CI_SERVICE = !!process.env.TEST_MONGODB_HOST
const DOCKER_OPT_IN = process.env.DRIVER_E2E_DOCKER === "1"

function isDockerAvailable(): boolean {
  if (HAS_CI_SERVICE) return true
  if (!DOCKER_OPT_IN) return false
  try {
    execSync("docker info", { stdio: "ignore", timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function waitForPort(port: number, timeout = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const attempt = () => {
      const sock = createConnection({ host: "127.0.0.1", port })
      sock.once("connect", () => {
        sock.destroy()
        resolve()
      })
      sock.once("error", () => {
        sock.destroy()
        if (Date.now() - start > timeout) {
          reject(new Error(`Port ${port} not ready after ${timeout}ms`))
        } else {
          setTimeout(attempt, 500)
        }
      })
    }
    attempt()
  })
}

async function waitForMongoReady(connectFn: () => Promise<Connector>, timeout = 60000): Promise<Connector> {
  const start = Date.now()
  let lastErr: any
  while (Date.now() - start < timeout) {
    try {
      const connector = await connectFn()
      await connector.connect()
      // Verify the connection works with a simple command
      await connector.execute(
        JSON.stringify({
          command: "find",
          database: "admin",
          collection: "system.version",
          limit: 1,
        }),
      )
      return connector
    } catch (e: any) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw new Error(`MongoDB not ready after ${timeout}ms: ${lastErr?.message}`)
}

function dockerRm(name: string) {
  try {
    execSync(`docker rm -f ${name}`, { stdio: "ignore", timeout: 10000 })
  } catch {}
}

function dockerRun(args: string) {
  execSync(`docker run ${args}`, { stdio: "ignore", timeout: 120000 })
}

function cmd(query: Record<string, unknown>): string {
  return JSON.stringify(query)
}

const DOCKER = isDockerAvailable()
const MONGODB_CONTAINER = "altimate-test-mongodb"
const MONGODB_HOST = process.env.TEST_MONGODB_HOST || "127.0.0.1"
const MONGODB_PORT = Number(process.env.TEST_MONGODB_PORT) || 27017
const MONGODB_USE_CI = !!process.env.TEST_MONGODB_HOST

// ---------------------------------------------------------------------------
// MongoDB E2E Tests
// ---------------------------------------------------------------------------

describe.skipIf(!DOCKER && !MONGODB_USE_CI)("MongoDB Driver E2E", () => {
  let connector: Connector

  beforeAll(async () => {
    if (!MONGODB_USE_CI) {
      dockerRm(MONGODB_CONTAINER)
      dockerRun(`-d --name ${MONGODB_CONTAINER} ` + `-p ${MONGODB_PORT}:27017 ` + `mongo:7.0`)
    }
    await waitForPort(MONGODB_PORT, 30000)
    const { connect } = await import("@altimateai/drivers/mongodb")
    connector = await waitForMongoReady(async () => {
      return await connect({
        type: "mongodb",
        host: MONGODB_HOST,
        port: MONGODB_PORT,
        database: "testdb",
      })
    }, 60000)
  }, 150000)

  afterAll(async () => {
    if (connector) {
      // Clean up test databases
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
            collection: "users",
          }),
        )
      } catch {}
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
            collection: "products",
          }),
        )
      } catch {}
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
            collection: "orders",
          }),
        )
      } catch {}
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "adversarial_db",
            collection: "weird_names",
          }),
        )
      } catch {}
      try {
        await connector.close()
      } catch {}
    }
    dockerRm(MONGODB_CONTAINER)
  })

  // =========================================================================
  // Connection Tests
  // =========================================================================

  describe("Connection", () => {
    test("connects with host/port", () => {
      expect(connector).toBeDefined()
    })

    test("connects with connection_string", async () => {
      const { connect } = await import("@altimateai/drivers/mongodb")
      const conn = await connect({
        type: "mongodb",
        connection_string: `mongodb://${MONGODB_HOST}:${MONGODB_PORT}`,
        database: "testdb",
      })
      await conn.connect()
      const result = await conn.execute(
        cmd({
          command: "find",
          database: "admin",
          collection: "system.version",
          limit: 1,
        }),
      )
      expect(result).toBeDefined()
      await conn.close()
    })

    test("close() cleans up and prevents further operations", async () => {
      const { connect } = await import("@altimateai/drivers/mongodb")
      const conn = await connect({
        type: "mongodb",
        host: MONGODB_HOST,
        port: MONGODB_PORT,
        database: "testdb",
      })
      await conn.connect()
      await conn.close()
      // After close, operations should fail
      await expect(conn.execute(cmd({ command: "find", database: "testdb", collection: "users" }))).rejects.toThrow()
    })
  })

  // =========================================================================
  // CRUD Operations
  // =========================================================================

  describe("CRUD Operations", () => {
    beforeAll(async () => {
      // Ensure clean state
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
            collection: "users",
          }),
        )
      } catch {}
    })

    test("insertOne — single document", async () => {
      const result = await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: { name: "alice", age: 30, email: "alice@example.com", active: true },
        }),
      )
      expect(result.columns).toEqual(["insertedId"])
      expect(result.row_count).toBe(1)
      expect(result.rows[0][0]).toBeDefined() // ObjectId string
    })

    test("insertMany — multiple documents", async () => {
      const result = await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "users",
          documents: [
            { name: "bob", age: 25, email: "bob@example.com", active: false },
            { name: "charlie", age: 35, email: "charlie@example.com", active: true },
            { name: "diana", age: 28, email: "diana@example.com", active: true },
            { name: "eve", age: 40, email: "eve@example.com", active: false },
          ],
        }),
      )
      expect(result.columns).toEqual(["insertedCount"])
      expect(result.rows[0][0]).toBe(4)
    })

    test("find — all documents", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
        }),
      )
      expect(result.row_count).toBe(5)
      expect(result.columns).toContain("name")
      expect(result.columns).toContain("age")
      expect(result.columns).toContain("email")
      expect(result.columns).toContain("_id")
    })

    test("find — with filter", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { active: true },
        }),
      )
      expect(result.row_count).toBe(3) // alice, charlie, diana
      const names = result.rows.map((r) => r[result.columns.indexOf("name")])
      expect(names).toContain("alice")
      expect(names).toContain("charlie")
      expect(names).toContain("diana")
    })

    test("find — with projection", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "alice" },
          projection: { name: 1, age: 1, _id: 0 },
        }),
      )
      expect(result.row_count).toBe(1)
      expect(result.columns).toEqual(["name", "age"])
      expect(result.rows[0]).toEqual(["alice", 30])
    })

    test("find — with sort", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          projection: { name: 1, age: 1, _id: 0 },
          sort: { age: 1 },
        }),
      )
      const ages = result.rows.map((r) => r[result.columns.indexOf("age")])
      expect(ages).toEqual([25, 28, 30, 35, 40])
    })

    test("find — with sort descending", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          projection: { name: 1, age: 1, _id: 0 },
          sort: { age: -1 },
        }),
      )
      const ages = result.rows.map((r) => r[result.columns.indexOf("age")])
      expect(ages).toEqual([40, 35, 30, 28, 25])
    })

    test("find — with skip and limit", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          projection: { name: 1, _id: 0 },
          sort: { age: 1 },
          skip: 1,
          limit: 2,
        }),
      )
      expect(result.row_count).toBe(2)
      const names = result.rows.map((r) => r[0])
      expect(names).toEqual(["diana", "alice"]) // age 28, 30
    })

    test("find — comparison operators ($gt, $lte, $ne)", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { age: { $gt: 30, $lte: 40 } },
          projection: { name: 1, _id: 0 },
          sort: { age: 1 },
        }),
      )
      const names = result.rows.map((r) => r[0])
      expect(names).toEqual(["charlie", "eve"]) // 35, 40
    })

    test("find — logical operators ($or, $and)", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: {
            $or: [{ name: "alice" }, { age: { $gte: 40 } }],
          },
          projection: { name: 1, _id: 0 },
          sort: { name: 1 },
        }),
      )
      const names = result.rows.map((r) => r[0])
      expect(names).toEqual(["alice", "eve"])
    })

    test("find — regex filter", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: { $regex: "^[ab]", $options: "i" } },
          projection: { name: 1, _id: 0 },
          sort: { name: 1 },
        }),
      )
      const names = result.rows.map((r) => r[0])
      expect(names).toEqual(["alice", "bob"])
    })

    test("find — $in operator", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: { $in: ["alice", "eve"] } },
          projection: { name: 1, _id: 0 },
          sort: { name: 1 },
        }),
      )
      expect(result.rows.map((r) => r[0])).toEqual(["alice", "eve"])
    })

    test("find — $exists operator", async () => {
      // All users have "email" field
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { email: { $exists: true } },
        }),
      )
      expect(result.row_count).toBe(5)
    })

    test("updateOne — modifies a single document", async () => {
      const result = await connector.execute(
        cmd({
          command: "updateOne",
          database: "testdb",
          collection: "users",
          filter: { name: "alice" },
          update: { $set: { age: 31, role: "admin" } },
        }),
      )
      expect(result.columns).toEqual(["matchedCount", "modifiedCount"])
      expect(result.rows[0]).toEqual([1, 1])

      // Verify the update
      const verify = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "alice" },
          projection: { age: 1, role: 1, _id: 0 },
        }),
      )
      expect(verify.rows[0]).toEqual([31, "admin"])
    })

    test("updateMany — modifies multiple documents", async () => {
      const result = await connector.execute(
        cmd({
          command: "updateMany",
          database: "testdb",
          collection: "users",
          filter: { active: false },
          update: { $set: { active: true } },
        }),
      )
      expect(result.rows[0][0]).toBe(2) // bob, eve matched
      expect(result.rows[0][1]).toBe(2) // both modified
    })

    test("countDocuments — counts with filter", async () => {
      const result = await connector.execute(
        cmd({
          command: "countDocuments",
          database: "testdb",
          collection: "users",
          filter: { active: true },
        }),
      )
      expect(result.columns).toEqual(["count"])
      expect(result.rows[0][0]).toBe(5) // all are now active after updateMany
    })

    test("countDocuments — counts all", async () => {
      const result = await connector.execute(
        cmd({
          command: "countDocuments",
          database: "testdb",
          collection: "users",
        }),
      )
      expect(result.rows[0][0]).toBe(5)
    })

    test("distinct — returns unique values", async () => {
      // Reset some users to inactive for distinct test
      await connector.execute(
        cmd({
          command: "updateMany",
          database: "testdb",
          collection: "users",
          filter: { name: { $in: ["bob", "eve"] } },
          update: { $set: { active: false } },
        }),
      )
      const result = await connector.execute(
        cmd({
          command: "distinct",
          database: "testdb",
          collection: "users",
          field: "active",
        }),
      )
      expect(result.columns).toEqual(["active"])
      const values = result.rows.map((r) => r[0]).sort()
      expect(values).toEqual([false, true])
    })

    test("deleteOne — removes a single document", async () => {
      const result = await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "users",
          filter: { name: "eve" },
        }),
      )
      expect(result.columns).toEqual(["deletedCount"])
      expect(result.rows[0][0]).toBe(1)

      // Verify deletion
      const count = await connector.execute(
        cmd({
          command: "countDocuments",
          database: "testdb",
          collection: "users",
        }),
      )
      expect(count.rows[0][0]).toBe(4)
    })

    test("deleteMany — removes multiple documents", async () => {
      // Insert some temp docs to delete
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "users",
          documents: [
            { name: "temp1", age: 99, active: false },
            { name: "temp2", age: 99, active: false },
          ],
        }),
      )
      const result = await connector.execute(
        cmd({
          command: "deleteMany",
          database: "testdb",
          collection: "users",
          filter: { age: 99 },
        }),
      )
      expect(result.rows[0][0]).toBe(2)
    })
  })

  // =========================================================================
  // Aggregation Pipeline
  // =========================================================================

  describe("Aggregation Pipeline", () => {
    beforeAll(async () => {
      // Set up products collection for aggregation tests
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
            collection: "products",
          }),
        )
      } catch {}
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "products",
          documents: [
            { name: "Widget A", category: "widgets", price: 10, quantity: 100 },
            { name: "Widget B", category: "widgets", price: 20, quantity: 50 },
            { name: "Gadget A", category: "gadgets", price: 50, quantity: 30 },
            { name: "Gadget B", category: "gadgets", price: 75, quantity: 15 },
            { name: "Gadget C", category: "gadgets", price: 100, quantity: 5 },
            { name: "Doohickey", category: "misc", price: 5, quantity: 200 },
          ],
        }),
      )
    })

    test("aggregate — $group with $sum and $avg", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "products",
          pipeline: [
            {
              $group: {
                _id: "$category",
                totalQuantity: { $sum: "$quantity" },
                avgPrice: { $avg: "$price" },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ],
        }),
      )
      expect(result.row_count).toBe(3)
      const categories = result.rows.map((r) => r[result.columns.indexOf("_id")])
      expect(categories).toEqual(["gadgets", "misc", "widgets"])

      // Check gadgets: 30+15+5=50 quantity, (50+75+100)/3=75 avg price
      const gadgetRow = result.rows[categories.indexOf("gadgets")]
      expect(gadgetRow[result.columns.indexOf("totalQuantity")]).toBe(50)
      expect(gadgetRow[result.columns.indexOf("avgPrice")]).toBe(75)
      expect(gadgetRow[result.columns.indexOf("count")]).toBe(3)
    })

    test("aggregate — $match + $project", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "products",
          pipeline: [
            { $match: { price: { $gte: 50 } } },
            { $project: { name: 1, price: 1, _id: 0 } },
            { $sort: { price: 1 } },
          ],
        }),
      )
      expect(result.row_count).toBe(3)
      const names = result.rows.map((r) => r[result.columns.indexOf("name")])
      expect(names).toEqual(["Gadget A", "Gadget B", "Gadget C"])
    })

    test("aggregate — $addFields with computed values", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "products",
          pipeline: [
            {
              $addFields: {
                totalValue: { $multiply: ["$price", "$quantity"] },
              },
            },
            { $project: { name: 1, totalValue: 1, _id: 0 } },
            { $sort: { totalValue: -1 } },
          ],
        }),
      )
      expect(result.row_count).toBe(6)
      // Gadget A: 50*30=1500, Widget B: 20*50=1000, Widget A: 10*100=1000, Doohickey: 5*200=1000
      const firstRow = result.rows[0]
      expect(firstRow[result.columns.indexOf("name")]).toBe("Gadget A")
      expect(firstRow[result.columns.indexOf("totalValue")]).toBe(1500)
    })

    test("aggregate — $unwind", async () => {
      // Insert a document with an array field
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "products",
          document: { name: "Multi-Tag", category: "tagged", price: 10, quantity: 1, tags: ["a", "b", "c"] },
        }),
      )
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "products",
          pipeline: [{ $match: { name: "Multi-Tag" } }, { $unwind: "$tags" }, { $project: { tags: 1, _id: 0 } }],
        }),
      )
      expect(result.row_count).toBe(3)
      expect(result.rows.map((r) => r[0])).toEqual(["a", "b", "c"])

      // Cleanup
      await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "products",
          filter: { name: "Multi-Tag" },
        }),
      )
    })

    test("aggregate — $lookup (join between collections)", async () => {
      // Set up orders collection
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
            collection: "orders",
          }),
        )
      } catch {}
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "orders",
          documents: [
            { product_name: "Widget A", quantity: 3, customer: "cust1" },
            { product_name: "Gadget B", quantity: 1, customer: "cust2" },
          ],
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "orders",
          pipeline: [
            {
              $lookup: {
                from: "products",
                localField: "product_name",
                foreignField: "name",
                as: "product_info",
              },
            },
            { $project: { product_name: 1, customer: 1, product_info: 1, _id: 0 } },
            { $sort: { product_name: 1 } },
          ],
        }),
      )
      expect(result.row_count).toBe(2)
      // product_info will be JSON-serialized arrays
      const firstInfo = JSON.parse(result.rows[0][result.columns.indexOf("product_info")])
      expect(firstInfo).toBeInstanceOf(Array)
      expect(firstInfo.length).toBe(1)
      expect(firstInfo[0].name).toBe("Gadget B")
    })

    test("aggregate — empty pipeline returns all docs", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "products",
          pipeline: [],
        }),
      )
      expect(result.row_count).toBe(6)
    })

    test("aggregate — $count stage", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "products",
          pipeline: [{ $match: { category: "gadgets" } }, { $count: "total" }],
        }),
      )
      expect(result.row_count).toBe(1)
      expect(result.rows[0][result.columns.indexOf("total")]).toBe(3)
    })

    test("aggregate — $bucket", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "products",
          pipeline: [
            {
              $bucket: {
                groupBy: "$price",
                boundaries: [0, 25, 50, 100, 200],
                default: "other",
                output: { count: { $sum: 1 } },
              },
            },
          ],
        }),
      )
      expect(result.row_count).toBeGreaterThan(0)
      expect(result.columns).toContain("_id")
      expect(result.columns).toContain("count")
    })
  })

  // =========================================================================
  // Schema Introspection
  // =========================================================================

  describe("Schema Introspection", () => {
    test("listSchemas — returns databases (excludes local/config)", async () => {
      const schemas = await connector.listSchemas()
      expect(Array.isArray(schemas)).toBe(true)
      expect(schemas).toContain("testdb")
      // System databases should be filtered
      expect(schemas).not.toContain("local")
      expect(schemas).not.toContain("config")
    })

    test("listTables — returns collections in a database", async () => {
      const tables = await connector.listTables("testdb")
      expect(Array.isArray(tables)).toBe(true)
      const names = tables.map((t) => t.name)
      expect(names).toContain("users")
      expect(names).toContain("products")
      // All should be collections
      for (const t of tables) {
        expect(t.type).toBe("collection")
      }
    })

    test("listTables — sorted alphabetically", async () => {
      const tables = await connector.listTables("testdb")
      const names = tables.map((t) => t.name)
      const sorted = [...names].sort()
      expect(names).toEqual(sorted)
    })

    test("listTables — empty database returns empty array", async () => {
      const tables = await connector.listTables("nonexistent_db_xyz")
      expect(tables).toEqual([])
    })

    test("describeTable — infers field types from sample", async () => {
      const columns = await connector.describeTable("testdb", "users")
      expect(columns.length).toBeGreaterThan(0)

      // _id should be first
      expect(columns[0].name).toBe("_id")
      expect(columns[0].data_type).toBe("objectId")

      // Find name column
      const nameCol = columns.find((c) => c.name === "name")
      expect(nameCol).toBeDefined()
      expect(nameCol!.data_type).toBe("string")

      // Find age column
      const ageCol = columns.find((c) => c.name === "age")
      expect(ageCol).toBeDefined()
      // age could be int32 or double depending on BSON handling
      expect(["int32", "double"]).toContain(ageCol!.data_type)

      // Find active column
      const activeCol = columns.find((c) => c.name === "active")
      expect(activeCol).toBeDefined()
      expect(activeCol!.data_type).toBe("bool")
    })

    test("describeTable — empty collection returns empty array", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "empty_coll",
        }),
      )
      const columns = await connector.describeTable("testdb", "empty_coll")
      expect(columns).toEqual([])
      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "empty_coll",
        }),
      )
    })

    test("describeTable — mixed-type fields show union type", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "mixed_types",
        }),
      )
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "mixed_types",
          documents: [{ value: 42 }, { value: "hello" }, { value: true }],
        }),
      )
      const columns = await connector.describeTable("testdb", "mixed_types")
      const valueCol = columns.find((c) => c.name === "value")
      expect(valueCol).toBeDefined()
      // Should show union type since values are mixed
      expect(valueCol!.data_type).toContain("|")

      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "mixed_types",
        }),
      )
    })
  })

  // =========================================================================
  // Collection Management
  // =========================================================================

  describe("Collection Management", () => {
    test("createCollection — creates a new collection", async () => {
      const result = await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "temp_coll",
        }),
      )
      expect(result.rows[0][0]).toBe("ok")

      // Verify it exists
      const tables = await connector.listTables("testdb")
      expect(tables.map((t) => t.name)).toContain("temp_coll")
    })

    test("dropCollection — drops an existing collection", async () => {
      const result = await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "temp_coll",
        }),
      )
      expect(result.rows[0][0]).toBe(true)

      // Verify it's gone
      const tables = await connector.listTables("testdb")
      expect(tables.map((t) => t.name)).not.toContain("temp_coll")
    })

    test("dropCollection — non-existent collection does not throw", async () => {
      // MongoDB 7.0+ returns true even for non-existent collections (no NamespaceNotFound error)
      const result = await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "does_not_exist_xyz",
        }),
      )
      expect(result.columns).toEqual(["dropped"])
      expect(result.row_count).toBe(1)
    })
  })

  // =========================================================================
  // Index Operations
  // =========================================================================

  describe("Index Operations", () => {
    test("createIndex — creates an index on a field", async () => {
      const result = await connector.execute(
        cmd({
          command: "createIndex",
          database: "testdb",
          collection: "users",
          keys: { email: 1 },
          options: { unique: true },
        }),
      )
      expect(result.columns).toEqual(["indexName"])
      expect(result.rows[0][0]).toBe("email_1")
    })

    test("createIndex — compound index", async () => {
      const result = await connector.execute(
        cmd({
          command: "createIndex",
          database: "testdb",
          collection: "users",
          keys: { name: 1, age: -1 },
        }),
      )
      expect(result.rows[0][0]).toBe("name_1_age_-1")
    })

    test("listIndexes — returns all indexes", async () => {
      const result = await connector.execute(
        cmd({
          command: "listIndexes",
          database: "testdb",
          collection: "users",
        }),
      )
      expect(result.columns).toEqual(["name", "key", "unique"])
      expect(result.row_count).toBeGreaterThanOrEqual(3) // _id, email_1, name_1_age_-1
      const names = result.rows.map((r) => r[0])
      expect(names).toContain("_id_")
      expect(names).toContain("email_1")
      expect(names).toContain("name_1_age_-1")
    })
  })

  // =========================================================================
  // Truncation / LIMIT behavior
  // =========================================================================

  describe("LIMIT and Truncation", () => {
    beforeAll(async () => {
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
            collection: "big_coll",
          }),
        )
      } catch {}
      // Insert 50 documents
      const docs = Array.from({ length: 50 }, (_, i) => ({ idx: i, data: `row_${i}` }))
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "big_coll",
          documents: docs,
        }),
      )
    })

    afterAll(async () => {
      try {
        await connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
            collection: "big_coll",
          }),
        )
      } catch {}
    })

    test("find — auto-limits to effectiveLimit (default 1000)", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "big_coll",
        }),
      )
      // All 50 docs returned (< 1000 default limit)
      expect(result.row_count).toBe(50)
      expect(result.truncated).toBe(false)
    })

    test("find — query-level limit takes precedence", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "big_coll",
          sort: { idx: 1 },
          limit: 10,
        }),
      )
      expect(result.row_count).toBe(10)
      expect(result.truncated).toBe(true)
    })

    test("find — driver limit parameter works", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "big_coll",
          sort: { idx: 1 },
        }),
        5, // driver-level limit
      )
      expect(result.row_count).toBe(5)
      expect(result.truncated).toBe(true)
    })

    test("aggregate — auto-appends $limit when not present", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "big_coll",
          pipeline: [{ $sort: { idx: 1 } }],
        }),
        10,
      )
      expect(result.row_count).toBe(10)
      expect(result.truncated).toBe(true)
    })

    test("aggregate — preserves explicit $limit in pipeline", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "big_coll",
          pipeline: [{ $sort: { idx: 1 } }, { $limit: 3 }],
        }),
      )
      expect(result.row_count).toBe(3)
      expect(result.truncated).toBe(false) // Pipeline has its own limit
    })

    test("distinct — truncates long value lists", async () => {
      const result = await connector.execute(
        cmd({
          command: "distinct",
          database: "testdb",
          collection: "big_coll",
          field: "idx",
        }),
        10,
      )
      expect(result.row_count).toBe(10)
      expect(result.truncated).toBe(true)
    })
  })

  // =========================================================================
  // Empty results
  // =========================================================================

  describe("Empty Results", () => {
    test("find — no matching documents returns empty", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "nonexistent_user_xyz" },
        }),
      )
      expect(result.columns).toEqual([])
      expect(result.rows).toEqual([])
      expect(result.row_count).toBe(0)
      expect(result.truncated).toBe(false)
    })

    test("aggregate — no results from pipeline", async () => {
      const result = await connector.execute(
        cmd({
          command: "aggregate",
          database: "testdb",
          collection: "users",
          pipeline: [{ $match: { age: { $gt: 999 } } }],
        }),
      )
      expect(result.row_count).toBe(0)
    })

    test("deleteMany — filter matches nothing", async () => {
      const result = await connector.execute(
        cmd({
          command: "deleteMany",
          database: "testdb",
          collection: "users",
          filter: { name: "nobody_exists" },
        }),
      )
      expect(result.rows[0][0]).toBe(0)
    })

    test("updateOne — filter matches nothing", async () => {
      const result = await connector.execute(
        cmd({
          command: "updateOne",
          database: "testdb",
          collection: "users",
          filter: { name: "nobody_exists" },
          update: { $set: { age: 99 } },
        }),
      )
      expect(result.rows[0]).toEqual([0, 0])
    })
  })

  // =========================================================================
  // Cross-Database Operations
  // =========================================================================

  describe("Cross-Database Operations", () => {
    test("query different database than default", async () => {
      // Insert into a different database
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "otherdb",
          name: "items",
        }),
      )
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "otherdb",
          collection: "items",
          document: { label: "cross-db-test" },
        }),
      )

      // Query the other database
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "otherdb",
          collection: "items",
          filter: { label: "cross-db-test" },
          projection: { label: 1, _id: 0 },
        }),
      )
      expect(result.rows[0][0]).toBe("cross-db-test")

      // Clean up
      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "otherdb",
          collection: "items",
        }),
      )
    })

    test("listSchemas — shows newly created database", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "brand_new_db",
          name: "first_coll",
        }),
      )
      const schemas = await connector.listSchemas()
      expect(schemas).toContain("brand_new_db")

      // Cleanup
      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "brand_new_db",
          collection: "first_coll",
        }),
      )
    })
  })

  // =========================================================================
  // Error Handling
  // =========================================================================

  describe("Error Handling", () => {
    test("rejects invalid JSON query", async () => {
      await expect(connector.execute("not valid json {{{")).rejects.toThrow(/Invalid MQL query/)
    })

    test("rejects query without command field", async () => {
      await expect(connector.execute(JSON.stringify({ database: "testdb", collection: "users" }))).rejects.toThrow(
        /must include a 'command' field/,
      )
    })

    test("rejects unsupported command", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "fakeCommand" as any,
            database: "testdb",
            collection: "users",
          }),
        ),
      ).rejects.toThrow(/Unsupported MQL command/)
    })

    test("rejects find without collection", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "find",
            database: "testdb",
          }),
        ),
      ).rejects.toThrow(/requires a 'collection' field/)
    })

    test("rejects aggregate without pipeline", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "aggregate",
            database: "testdb",
            collection: "users",
          }),
        ),
      ).rejects.toThrow(/requires a 'pipeline' array/)
    })

    test("rejects insertOne without document", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "insertOne",
            database: "testdb",
            collection: "users",
          }),
        ),
      ).rejects.toThrow(/requires a 'document' object/)
    })

    test("rejects insertMany without documents", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "insertMany",
            database: "testdb",
            collection: "users",
          }),
        ),
      ).rejects.toThrow(/requires a 'documents' array/)
    })

    test("rejects updateOne without update", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "updateOne",
            database: "testdb",
            collection: "users",
            filter: { name: "alice" },
          }),
        ),
      ).rejects.toThrow(/requires an 'update' object/)
    })

    test("rejects updateMany without update", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "updateMany",
            database: "testdb",
            collection: "users",
          }),
        ),
      ).rejects.toThrow(/requires an 'update' object/)
    })

    test("rejects distinct without field", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "distinct",
            database: "testdb",
            collection: "users",
          }),
        ),
      ).rejects.toThrow(/requires a 'field' string/)
    })

    test("rejects createIndex without keys", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "createIndex",
            database: "testdb",
            collection: "users",
          }),
        ),
      ).rejects.toThrow(/requires a 'keys' object/)
    })

    test("rejects createCollection without name", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "createCollection",
            database: "testdb",
          }),
        ),
      ).rejects.toThrow(/requires 'name' or 'collection'/)
    })

    test("rejects dropCollection without collection", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "dropCollection",
            database: "testdb",
          }),
        ),
      ).rejects.toThrow(/requires 'collection'/)
    })
  })

  // =========================================================================
  // Adversarial Tests
  // =========================================================================

  describe("Adversarial Tests", () => {
    test("handles empty document insertion", async () => {
      const result = await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: {},
        }),
      )
      expect(result.rows[0][0]).toBeDefined() // Still gets an _id

      // Clean up empty doc
      await connector.execute(
        cmd({
          command: "deleteMany",
          database: "testdb",
          collection: "users",
          filter: { name: { $exists: false } },
        }),
      )
    })

    test("handles deeply nested documents (10 levels)", async () => {
      let nested: any = { value: "deep" }
      for (let i = 0; i < 10; i++) {
        nested = { [`level_${i}`]: nested }
      }

      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: { name: "nested_user", deep: nested },
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "nested_user" },
          projection: { deep: 1, _id: 0 },
        }),
      )
      expect(result.row_count).toBe(1)
      // Deep object should be JSON-serialized
      const deepVal = result.rows[0][0]
      expect(typeof deepVal).toBe("string") // JSON stringified
      expect(deepVal).toContain("deep")

      // Clean up
      await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "users",
          filter: { name: "nested_user" },
        }),
      )
    })

    test("handles documents with special characters in field names", async () => {
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: {
            name: "special_fields",
            "field with spaces": "ok",
            "field.with.dots": "ok", // MongoDB allows this on insert
            "field-with-dashes": "ok",
            UPPERCASE_FIELD: "ok",
            unicode_フィールド: "ok",
          },
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "special_fields" },
        }),
      )
      expect(result.row_count).toBe(1)
      expect(result.columns).toContain("field with spaces")
      expect(result.columns).toContain("field-with-dashes")
      expect(result.columns).toContain("UPPERCASE_FIELD")
      expect(result.columns).toContain("unicode_フィールド")

      await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "users",
          filter: { name: "special_fields" },
        }),
      )
    })

    test("handles documents with special characters in values", async () => {
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: {
            name: "special_values",
            quotes: 'She said "hello"',
            backslashes: "path\\to\\file",
            newlines: "line1\nline2\nline3",
            tabs: "col1\tcol2",
            unicode: "emoji 🚀 and CJK 中文",
            null_char: "before\x00after", // null byte
            html: "<script>alert('xss')</script>",
            sql_injection: "'; DROP TABLE users; --",
          },
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "special_values" },
          projection: { quotes: 1, unicode: 1, html: 1, sql_injection: 1, _id: 0 },
        }),
      )
      expect(result.row_count).toBe(1)
      expect(result.rows[0][result.columns.indexOf("quotes")]).toBe('She said "hello"')
      expect(result.rows[0][result.columns.indexOf("unicode")]).toBe("emoji 🚀 and CJK 中文")
      expect(result.rows[0][result.columns.indexOf("html")]).toBe("<script>alert('xss')</script>")
      expect(result.rows[0][result.columns.indexOf("sql_injection")]).toBe("'; DROP TABLE users; --")

      await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "users",
          filter: { name: "special_values" },
        }),
      )
    })

    test("handles very large document (close to 16MB BSON limit)", async () => {
      // Create a ~1MB string (well under 16MB limit but still large)
      const largeString = "x".repeat(1_000_000)
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: { name: "large_doc", payload: largeString },
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "large_doc" },
          projection: { name: 1, _id: 0 },
        }),
      )
      expect(result.rows[0][0]).toBe("large_doc")

      await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "users",
          filter: { name: "large_doc" },
        }),
      )
    })

    test("handles insertMany with empty array", async () => {
      // MongoDB driver throws on empty insertMany — driver should propagate the error
      await expect(
        connector.execute(
          cmd({
            command: "insertMany",
            database: "testdb",
            collection: "users",
            documents: [],
          }),
        ),
      ).rejects.toThrow()
    })

    test("handles duplicate key error (unique index violation)", async () => {
      // email_1 index is unique — inserting duplicate email should fail
      const existingEmails = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { email: "alice@example.com" },
          projection: { email: 1, _id: 0 },
        }),
      )
      if (existingEmails.row_count > 0) {
        await expect(
          connector.execute(
            cmd({
              command: "insertOne",
              database: "testdb",
              collection: "users",
              document: { name: "alice_dup", email: "alice@example.com" },
            }),
          ),
        ).rejects.toThrow()
      }
    })

    test("handles collection names with special characters", async () => {
      const weirdName = "coll-with-dashes_and_underscores"
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: weirdName,
        }),
      )
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: weirdName,
          document: { test: true },
        }),
      )
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: weirdName,
        }),
      )
      expect(result.row_count).toBe(1)
      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: weirdName,
        }),
      )
    })

    test("handles heterogeneous documents in same collection", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "hetero",
        }),
      )
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "hetero",
          documents: [
            { type: "person", name: "Alice", age: 30 },
            { type: "company", name: "Acme", employees: 500, founded: 1990 },
            { type: "product", sku: "ABC-123", price: 29.99 },
          ],
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "hetero",
        }),
      )
      expect(result.row_count).toBe(3)
      // Columns should be union of all fields across all documents
      expect(result.columns).toContain("type")
      expect(result.columns).toContain("name")
      expect(result.columns).toContain("age")
      expect(result.columns).toContain("employees")
      expect(result.columns).toContain("sku")
      expect(result.columns).toContain("price")
      expect(result.columns).toContain("founded")

      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "hetero",
        }),
      )
    })

    test("handles null and undefined values in documents", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "nulls",
        }),
      )
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "nulls",
          documents: [
            { a: 1, b: null, c: "x" },
            { a: null, b: 2, c: null },
            { a: 3, c: "z" }, // b is missing entirely
          ],
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "nulls",
          sort: { a: 1 },
        }),
      )
      expect(result.row_count).toBe(3)

      // describeTable should detect nullable fields
      const columns = await connector.describeTable("testdb", "nulls")
      const bCol = columns.find((c) => c.name === "b")
      expect(bCol).toBeDefined()
      expect(bCol!.nullable).toBe(true)

      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "nulls",
        }),
      )
    })

    test("handles array values in documents", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "arrays",
        }),
      )
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "arrays",
          documents: [
            { name: "a", tags: ["x", "y"] },
            { name: "b", tags: ["y", "z"] },
            { name: "c", tags: [] },
          ],
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "arrays",
          projection: { name: 1, tags: 1, _id: 0 },
          sort: { name: 1 },
        }),
      )
      expect(result.row_count).toBe(3)
      // tags should be JSON-serialized as arrays
      expect(result.rows[0][result.columns.indexOf("tags")]).toBe('["x","y"]')
      expect(result.rows[2][result.columns.indexOf("tags")]).toBe("[]")

      // Querying into arrays with $elemMatch/$in
      const filtered = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "arrays",
          filter: { tags: "y" },
          projection: { name: 1, _id: 0 },
          sort: { name: 1 },
        }),
      )
      expect(filtered.rows.map((r) => r[0])).toEqual(["a", "b"])

      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "arrays",
        }),
      )
    })

    test("handles concurrent operations", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "concurrent",
        }),
      )

      // Run 10 inserts concurrently
      const inserts = Array.from({ length: 10 }, (_, i) =>
        connector.execute(
          cmd({
            command: "insertOne",
            database: "testdb",
            collection: "concurrent",
            document: { idx: i },
          }),
        ),
      )
      const results = await Promise.all(inserts)
      expect(results).toHaveLength(10)
      results.forEach((r) => {
        expect(r.rows[0][0]).toBeDefined()
      })

      // Verify all inserted
      const count = await connector.execute(
        cmd({
          command: "countDocuments",
          database: "testdb",
          collection: "concurrent",
        }),
      )
      expect(count.rows[0][0]).toBe(10)

      // Run concurrent reads
      const reads = Array.from({ length: 5 }, () =>
        connector.execute(
          cmd({
            command: "find",
            database: "testdb",
            collection: "concurrent",
          }),
        ),
      )
      const readResults = await Promise.all(reads)
      readResults.forEach((r) => {
        expect(r.row_count).toBe(10)
      })

      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "concurrent",
        }),
      )
    })

    test("handles very long collection and database names", async () => {
      // MongoDB allows collection names up to ~120 bytes when combined with db name
      const longName = "a".repeat(60)
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: longName,
        }),
      )
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: longName,
          document: { ok: true },
        }),
      )
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: longName,
        }),
      )
      expect(result.row_count).toBe(1)
      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: longName,
        }),
      )
    })

    test("handles update with $inc, $unset, $push operators", async () => {
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: { name: "ops_test", count: 0, tags: ["initial"], temp: "will_remove" },
        }),
      )

      // $inc
      await connector.execute(
        cmd({
          command: "updateOne",
          database: "testdb",
          collection: "users",
          filter: { name: "ops_test" },
          update: { $inc: { count: 5 } },
        }),
      )

      // $push
      await connector.execute(
        cmd({
          command: "updateOne",
          database: "testdb",
          collection: "users",
          filter: { name: "ops_test" },
          update: { $push: { tags: "added" } },
        }),
      )

      // $unset
      await connector.execute(
        cmd({
          command: "updateOne",
          database: "testdb",
          collection: "users",
          filter: { name: "ops_test" },
          update: { $unset: { temp: "" } },
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "ops_test" },
          projection: { count: 1, tags: 1, temp: 1, _id: 0 },
        }),
      )
      expect(result.rows[0][result.columns.indexOf("count")]).toBe(5)

      // Clean up
      await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "users",
          filter: { name: "ops_test" },
        }),
      )
    })

    test("handles aggregate with invalid pipeline stage", async () => {
      await expect(
        connector.execute(
          cmd({
            command: "aggregate",
            database: "testdb",
            collection: "users",
            pipeline: [{ $invalidStage: {} }],
          }),
        ),
      ).rejects.toThrow()
    })

    test("handles queries on non-existent collection (find returns empty)", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "totally_nonexistent_collection_xyz",
        }),
      )
      expect(result.row_count).toBe(0)
    })

    test("handles numeric edge cases in documents", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "numbers",
        }),
      )
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "numbers",
          documents: [
            { label: "zero", val: 0 },
            { label: "negative", val: -42 },
            { label: "float", val: 3.14159 },
            { label: "large", val: 9007199254740991 }, // Number.MAX_SAFE_INTEGER
            { label: "tiny", val: 0.000001 },
          ],
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "numbers",
          sort: { val: 1 },
          projection: { label: 1, val: 1, _id: 0 },
        }),
      )
      expect(result.row_count).toBe(5)
      const labels = result.rows.map((r) => r[result.columns.indexOf("label")])
      expect(labels[0]).toBe("negative") // -42
      expect(labels[1]).toBe("zero") // 0
      expect(labels[2]).toBe("tiny") // 0.000001

      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "numbers",
        }),
      )
    })

    test("handles boolean edge cases", async () => {
      await connector.execute(
        cmd({
          command: "createCollection",
          database: "testdb",
          name: "booleans",
        }),
      )
      await connector.execute(
        cmd({
          command: "insertMany",
          database: "testdb",
          collection: "booleans",
          documents: [
            { flag: true },
            { flag: false },
            { flag: null },
            { flag: 0 }, // falsy but not boolean
            { flag: 1 }, // truthy but not boolean
            { flag: "" }, // empty string
          ],
        }),
      )

      // Filter for exactly boolean true
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "booleans",
          filter: { flag: true },
        }),
      )
      expect(result.row_count).toBe(1) // Only the actual boolean true

      // Filter for exactly boolean false
      const falseResult = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "booleans",
          filter: { flag: false },
        }),
      )
      expect(falseResult.row_count).toBe(1) // Only the actual boolean false

      await connector.execute(
        cmd({
          command: "dropCollection",
          database: "testdb",
          collection: "booleans",
        }),
      )
    })
  })

  // =========================================================================
  // BSON Type Handling
  // =========================================================================

  describe("BSON Type Handling", () => {
    test("ObjectId is serialized to string in results", async () => {
      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          projection: { _id: 1 },
          limit: 1,
        }),
      )
      expect(result.row_count).toBe(1)
      const id = result.rows[0][0]
      expect(typeof id).toBe("string")
      expect(id).toMatch(/^[0-9a-f]{24}$/) // 24-char hex string
    })

    test("Date values are serialized to ISO strings", async () => {
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: { name: "date_test", created_at: { $date: "2024-01-15T10:30:00Z" } },
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "date_test" },
          projection: { created_at: 1, _id: 0 },
        }),
      )
      // Date should be an ISO string
      const dateVal = result.rows[0][0]
      expect(typeof dateVal).toBe("string")

      await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "users",
          filter: { name: "date_test" },
        }),
      )
    })

    test("nested objects are JSON-serialized", async () => {
      await connector.execute(
        cmd({
          command: "insertOne",
          database: "testdb",
          collection: "users",
          document: {
            name: "nested_test",
            address: { street: "123 Main St", city: "Springfield", zip: "12345" },
          },
        }),
      )

      const result = await connector.execute(
        cmd({
          command: "find",
          database: "testdb",
          collection: "users",
          filter: { name: "nested_test" },
          projection: { address: 1, _id: 0 },
        }),
      )
      const addr = result.rows[0][0]
      expect(typeof addr).toBe("string")
      const parsed = JSON.parse(addr)
      expect(parsed.street).toBe("123 Main St")
      expect(parsed.city).toBe("Springfield")

      await connector.execute(
        cmd({
          command: "deleteOne",
          database: "testdb",
          collection: "users",
          filter: { name: "nested_test" },
        }),
      )
    })
  })
})
