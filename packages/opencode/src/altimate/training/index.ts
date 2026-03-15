// altimate_change - Training module exports
export { TrainingStore, type TrainingEntry } from "./store"
export { TrainingPrompt } from "./prompt"
export { TrainingInsights, type TrainingInsight } from "./insights"
export {
  TrainingKind,
  TRAINING_TAG,
  TRAINING_ID_PREFIX,
  TRAINING_MAX_PATTERNS_PER_KIND,
  TRAINING_BUDGET,
  trainingId,
  trainingTags,
  isTrainingBlock,
  trainingKind,
  parseTrainingMeta,
  embedTrainingMeta,
  type TrainingBlockMeta,
} from "./types"
