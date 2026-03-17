// Side-effect import: registers all altimate_core.* native handlers on load
import "./altimate-core"
// Side-effect import: registers connection/warehouse/sql handlers on load
import "./connections/register"
// Side-effect import: registers schema cache, PII, and tag handlers
import "./schema/register"
// Side-effect import: registers finops handlers
import "./finops/register"
// Side-effect import: registers dbt handlers
import "./dbt/register"
// Side-effect import: registers local testing + ping handlers
import "./local/register"

export * as Dispatcher from "./dispatcher"
