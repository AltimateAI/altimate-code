function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const ALTIMATE_CLI_AUTO_SHARE = truthy("ALTIMATE_CLI_AUTO_SHARE")
  export const ALTIMATE_CLI_GIT_BASH_PATH = process.env["ALTIMATE_CLI_GIT_BASH_PATH"]
  export const ALTIMATE_CLI_CONFIG = process.env["ALTIMATE_CLI_CONFIG"]
  export declare const ALTIMATE_CLI_CONFIG_DIR: string | undefined
  export const ALTIMATE_CLI_CONFIG_CONTENT = process.env["ALTIMATE_CLI_CONFIG_CONTENT"]
  export const ALTIMATE_CLI_DISABLE_AUTOUPDATE = truthy("ALTIMATE_CLI_DISABLE_AUTOUPDATE")
  export const ALTIMATE_CLI_DISABLE_PRUNE = truthy("ALTIMATE_CLI_DISABLE_PRUNE")
  export const ALTIMATE_CLI_DISABLE_TERMINAL_TITLE = truthy("ALTIMATE_CLI_DISABLE_TERMINAL_TITLE")
  export const ALTIMATE_CLI_PERMISSION = process.env["ALTIMATE_CLI_PERMISSION"]
  export const ALTIMATE_CLI_DISABLE_DEFAULT_PLUGINS = truthy("ALTIMATE_CLI_DISABLE_DEFAULT_PLUGINS")
  export const ALTIMATE_CLI_DISABLE_LSP_DOWNLOAD = truthy("ALTIMATE_CLI_DISABLE_LSP_DOWNLOAD")
  export const ALTIMATE_CLI_ENABLE_EXPERIMENTAL_MODELS = truthy("ALTIMATE_CLI_ENABLE_EXPERIMENTAL_MODELS")
  export const ALTIMATE_CLI_DISABLE_AUTOCOMPACT = truthy("ALTIMATE_CLI_DISABLE_AUTOCOMPACT")
  export const ALTIMATE_CLI_DISABLE_MODELS_FETCH = truthy("ALTIMATE_CLI_DISABLE_MODELS_FETCH")
  export const ALTIMATE_CLI_DISABLE_CLAUDE_CODE = truthy("ALTIMATE_CLI_DISABLE_CLAUDE_CODE")
  export const ALTIMATE_CLI_DISABLE_CLAUDE_CODE_PROMPT =
    ALTIMATE_CLI_DISABLE_CLAUDE_CODE || truthy("ALTIMATE_CLI_DISABLE_CLAUDE_CODE_PROMPT")
  export const ALTIMATE_CLI_DISABLE_CLAUDE_CODE_SKILLS =
    ALTIMATE_CLI_DISABLE_CLAUDE_CODE || truthy("ALTIMATE_CLI_DISABLE_CLAUDE_CODE_SKILLS")
  export const ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS =
    ALTIMATE_CLI_DISABLE_CLAUDE_CODE_SKILLS || truthy("ALTIMATE_CLI_DISABLE_EXTERNAL_SKILLS")
  export declare const ALTIMATE_CLI_DISABLE_PROJECT_CONFIG: boolean
  export const ALTIMATE_CLI_FAKE_VCS = process.env["ALTIMATE_CLI_FAKE_VCS"]
  export declare const ALTIMATE_CLI_CLIENT: string
  export const ALTIMATE_CLI_SERVER_PASSWORD = process.env["ALTIMATE_CLI_SERVER_PASSWORD"]
  export const ALTIMATE_CLI_SERVER_USERNAME = process.env["ALTIMATE_CLI_SERVER_USERNAME"]
  export const ALTIMATE_CLI_ENABLE_QUESTION_TOOL = truthy("ALTIMATE_CLI_ENABLE_QUESTION_TOOL")

  // Experimental
  export const ALTIMATE_CLI_EXPERIMENTAL = truthy("ALTIMATE_CLI_EXPERIMENTAL")
  export const ALTIMATE_CLI_EXPERIMENTAL_FILEWATCHER = truthy("ALTIMATE_CLI_EXPERIMENTAL_FILEWATCHER")
  export const ALTIMATE_CLI_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("ALTIMATE_CLI_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const ALTIMATE_CLI_EXPERIMENTAL_ICON_DISCOVERY =
    ALTIMATE_CLI_EXPERIMENTAL || truthy("ALTIMATE_CLI_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["ALTIMATE_CLI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const ALTIMATE_CLI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("ALTIMATE_CLI_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const ALTIMATE_CLI_ENABLE_EXA =
    truthy("ALTIMATE_CLI_ENABLE_EXA") || ALTIMATE_CLI_EXPERIMENTAL || truthy("ALTIMATE_CLI_EXPERIMENTAL_EXA")
  export const ALTIMATE_CLI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("ALTIMATE_CLI_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const ALTIMATE_CLI_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("ALTIMATE_CLI_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const ALTIMATE_CLI_EXPERIMENTAL_OXFMT = ALTIMATE_CLI_EXPERIMENTAL || truthy("ALTIMATE_CLI_EXPERIMENTAL_OXFMT")
  export const ALTIMATE_CLI_EXPERIMENTAL_LSP_TY = truthy("ALTIMATE_CLI_EXPERIMENTAL_LSP_TY")
  export const ALTIMATE_CLI_EXPERIMENTAL_LSP_TOOL = ALTIMATE_CLI_EXPERIMENTAL || truthy("ALTIMATE_CLI_EXPERIMENTAL_LSP_TOOL")
  export const ALTIMATE_CLI_DISABLE_FILETIME_CHECK = truthy("ALTIMATE_CLI_DISABLE_FILETIME_CHECK")
  export const ALTIMATE_CLI_EXPERIMENTAL_PLAN_MODE = ALTIMATE_CLI_EXPERIMENTAL || truthy("ALTIMATE_CLI_EXPERIMENTAL_PLAN_MODE")
  export const ALTIMATE_CLI_EXPERIMENTAL_MARKDOWN = truthy("ALTIMATE_CLI_EXPERIMENTAL_MARKDOWN")
  export const ALTIMATE_CLI_MODELS_URL = process.env["ALTIMATE_CLI_MODELS_URL"]
  export const ALTIMATE_CLI_MODELS_PATH = process.env["ALTIMATE_CLI_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for ALTIMATE_CLI_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "ALTIMATE_CLI_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("ALTIMATE_CLI_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for ALTIMATE_CLI_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "ALTIMATE_CLI_CONFIG_DIR", {
  get() {
    return process.env["ALTIMATE_CLI_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for ALTIMATE_CLI_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "ALTIMATE_CLI_CLIENT", {
  get() {
    return process.env["ALTIMATE_CLI_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
