import { setRegistrationHook } from "./dispatcher"

export * as Dispatcher from "./dispatcher"

// Lazy handler registration — modules are loaded on first Dispatcher.call(),
// not at import time. This prevents @altimateai/altimate-core napi binary
// from loading in test environments where it's not needed.
setRegistrationHook(() => {
  require("./altimate-core")
  require("./sql/register")
  require("./connections/register")
  require("./schema/register")
  require("./finops/register")
  require("./dbt/register")
  require("./local/register")
})
