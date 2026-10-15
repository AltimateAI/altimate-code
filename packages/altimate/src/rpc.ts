import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

export const Warehouse = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  type: Schema.Literal("duckdb"),
})

export const QueryResult = Schema.Struct({
  warehouse: Schema.String,
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.Json)),
  row_count: Schema.Number,
  truncated: Schema.Boolean,
})

export const AltimateRpc = Rpc.define({
  id: "altimate",
  methods: {
    listWarehouses: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Array(Warehouse)),
    },
    lastResult: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.NullOr(QueryResult)),
    },
  },
  events: {},
})

export default AltimateRpc
