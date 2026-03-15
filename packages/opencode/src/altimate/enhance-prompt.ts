// altimate_change - new file
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"

const log = Log.create({ service: "enhance-prompt" })

const ENHANCE_SYSTEM_PROMPT = `You are a prompt enhancement specialist for a data engineering coding agent.

Your job is to take a user's rough prompt and rewrite it into a clearer, more specific version that will produce better results from the coding agent.

Rules:
- Reply with ONLY the enhanced prompt text — no conversation, explanations, lead-in, bullet points, placeholders, or surrounding quotes
- Preserve the user's intent exactly — do not add requirements they didn't ask for
- Make implicit requirements explicit (e.g. if they say "fix the bug", specify what kind of verification to do)
- Add structure when the prompt is vague (e.g. "look at X first, then modify Y")
- Keep the enhanced prompt concise — longer is not better
- If the original prompt is already clear and specific, return it unchanged
- Do not wrap your response in markdown code fences or quotes`

export function clean(text: string) {
  return text
    .replace(/^```\w*\n?|```$/g, "")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim()
}

export async function enhancePrompt(text: string): Promise<string> {
  if (!text.trim()) return text

  log.info("enhancing", { length: text.length })

  const defaultModel = await Provider.defaultModel()
  const model =
    (await Provider.getSmallModel(defaultModel.providerID)) ??
    (await Provider.getModel(defaultModel.providerID, defaultModel.modelID))

  const agent: Agent.Info = {
    name: "enhance-prompt",
    mode: "primary",
    hidden: true,
    options: {},
    permission: [],
    prompt: ENHANCE_SYSTEM_PROMPT,
    temperature: 0.7,
  }

  const user: MessageV2.User = {
    id: "enhance-prompt" as any,
    sessionID: "enhance-prompt" as any,
    role: "user",
    time: { created: Date.now() },
    agent: "enhance-prompt",
    model: {
      providerID: model.providerID,
      modelID: model.id,
    },
  }

  const stream = await LLM.stream({
    agent,
    user,
    system: [],
    small: true,
    tools: {},
    model,
    abort: new AbortController().signal,
    sessionID: "enhance-prompt" as any,
    retries: 2,
    messages: [
      {
        role: "user",
        content: text,
      },
    ],
  })

  const result = await stream.text.catch((err) => {
    log.error("failed to enhance prompt", { error: err })
    return undefined
  })

  if (!result) return text

  const cleaned = clean(
    result
      .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
      .trim(),
  )

  return cleaned || text
}
