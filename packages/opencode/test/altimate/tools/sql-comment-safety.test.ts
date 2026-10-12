import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { classifyAndCheck, isSingleQuery, isScratchSafeWrite } from "../../../src/altimate/tools/sql-classify"
import { readSql } from "../../../src/altimate/tools/sql-check"
import { SqlExecuteTool } from "../../../src/altimate/tools/sql-execute"
import * as Registry from "../../../src/altimate/native/connections/registry"
import * as Dispatcher from "../../../src/altimate/native/dispatcher"
import { MessageID, SessionID } from "../../../src/session/schema"
import { initTool } from "../tool-fixture"

afterEach(() => Registry.reset())

describe("SQL dialect comment safety", () => {
  for (const sql of [
    "SELECT 1 /*! INTO OUTFILE '/tmp/x' */",
    "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */",
    "SELECT 1 /*M! INTO OUTFILE '/tmp/x' */",
    "SELECT 1 /*! + side_effecting_function() */",
  ]) {
    test(`executable comments are hard denied: ${sql}`, () => {
      expect(classifyAndCheck(sql)).toEqual({ queryType: "write", blocked: true })
      expect(isSingleQuery(sql)).toBe(false)
      expect(() => readSql(sql, "mysql")).toThrow(/single read-only SELECT/)
    })
  }
  for (const dialect of ["mysql", "mariadb", undefined]) {
    test(`executable comments cannot bypass hard denies for ${dialect ?? "omitted"} dialect`, () => {
      for (const sql of [
        "/*! DROP DATABASE x */",
        "/*!50000 DROP SCHEMA x */",
        "/*M! TRUNCATE TABLE x */",
        "/*m!100100 DROP DATABASE x */",
        "DROP /*! DATABASE */ x",
        "SELECT 1; /*! TRUNCATE TABLE x */",
        // Parser errors must preserve the same hard-deny boundary.
        "SELECT (; /*! DROP DATABASE x */",
        "/*! DROP DATABASE x",
        // Reject executable comments outright: generic parsers cannot prove their safety.
        "SELECT 1 /*! + 1 */",
      ]) {
        expect(classifyAndCheck(sql, dialect)).toEqual({ queryType: "write", blocked: true })
      }
    })
  }
  test("executable comments cannot hide a non-scratch operation", () => {
    expect(isScratchSafeWrite("DELETE FROM t /*!; ATTACH 'external.db' AS external */")).toBe(false)
  })
  for (const sql of ["SELECT 1--2 INTO OUTFILE '/tmp/x'", "SELECT 1--2 INTO DUMPFILE '/tmp/x'"]) {
    test(`MySQL arithmetic is not a line comment: ${sql}`, () => {
      expect(classifyAndCheck(sql).queryType).toBe("write")
      expect(() => readSql(sql, "mysql")).toThrow(/single read-only SELECT/)
    })
  }
  test("MySQL arithmetic cannot hide hard-denied trailing statements from the generic parser", () => {
    for (const statement of ["DROP DATABASE x", "DROP SCHEMA x", "TRUNCATE TABLE x"]) {
      const sql = `SELECT 1--2; ${statement}`
      expect(classifyAndCheck(sql, "mysql")).toEqual({ queryType: "write", blocked: true })
      expect(classifyAndCheck(sql, "mariadb")).toEqual({ queryType: "write", blocked: true })
      expect(classifyAndCheck(sql, "postgres")).toEqual({ queryType: "read", blocked: false })
    }
  })
  test("PostgreSQL line comments without whitespace remain valid reads", () => {
    const sql = "SELECT 1--2 INTO OUTFILE '/tmp/x'"
    expect(classifyAndCheck(sql, "postgres").queryType).toBe("read")
    expect(readSql(sql, "postgres")).toBe(sql)
    expect(classifyAndCheck(sql, "mysql").queryType).toBe("write")
    expect(classifyAndCheck(sql, "mariadb").queryType).toBe("write")
  })
  test("ordinary comments and comment-like literals remain reads", () => {
    for (const sql of [
      "SELECT 1 -- comment",
      "SELECT 1--\tcomment",
      "SELECT 1 /* comment */",
      "SELECT 1 /* DROP DATABASE x */",
      "SELECT '/*! INTO OUTFILE */ --2' AS value",
      "SELECT '/*! DROP DATABASE x */' AS value",
      'SELECT 1 AS "/*M! TRUNCATE x */"',
    ]) {
      expect(classifyAndCheck(sql)).toEqual({ queryType: "read", blocked: false })
      expect(readSql(sql)).toBe(sql)
    }
  })
})

describe("scratch write target catalog", () => {
  for (const sql of [
    "DELETE FROM external.orders",
    "DELETE FROM external.main.orders",
    "UPDATE external.orders SET x = 1",
    "INSERT INTO external.orders VALUES (1)",
    "CREATE TABLE external.orders (id INT)",
    "CREATE VIEW external.orders AS SELECT 1",
    "DROP TABLE external.orders",
    "ALTER TABLE external.orders ADD COLUMN x INT",
    'DELETE FROM "external"."orders"',
    'DELETE FROM "external.main"."orders"',
    "DELETE FROM main.orders; DELETE FROM external.orders",
  ]) {
    test(`attached-catalog targets need write approval: ${sql}`, () => {
      expect(isScratchSafeWrite(sql)).toBe(false)
    })
  }
  test("unqualified and main targets retain the scratch write exemption", () => {
    for (const sql of [
      "DELETE FROM orders",
      "DELETE FROM main.orders",
      'DELETE FROM "main"."orders"',
      "UPDATE orders SET x = 1",
      "INSERT INTO main.orders VALUES (1)",
      "CREATE VIEW v AS SELECT * FROM main.orders",
    ]) {
      expect(isScratchSafeWrite(sql)).toBe(true)
    }
  })
})

for (const dialect of ["mysql", "mariadb"]) {
  test(`sql_execute denies ${dialect} comment-hidden writes before obtaining a connector`, async () => {
    Registry.setConfigs({ source: { type: dialect } })
    const get = spyOn(Registry, "get").mockRejectedValue(new Error("connector must not be reached"))
    try {
      const tool = await initTool(SqlExecuteTool)
      for (const query of ["SELECT 1--2 INTO OUTFILE '/tmp/x'"]) {
        const asked: string[] = []
        await expect(
          tool.execute(
            { warehouse: "source", query, limit: 10 },
            {
              sessionID: SessionID.make("ses_mysql_comment"),
              messageID: MessageID.make("msg_mysql_comment"),
              callID: "",
              agent: "analyst",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: async (request: { permission: string }) => {
                asked.push(request.permission)
                throw new Error("write permission denied")
              },
            },
          ),
        ).rejects.toThrow("write permission denied")
        expect(asked).toEqual(["sql_execute_write"])
      }
      expect(get).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
    }
  })
}

for (const dialect of ["mysql", "mariadb", undefined]) {
  test(`sql_execute hard denies executable comments before permission or dispatch for ${dialect ?? "omitted"} dialect`, async () => {
    if (dialect) Registry.setConfigs({ source: { type: dialect } })
    const get = spyOn(Registry, "get").mockRejectedValue(new Error("connector must not be reached"))
    const dispatch = spyOn(Dispatcher, "call").mockRejectedValue(new Error("dispatcher must not be reached"))
    const asked: string[] = []
    try {
      const tool = await initTool(SqlExecuteTool)
      for (const query of [
        "/*! DROP DATABASE x */",
        "SELECT 1; /*!50000 DROP SCHEMA x */",
        "/*M! TRUNCATE TABLE x */",
        "SELECT 1 /*! + 1 */",
      ]) {
        const error = await tool
          .execute(
            { warehouse: dialect ? "source" : undefined, query, limit: 10 },
            {
              sessionID: SessionID.make("ses_mysql_hard_deny"),
              messageID: MessageID.make("msg_mysql_hard_deny"),
              callID: "",
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: async (request: { permission: string }) => {
                asked.push(request.permission)
              },
            },
          )
          .catch((error: unknown) => error)
        expect(error).toBeInstanceOf(Error)
        expect(error).toMatchObject({ message: expect.stringMatching(/blocked for safety.*cannot be overridden/i) })
      }
      expect(asked).toEqual([])
      expect(get).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
      dispatch.mockRestore()
    }
  })
}

test("omitted SQL warehouse cannot assume the registry dialect before dbt execution", async () => {
  Registry.setConfigs({ fallback: { type: "postgres" } })
  // The dispatcher tries dbt first when warehouse is omitted, so this query may
  // reach MySQL even though the fallback connection uses PostgreSQL comments.
  const dispatch = spyOn(Dispatcher, "call").mockResolvedValue({
    columns: ["value"],
    rows: [[1]],
    row_count: 1,
    truncated: false,
  } as never)
  const asked: string[] = []
  try {
    const tool = await initTool(SqlExecuteTool)
    await expect(
      tool.execute(
        { query: "SELECT 1--2 INTO OUTFILE '/tmp/x'", limit: 10 },
        {
          sessionID: SessionID.make("ses_dbt_comment"),
          messageID: MessageID.make("msg_dbt_comment"),
          callID: "",
          agent: "analyst",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async (request: { permission: string }) => {
            asked.push(request.permission)
            throw new Error("write permission denied")
          },
        },
      ),
    ).rejects.toThrow("write permission denied")
    expect(asked).toEqual(["sql_execute_write"])
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    dispatch.mockRestore()
  }
})
