// altimate_change - Training module exports
export { TrainingStore, type TrainingEntry } from "./store"
export { TrainingPrompt } from "./prompt"
export {
  TrainingKind,
  TRAINING_TAG,
  TRAINING_ID_PREFIX,
  TRAINING_MAX_PATTERNS_PER_KIND,
  trainingId,
  trainingTags,
  isTrainingBlock,
  trainingKind,
  parseTrainingMeta,
  embedTrainingMeta,
  type TrainingBlockMeta,
} from "./types"
