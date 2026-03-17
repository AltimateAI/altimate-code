// Side-effect import: registers all altimate_core.* native handlers on load
import "./altimate-core"
// Side-effect import: registers connection/warehouse/sql handlers on load
import "./connections/register"

export * as Dispatcher from "./dispatcher"
