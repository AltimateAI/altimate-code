import { Flag as CoreFlag } from "@opencode-ai/core/flag/flag"
import { Flag } from "../../../src/flag/flag"

console.log(
  JSON.stringify({
    coreMode: CoreFlag.ALTIMATE_ASSESSMENT_MODE,
    coreModelsOff: CoreFlag.OPENCODE_DISABLE_MODELS_FETCH,
    coreWorkspaceOff: CoreFlag.ALTIMATE_DISABLE_WORKSPACE,
    mode: Flag.assessmentMode(),
    modelsOff: Flag.OPENCODE_DISABLE_MODELS_FETCH,
  }),
)
