import { NamedError } from "@opencode-ai/core/util/error"
import { Bus } from "../../bus"
import { Session } from "../../session"
import { Provider, validateModelSelection } from "../../provider/provider"
import type { ModelID, ProviderID } from "../../provider/schema"
import type { SessionID } from "../../session/schema"
import { modelSelectionErrorText } from "../provider/model-hint"
import { ModelMetadata } from "./model-metadata"

// Publish guided text for an unavailable model once, marking the error so routes don't repeat it.
export function reportModelSelectionError(sessionID: SessionID, error: unknown) {
  if (!Provider.ModelNotFoundError.isInstance(error)) return
  ModelMetadata.markReported(error)
  Bus.publish(Session.Event.Error, {
    sessionID,
    error: new NamedError.Unknown({ message: modelSelectionErrorText(error.data) }).toObject(),
  })
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
