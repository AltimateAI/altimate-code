// altimate_change - new file
//
// Extra guidance for a "Model not found" error. The Anthropic provider lost its Claude Pro/Max sign-in
// in 0.12.11, so a saved `anthropic/...` model with only that login now fails to resolve; the bare
// error gave no reason.
// With suggestions the provider is there and the model name is likely a typo, so no hint.
export function modelNotFoundHint(providerID: string | undefined, suggestions?: readonly string[]) {
  if (providerID !== "anthropic" || suggestions?.length) return undefined
  return "The Anthropic provider needs an API key. For a Claude Pro or Max plan, run /connect and pick Claude subscription."
}
