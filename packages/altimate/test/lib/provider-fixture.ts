// The SDK factory runs before the language hook, so it must return a real SDK object.
export function createScriptedProvider() {
  return {
    languageModel() {
      throw new Error("The scripted language hook was not installed")
    },
  }
}
