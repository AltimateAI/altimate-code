/** A small compiled manifest for dbt_lineage's manifest answer: customers and its three parents. */
export const CUSTOMERS_SQL = `select c.customer_id, c.first_name, count(o.order_id) as number_of_orders, sum(p.amount) as total_amount
from "jaffle"."main"."stg_customers" c
left join "jaffle"."main"."stg_orders" o on o.customer_id = c.customer_id
left join "jaffle"."main"."raw_payments" p on p.order_id = o.order_id
group by 1, 2`

export function lineageManifest(compiled: string | null = CUSTOMERS_SQL) {
  return {
    metadata: { adapter_type: "duckdb", project_name: "jaffle_shop" },
    nodes: {
      "model.jaffle_shop.stg_customers": {
        unique_id: "model.jaffle_shop.stg_customers",
        resource_type: "model",
        name: "stg_customers",
        alias: "stg_customers",
        package_name: "jaffle_shop",
        original_file_path: "models/staging/stg_customers.sql",
        config: { materialized: "view" },
        depends_on: { nodes: [] },
        columns: {
          customer_id: { name: "customer_id", data_type: "integer", description: "The customer" },
          first_name: { name: "first_name" },
        },
      },
      "model.jaffle_shop.stg_orders": {
        unique_id: "model.jaffle_shop.stg_orders",
        resource_type: "model",
        name: "stg_orders",
        alias: "stg_orders",
        package_name: "jaffle_shop",
        original_file_path: "models/staging/stg_orders.sql",
        config: { materialized: "view" },
        depends_on: { nodes: ["model.jaffle_shop.stg_customers"] },
        columns: {},
      },
      "model.jaffle_shop.customers": {
        unique_id: "model.jaffle_shop.customers",
        resource_type: "model",
        name: "customers",
        alias: "customers",
        package_name: "jaffle_shop",
        original_file_path: "models/customers.sql",
        config: { materialized: "table" },
        depends_on: {
          nodes: [
            "model.jaffle_shop.stg_customers",
            "model.jaffle_shop.stg_orders",
            "source.jaffle_shop.stripe.payments",
          ],
        },
        columns: {},
        ...(compiled === null ? {} : { compiled_code: compiled }),
      },
    },
    sources: {
      "source.jaffle_shop.stripe.payments": {
        unique_id: "source.jaffle_shop.stripe.payments",
        resource_type: "source",
        source_name: "stripe",
        name: "payments",
        identifier: "raw_payments",
        original_file_path: "models/staging/sources.yml",
        columns: { order_id: { name: "order_id" }, amount: { name: "amount", data_type: "integer" } },
      },
    },
  }
}
