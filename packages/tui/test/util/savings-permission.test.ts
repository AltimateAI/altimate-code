// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { savingsPermissionPrompt } from "../../src/util/savings-permission"

describe("savings check permission prompt", () => {
  test("names the connection the check runs on, and that it can bill", () => {
    expect(savingsPermissionPrompt("finops_databricks_savings", ["prod_dbx"])).toEqual({
      title: "Run the Databricks savings check on prod_dbx",
      note: "Read-only queries that can start this connection's warehouse and bill while they run.",
    })
    expect(savingsPermissionPrompt("finops_snowflake_savings", ["*"])?.title).toBe("Run the Snowflake savings check on the default connection")
    expect(savingsPermissionPrompt("finops_snowflake_savings", undefined)?.title).toBe("Run the Snowflake savings check on the default connection")
  })

  test("leaves every other permission to the generic prompt", () => {
    for (const permission of ["bash", "sql_execute", "finops_query_history", "constructor", "toString", "__proto__"])
      expect(savingsPermissionPrompt(permission, ["x"])).toBeUndefined()
  })
})
