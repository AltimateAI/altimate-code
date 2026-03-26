/**
 * MongoDB driver using the `mongodb` package.
 *
 * Maps MongoDB concepts to the Connector interface:
 *   - listSchemas()        → lists databases
 *   - listTables(schema)   → lists collections in a database
 *   - describeTable(s, t)  → samples documents to infer field types
 *   - execute(query)       → parses and executes MQL commands
 *
 * Query format (JSON string):
 *   { "database": "mydb", "collection": "users", "command": "find", "filter": { "age": { "$gt": 25 } } }
 *   { "database": "mydb", "collection": "orders", "command": "aggregate", "pipeline": [...] }
 *   { "database": "mydb", "collection": "users", "command": "insertMany", "documents": [...] }
 *   { "database": "mydb", "collection": "users", "command": "countDocuments", "filter": {} }
 */

import type { ConnectionConfig, Connector, ConnectorResult, SchemaColumn } from "./types"

/** Supported MQL commands. */
type MqlCommand =
  | "find"
  | "aggregate"
  | "countDocuments"
  | "distinct"
  | "insertOne"
  | "insertMany"
  | "updateOne"
  | "updateMany"
  | "deleteOne"
  | "deleteMany"
  | "createCollection"
  | "dropCollection"
  | "createIndex"
  | "listIndexes"
  | "ping"

interface MqlQuery {
  database?: string
  collection?: string
  command: MqlCommand
  // find
  filter?: Record<string, unknown>
  projection?: Record<string, unknown>
  sort?: Record<string, unknown>
  limit?: number
  skip?: number
  // aggregate
  pipeline?: Record<string, unknown>[]
  // insert
  document?: Record<string, unknown>
  documents?: Record<string, unknown>[]
  // update
  update?: Record<string, unknown>
  // distinct
  field?: string
  // createIndex
  keys?: Record<string, unknown>
  options?: Record<string, unknown>
  // createCollection
  name?: string
}

/**
 * Infer a human-readable type name from a JavaScript value.
 */
function inferType(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return "array"
  if (value instanceof Date) return "date"
  // mongodb BSON types
  const ctor = (value as any)?._bsontype
  if (ctor) {
    switch (ctor) {
      case "ObjectId":
      case "ObjectID":
        return "objectId"
      case "Decimal128":
        return "decimal128"
      case "Long":
        return "int64"
      case "Int32":
        return "int32"
      case "Double":
        return "double"
      case "Binary":
        return "binary"
      case "Timestamp":
        return "timestamp"
      case "MinKey":
        return "minKey"
      case "MaxKey":
        return "maxKey"
      case "BSONRegExp":
        return "regex"
      case "Code":
        return "javascript"
      case "BSONSymbol":
        return "symbol"
      case "UUID":
        return "uuid"
      default:
        return ctor.toLowerCase()
    }
  }
  const t = typeof value
  if (t === "number") return Number.isInteger(value as number) ? "int32" : "double"
  if (t === "boolean") return "bool"
  if (t === "string") return "string"
  if (t === "object") return "object"
  return "unknown"
}

/**
 * Extract field names and their observed types from a set of documents.
 * Only inspects top-level fields — nested objects are reported as type "object".
 */
function extractFields(docs: Record<string, unknown>[]): Map<string, Set<string>> {
  const fieldTypes = new Map<string, Set<string>>()

  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const types = fieldTypes.get(key) ?? new Set()
      types.add(inferType(value))
      fieldTypes.set(key, types)
    }
  }

  return fieldTypes
}

export async function connect(config: ConnectionConfig): Promise<Connector> {
  let mongoModule: any
  try {
    mongoModule = await import("mongodb")
    mongoModule = mongoModule.default || mongoModule
  } catch {
    throw new Error("MongoDB driver not installed. Run: npm install mongodb")
  }

  const MongoClient = mongoModule.MongoClient

  let client: any
  const explicitDb = config.database as string | undefined

  /** Resolve which database to use: query-specified, config-specified, or URI default. */
  function resolveDb(queryDb?: string): any {
    if (queryDb) return client.db(queryDb)
    if (explicitDb) return client.db(explicitDb)
    // Fall back to the database embedded in the connection string URI, or MongoDB's default
    return client.db()
  }

  /**
   * Serialize a value for tabular display.
   * BSON types are converted to strings; nested objects are JSON-serialized.
   */
  function serializeValue(val: unknown): unknown {
    if (val === null || val === undefined) return val
    if (typeof val !== "object") return val

    // BSON ObjectId
    if ((val as any)._bsontype === "ObjectId" || (val as any)._bsontype === "ObjectID") {
      return (val as any).toString()
    }
    // BSON Decimal128, Long, Int32, Double
    if (
      (val as any)._bsontype === "Decimal128" ||
      (val as any)._bsontype === "Long" ||
      (val as any)._bsontype === "Int32" ||
      (val as any)._bsontype === "Double"
    ) {
      return (val as any).toString()
    }
    // BSON UUID
    if ((val as any)._bsontype === "UUID") {
      return (val as any).toString()
    }
    // BSON Binary
    if ((val as any)._bsontype === "Binary") {
      return `Binary(${(val as any).length()})`
    }
    // BSON Timestamp
    if ((val as any)._bsontype === "Timestamp") {
      return (val as any).toString()
    }
    // Date
    if (val instanceof Date) {
      return val.toISOString()
    }
    // Arrays and plain objects — JSON-serialize for tabular display
    if (Array.isArray(val) || typeof (val as any).toJSON !== "function") {
      return JSON.stringify(val)
    }
    return JSON.stringify(val)
  }

  return {
    async connect() {
      // Support connection_string or individual fields
      // SECURITY: URI may contain credentials — never log it
      let uri: string
      if (config.connection_string) {
        uri = config.connection_string as string
      } else {
        const host = (config.host as string) ?? "127.0.0.1"
        const port = (config.port as number) ?? 27017
        const user = config.user as string | undefined
        const password = config.password as string | undefined
        // Include database in URI for correct auth-source resolution
        const dbPath = explicitDb ? `/${encodeURIComponent(explicitDb)}` : ""

        if (user && password) {
          uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}${dbPath}`
        } else {
          uri = `mongodb://${host}:${port}${dbPath}`
        }
      }

      const connectOptions: Record<string, unknown> = {
        connectTimeoutMS: (config.connect_timeout as number) ?? 10000,
        serverSelectionTimeoutMS: (config.server_selection_timeout as number) ?? 10000,
      }

      if (config.auth_source) {
        connectOptions.authSource = config.auth_source
      }

      if (config.replica_set) {
        connectOptions.replicaSet = config.replica_set
      }

      if (config.tls !== undefined) {
        connectOptions.tls = config.tls
      }

      if (config.direct_connection !== undefined) {
        connectOptions.directConnection = config.direct_connection
      }

      client = new MongoClient(uri, connectOptions)
      await client.connect()
    },

    async execute(query: string, limit?: number, _binds?: any[]): Promise<ConnectorResult> {
      let parsed: MqlQuery
      try {
        parsed = JSON.parse(query) as MqlQuery
      } catch (e) {
        throw new Error(`Invalid MQL query — must be valid JSON. Error: ${(e as Error).message}`)
      }

      if (!parsed.command) {
        throw new Error("MQL query must include a 'command' field")
      }

      const db = resolveDb(parsed.database)
      const effectiveLimit = limit ?? 1000
      const cmd = parsed.command

      // Commands that don't need a collection
      if (cmd === "ping") {
        const result = await db.command({ ping: 1 })
        return { columns: ["ok"], rows: [[result.ok]], row_count: 1, truncated: false }
      }

      if (cmd === "createCollection") {
        const name = parsed.name ?? parsed.collection
        if (!name) {
          throw new Error("createCollection requires 'name' or 'collection'")
        }
        await db.createCollection(name, parsed.options ?? {})
        return { columns: ["result"], rows: [["ok"]], row_count: 1, truncated: false }
      }

      if (cmd === "dropCollection") {
        if (!parsed.collection) {
          throw new Error("dropCollection requires 'collection'")
        }
        const dropped = await db
          .collection(parsed.collection)
          .drop()
          .catch((e: any) => {
            if (e.codeName === "NamespaceNotFound" || e.code === 26) return false
            throw e
          })
        return {
          columns: ["dropped"],
          rows: [[dropped]],
          row_count: 1,
          truncated: false,
        }
      }

      if (!parsed.collection) {
        throw new Error(`Command '${cmd}' requires a 'collection' field`)
      }

      const coll = db.collection(parsed.collection)

      switch (cmd) {
        case "find": {
          let cursor = coll.find(parsed.filter ?? {})
          if (parsed.projection) cursor = cursor.project(parsed.projection)
          if (parsed.sort) cursor = cursor.sort(parsed.sort)
          if (parsed.skip) cursor = cursor.skip(parsed.skip)
          // Cap user-specified limit against effectiveLimit to prevent OOM
          const queryLimit = parsed.limit ? Math.min(parsed.limit, effectiveLimit) : effectiveLimit
          cursor = cursor.limit(queryLimit + 1)
          const docs = await cursor.toArray()

          const truncated = docs.length > queryLimit
          const limited = truncated ? docs.slice(0, queryLimit) : docs

          if (limited.length === 0) {
            return { columns: [], rows: [], row_count: 0, truncated: false }
          }

          // Build column list from all documents (documents may have different fields)
          const colSet = new Set<string>()
          for (const doc of limited) {
            for (const key of Object.keys(doc)) {
              colSet.add(key)
            }
          }
          const columns = Array.from(colSet)

          const rows = limited.map((doc: any) => columns.map((col) => serializeValue(doc[col])))

          return { columns, rows, row_count: limited.length, truncated }
        }

        case "aggregate": {
          if (!parsed.pipeline || !Array.isArray(parsed.pipeline)) {
            throw new Error("aggregate requires a 'pipeline' array")
          }
          // Cap or append $limit to prevent OOM. Skip for $out/$merge write pipelines.
          const pipeline = [...parsed.pipeline]
          const hasWrite = pipeline.some((stage) => "$out" in stage || "$merge" in stage)
          if (!hasWrite) {
            const limitIdx = pipeline.findIndex((stage) => "$limit" in stage)
            if (limitIdx >= 0) {
              // Cap user-specified $limit against effectiveLimit
              const userLimit = (pipeline[limitIdx] as any).$limit
              if (typeof userLimit === "number" && userLimit > effectiveLimit) {
                pipeline[limitIdx] = { $limit: effectiveLimit + 1 }
              }
            } else {
              pipeline.push({ $limit: effectiveLimit + 1 })
            }
          }

          const docs = await coll.aggregate(pipeline).toArray()

          const truncated = docs.length > effectiveLimit
          const limited = truncated ? docs.slice(0, effectiveLimit) : docs

          if (limited.length === 0) {
            return { columns: [], rows: [], row_count: 0, truncated: false }
          }

          const colSet = new Set<string>()
          for (const doc of limited) {
            for (const key of Object.keys(doc)) {
              colSet.add(key)
            }
          }
          const columns = Array.from(colSet)

          const rows = limited.map((doc: any) => columns.map((col) => serializeValue(doc[col])))

          return { columns, rows, row_count: limited.length, truncated }
        }

        case "countDocuments": {
          const count = await coll.countDocuments(parsed.filter ?? {})
          return {
            columns: ["count"],
            rows: [[count]],
            row_count: 1,
            truncated: false,
          }
        }

        case "distinct": {
          if (!parsed.field) {
            throw new Error("distinct requires a 'field' string")
          }
          const values = await coll.distinct(parsed.field, parsed.filter ?? {})
          const truncated = values.length > effectiveLimit
          const limited = truncated ? values.slice(0, effectiveLimit) : values
          return {
            columns: [parsed.field],
            rows: limited.map((v: unknown) => [serializeValue(v)]),
            row_count: limited.length,
            truncated,
          }
        }

        case "insertOne": {
          if (!parsed.document) {
            throw new Error("insertOne requires a 'document' object")
          }
          const result = await coll.insertOne(parsed.document)
          return {
            columns: ["insertedId"],
            rows: [[result.insertedId.toString()]],
            row_count: 1,
            truncated: false,
          }
        }

        case "insertMany": {
          if (!parsed.documents || !Array.isArray(parsed.documents)) {
            throw new Error("insertMany requires a 'documents' array")
          }
          const result = await coll.insertMany(parsed.documents)
          return {
            columns: ["insertedCount"],
            rows: [[result.insertedCount]],
            row_count: 1,
            truncated: false,
          }
        }

        case "updateOne": {
          if (!parsed.update) {
            throw new Error("updateOne requires an 'update' object")
          }
          const result = await coll.updateOne(parsed.filter ?? {}, parsed.update)
          return {
            columns: ["matchedCount", "modifiedCount"],
            rows: [[result.matchedCount, result.modifiedCount]],
            row_count: 1,
            truncated: false,
          }
        }

        case "updateMany": {
          if (!parsed.update) {
            throw new Error("updateMany requires an 'update' object")
          }
          const result = await coll.updateMany(parsed.filter ?? {}, parsed.update)
          return {
            columns: ["matchedCount", "modifiedCount"],
            rows: [[result.matchedCount, result.modifiedCount]],
            row_count: 1,
            truncated: false,
          }
        }

        case "deleteOne": {
          const result = await coll.deleteOne(parsed.filter ?? {})
          return {
            columns: ["deletedCount"],
            rows: [[result.deletedCount]],
            row_count: 1,
            truncated: false,
          }
        }

        case "deleteMany": {
          const result = await coll.deleteMany(parsed.filter ?? {})
          return {
            columns: ["deletedCount"],
            rows: [[result.deletedCount]],
            row_count: 1,
            truncated: false,
          }
        }

        case "createIndex": {
          if (!parsed.keys) {
            throw new Error("createIndex requires a 'keys' object")
          }
          const indexName = await coll.createIndex(parsed.keys, parsed.options ?? {})
          return {
            columns: ["indexName"],
            rows: [[indexName]],
            row_count: 1,
            truncated: false,
          }
        }

        case "listIndexes": {
          const indexes = await coll.listIndexes().toArray()
          if (indexes.length === 0) {
            return { columns: [], rows: [], row_count: 0, truncated: false }
          }
          const columns = ["name", "key", "unique"]
          const rows = indexes.map((idx: any) => [idx.name, JSON.stringify(idx.key), idx.unique ?? false])
          return { columns, rows, row_count: rows.length, truncated: false }
        }

        default:
          throw new Error(`Unsupported MQL command: ${cmd}`)
      }
    },

    async listSchemas(): Promise<string[]> {
      try {
        const admin = client.db().admin()
        const result = await admin.listDatabases({ nameOnly: true, authorizedDatabases: true })
        return result.databases
          .map((db: any) => db.name as string)
          .filter((name: string) => name !== "local" && name !== "config")
          .sort()
      } catch {
        // Fallback for users without listDatabases privilege: return the configured/default database
        const db = resolveDb()
        return [db.databaseName]
      }
    },

    async listTables(schema: string): Promise<Array<{ name: string; type: string }>> {
      const db = client.db(schema)
      const collections = await db.listCollections().toArray()
      return collections
        .map((c: any) => ({
          name: c.name as string,
          type: c.type === "view" ? "view" : "collection",
        }))
        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
    },

    async describeTable(schema: string, table: string): Promise<SchemaColumn[]> {
      const db = client.db(schema)
      const coll = db.collection(table)

      // Sample up to 100 documents to infer schema
      const docs = await coll.find({}).limit(100).toArray()

      if (docs.length === 0) {
        return []
      }

      const fieldTypes = extractFields(docs)
      // Track which fields are missing from some documents (nullable by absence)
      const fieldPresence = new Map<string, number>()
      for (const doc of docs) {
        for (const key of Object.keys(doc)) {
          fieldPresence.set(key, (fieldPresence.get(key) ?? 0) + 1)
        }
      }

      const columns: SchemaColumn[] = []
      for (const [name, types] of fieldTypes) {
        const typeArr = Array.from(types)
        const hasNull = typeArr.includes("null")
        const nonNullTypes = typeArr.filter((t) => t !== "null")
        const dataType =
          nonNullTypes.length === 0 ? "null" : nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes.join(" | ")

        // Field is nullable if it has null values OR is missing from some documents
        const presentIn = fieldPresence.get(name) ?? 0
        const missingFromSome = presentIn < docs.length

        columns.push({
          name,
          data_type: dataType,
          nullable: hasNull || missingFromSome,
        })
      }

      // Sort: _id first, then alphabetical
      columns.sort((a, b) => {
        if (a.name === "_id") return -1
        if (b.name === "_id") return 1
        return a.name.localeCompare(b.name)
      })

      return columns
    },

    async close() {
      if (client) {
        await client.close()
        client = null
      }
    },
  }
}
