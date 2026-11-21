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

export function modelNotFoundMessage(providerID: string | undefined, modelID: string | undefined, source?: string) {
  const sourceHint = source ? ` (from ${source})` : ""
  if (providerID === "" && modelID === "") {
    return `Empty model value${sourceHint}. Use a provider/model-name value.`
  }
  return `Model not found: ${providerID}/${modelID}${sourceHint}`
}
