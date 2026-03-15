// altimate_change - new file
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"

const ENHANCE_NAME = "enhance-prompt"
const ENHANCE_TIMEOUT_MS = 15_000
// MessageV2.User requires branded MessageID/SessionID types, but this is a
// synthetic message that never enters the session store — cast is safe here.
const ENHANCE_ID = ENHANCE_NAME as any

const log = Log.create({ service: ENHANCE_NAME })

// Research-backed enhancement prompt based on:
// - AutoPrompter (arxiv 2504.20196): 5 missing info categories that cause 27% lower edit correctness
// - Meta-prompting best practices: clear role, structural scaffolding, few-shot examples
// - KiloCode's enhance-prompt implementation: lightweight model, preserve intent, no wrapping
const ENHANCE_SYSTEM_PROMPT = `You are a prompt rewriter for a data engineering coding agent. The agent can read/write files, run SQL, manage dbt models, inspect schemas, and execute shell commands.

Your task: rewrite the user's rough prompt into a clearer version that will produce better results. Reply with ONLY the enhanced prompt — no explanations, no wrapping in quotes or code fences.

## What to improve

Research shows developer prompts commonly lack these five categories of information. Add them when missing:

1. **Specifics** — Add concrete details the agent needs: table names, column names, file paths, SQL dialects, error messages. If the user references "the model" or "the table", keep the reference but clarify what the agent should look for.
2. **Action plan** — When the prompt is vague ("fix this"), add explicit steps: investigate first, then modify, then verify. Structure as a logical sequence.
3. **Scope** — Clarify what files, models, or queries are in scope. If ambiguous, instruct the agent to identify the scope first.
4. **Verification** — Add a verification step when the user implies correctness matters (fixes, migrations, refactors). E.g. "run the query to confirm results" or "run dbt test after changes".
5. **Intent clarification** — When the request could be interpreted multiple ways, pick the most likely interpretation and make it explicit.

## Rules

- Preserve the user's intent exactly — never add requirements they didn't ask for
- Keep it concise — a good enhancement adds 1-3 sentences, not paragraphs
- If the prompt is already clear and specific, return it unchanged
- Write in the same tone/style as the user (casual stays casual, technical stays technical)
- Never add generic filler like "please ensure best practices" or "follow coding standards"
- Do not mention yourself or the enhancement process

## Examples

User: "fix the failing test"
Enhanced: "Investigate the failing test — run the test suite first to identify which test is failing and why, then examine the relevant source code, apply a fix, and re-run the test to confirm it passes."

User: "add a created_at column to the users model"
Enhanced: "Add a created_at timestamp column to the users dbt model. Update the SQL definition and the schema.yml entry. Use the appropriate timestamp type for the target warehouse."

User: "why is this query slow"
Enhanced: "Analyze why the query is slow. Run EXPLAIN/query profile to identify bottlenecks (full table scans, missing indexes, expensive joins). Suggest specific optimizations based on the findings."

User: "migrate this from snowflake to bigquery"
Enhanced: "Migrate the SQL from Snowflake dialect to BigQuery dialect. Convert Snowflake-specific functions (e.g. DATEADD, IFF, QUALIFY) to BigQuery equivalents. Preserve the query logic and verify the translated query is syntactically valid."`

export function stripThinkTags(text: string) {
  // Match closed <think>...</think> blocks, and also unclosed <think>... to end of string
  // (unclosed tags happen when the model hits token limit mid-generation)
  return text.replace(/<think>[\s\S]*?(?:<\/think>\s*|$)/g, "")
}

export function clean(text: string) {
  return text
    .trim()
    .replace(/^```\w*\n([\s\S]*?)\n```$/, "$1")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim()
}

/**
 * Check if auto-enhance is enabled in config.
 * Defaults to false — user must explicitly opt in.
 */
export async function isAutoEnhanceEnabled(): Promise<boolean> {
  const cfg = await Config.get()
  return cfg.experimental?.auto_enhance_prompt === true
}

export async function enhancePrompt(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return text

  log.info("enhancing", { length: trimmed.length })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENHANCE_TIMEOUT_MS)

  try {
    const defaultModel = await Provider.defaultModel()
    const model =
      (await Provider.getSmallModel(defaultModel.providerID)) ??
      (await Provider.getModel(defaultModel.providerID, defaultModel.modelID))

    const agent: Agent.Info = {
      name: ENHANCE_NAME,
      mode: "primary",
      hidden: true,
      options: {},
      permission: [],
      prompt: ENHANCE_SYSTEM_PROMPT,
      temperature: 0.7,
    }

    const user: MessageV2.User = {
      id: ENHANCE_ID,
      sessionID: ENHANCE_ID,
      role: "user",
      time: { created: Date.now() },
      agent: ENHANCE_NAME,
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
      abort: controller.signal,
      sessionID: ENHANCE_ID,
      retries: 2,
      messages: [
        {
          role: "user",
          content: trimmed,
        },
      ],
    })

    // Consume the stream explicitly to avoid potential SDK hangs where
    // .text never resolves if the stream isn't drained (Vercel AI SDK caveat)
    for await (const _ of stream.fullStream) {
      // drain
    }
    const result = await stream.text.catch((err) => {
      log.error("failed to enhance prompt", { error: err })
      return undefined
    })

    if (!result) return text

    const cleaned = clean(stripThinkTags(result).trim())
    return cleaned || text
  } catch (err) {
    log.error("enhance prompt failed", { error: err })
    return text
  } finally {
    clearTimeout(timeout)
  }
}
