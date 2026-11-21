// altimate_change - new file
//
// Extra guidance for a "Model not found" error. The Anthropic provider lost its Claude Pro/Max sign-in
// in 0.12.11, so a saved `anthropic/...` model with only that login now fails to resolve; the bare
// error gave no reason. Only a missing provider gets the hint: an Anthropic provider that is there
// with an unknown model name needs a different model, not a key.
export const modelConfigHint =
  "Check the provider and model in your project config (altimate-code.json or opencode.json, including .jsonc files, at the project root or in .altimate-code/ or .opencode/) or global config (~/.config/altimate-code/)."

export function modelNotFoundHint(providerID: string | undefined, providerMissing: boolean | undefined) {
  if (providerID !== "anthropic" || providerMissing !== true) return undefined
  return "The Anthropic provider needs an API key. For a Claude Pro or Max plan, run /connect and pick Claude subscription."
}

// An environment variable that is not set substitutes to "", which is the usual cause of an empty value.
export const EMPTY_MODEL_HINT =
  'If it references an environment variable such as "${ALTIMATE_MODEL}", check that the variable is set; otherwise set a provider/model-name value or remove the key.'

export function modelNotFoundMessage(providerID: string | undefined, modelID: string | undefined, source?: string) {
  const sourceHint = source ? ` (from ${source})` : ""
  if (providerID === "" && modelID === "") {
    return `Empty model value${sourceHint}: the model key is set to "". ${EMPTY_MODEL_HINT}`
  }
  return `Model not found: ${providerID}/${modelID}${sourceHint}`
}

// Full user-facing text for an unavailable model: the source-named line, suggestions, provider
// guidance and where to correct the config.
export function modelSelectionErrorText(data: {
  providerID?: string
  modelID?: string
  source?: string
  suggestions?: readonly string[]
  providerMissing?: boolean
}) {
  const message = modelNotFoundMessage(data.providerID, data.modelID, data.source)
  const hint = data.suggestions?.length ? ` Did you mean: ${data.suggestions.join(", ")}?` : ""
  const guidance = modelNotFoundHint(data.providerID, data.providerMissing)
  return `${message.endsWith(".") ? message : message + "."}${hint}${guidance ? ` ${guidance}` : ""} ${modelConfigHint}`
}
