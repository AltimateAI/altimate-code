import { describe, expect, test } from "bun:test"
import { normalizeMqlCommand } from "@altimateai/drivers"
import { classifyAndCheck, classifyMongoCommand } from "../../src/altimate/tools/sql-classify"

// MongoDB commands are JSON documents. The SQL classifier reads every one as a write, which
// denied all 52 Mongo reads for the read-only analyst in one benchmark sweep; models also write
// the native `{"find": "coll"}` wire shape as often as the driver's `{command, collection}` form.
describe("MongoDB command classification", () => {
  test("the SQL classifier treats a JSON command as a write (the defect)", () => {
    expect(classifyAndCheck('{"find":"business","filter":{}}').queryType).toBe("write")
  })

  test("native find/aggregate/count/distinct shapes are reads and are normalized", () => {
    const find = classifyMongoCommand('{"find":"business","filter":{"city":"X"},"projection":{"_id":0},"limit":5}')!
    expect(find.queryType).toBe("read")
    expect(find.blocked).toBe(false)
    expect(JSON.parse(find.normalized)).toMatchObject({ command: "find", collection: "business", limit: 5 })

    const agg = classifyMongoCommand('{"aggregate":"reviews","pipeline":[{"$match":{"stars":5}},{"$count":"n"}]}')!
    expect(agg.queryType).toBe("read")
    expect(JSON.parse(agg.normalized)).toMatchObject({ command: "aggregate", collection: "reviews" })

    const count = classifyMongoCommand('{"count":"reviews","filter":{}}')!
    expect(JSON.parse(count.normalized)).toMatchObject({ command: "countDocuments", collection: "reviews" })

    const distinct = classifyMongoCommand('{"distinct":"reviews","key":"city"}')!
    expect(distinct.queryType).toBe("read")
    expect(JSON.parse(distinct.normalized)).toMatchObject({ command: "distinct", collection: "reviews", field: "city" })
  })

  test("the driver shape passes through unchanged", () => {
    const r = classifyMongoCommand('{"command":"find","collection":"c","filter":{}}')!
    expect(r.queryType).toBe("read")
    expect(JSON.parse(r.normalized)).toEqual({ command: "find", collection: "c", filter: {} })
  })

  test("writes stay writes; drops are blocked; $out/$merge pipelines are writes", () => {
    expect(classifyMongoCommand('{"command":"insertOne","collection":"c","document":{}}')!.queryType).toBe("write")
    expect(classifyMongoCommand('{"command":"deleteMany","collection":"c","filter":{}}')!.queryType).toBe("write")
    expect(classifyMongoCommand('{"command":"dropCollection","collection":"c"}')!.blocked).toBe(true)
    expect(classifyMongoCommand('{"aggregate":"c","pipeline":[{"$match":{}},{"$out":"d"}]}')!.queryType).toBe("write")
    expect(classifyMongoCommand('{"aggregate":"c","pipeline":[{"$merge":{"into":"d"}}]}')!.queryType).toBe("write")
  })

  test("non-JSON text is left to the SQL classifier", () => {
    expect(classifyMongoCommand("SELECT 1")).toBeNull()
    expect(classifyMongoCommand("{not json")).toBeNull()
    expect(classifyMongoCommand("[1,2]")).toBeNull()
  })

  test("normalizeMqlCommand never invents a command", () => {
    expect(normalizeMqlCommand({ filter: {} } as any)).toEqual({ filter: {} })
    expect(normalizeMqlCommand({ find: 7 } as any)).toEqual({ find: 7 })
  })
})
