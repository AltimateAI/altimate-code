import { NamedError } from "@opencode-ai/core/util/error"
import { Bus } from "../../bus"
import { Session } from "../../session"
import { Provider, validateModelSelection } from "../../provider/provider"
import type { ModelID, ProviderID } from "../../provider/schema"
import type { SessionID } from "../../session/schema"
import { modelSelectionErrorText } from "../provider/model-hint"
import { ModelMetadata } from "./model-metadata"
import { Log } from "../../util/log"

const log = Log.create({ service: "model-report" })

// The error is already marked reported, so a failed publish must leave a trace.
export function publishReported(sessionID: SessionID, error: InstanceType<typeof NamedError.Unknown>) {
  void Bus.publish(Session.Event.Error, { sessionID, error: error.toObject() }).catch((cause) =>
    log.warn("session error event not published", { sessionID, cause }),
  )
}

// Publish guided text for an unavailable model once, marking the error so routes don't repeat it.
export function reportModelSelectionError(sessionID: SessionID, error: unknown) {
  if (!Provider.ModelNotFoundError.isInstance(error)) return
  ModelMetadata.markReported(error)
  publishReported(sessionID, new NamedError.Unknown({ message: modelSelectionErrorText(error.data) }))
}

// Validate a selected model, publishing guided text once and rethrowing the same error instance.
export async function validateOrReport(
  sessionID: SessionID,
  model: { providerID: ProviderID; modelID: ModelID },
  source: string,
) {
  return validateModelSelection(model, source).catch((error) => {
    reportModelSelectionError(sessionID, error)
    throw error
  })
}

export * as ModelReport from "./model-report"
