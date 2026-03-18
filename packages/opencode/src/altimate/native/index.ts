import { setRegistrationHook } from "./dispatcher"

export * as Dispatcher from "./dispatcher"

// Lazy handler registration — modules are loaded on first Dispatcher.call(),
// not at import time. This prevents @altimateai/altimate-core napi binary
// from loading in test environments where it's not needed.
setRegistrationHook(async () => {
  await import("./altimate-core")
  await import("./sql/register")
  await import("./connections/register")
  await import("./schema/register")
  await import("./finops/register")
  await import("./dbt/register")
  await import("./local/register")
})
