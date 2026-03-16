// altimate_change start - LLM-based dynamic skill selection
import { Provider } from "../provider/provider"
import { LLM } from "../session/llm"
import { Agent } from "../agent/agent"
import { Log } from "../util/log"
import { MessageV2 } from "../session/message-v2"
import { MessageID, SessionID } from "../session/schema"
import type { Skill } from "../skill"
import type { Fingerprint } from "./fingerprint"
import { Tracer } from "./observability/tracing"

const log = Log.create({ service: "skill-selector" })

const TIMEOUT_MS = 5_000
const MAX_SKILLS = 15
const SELECTOR_NAME = "skill-selector"

// Session cache keyed by working directory — invalidates if project changes.
let cachedResult: Skill.Info[] | undefined
let cachedCwd: string | undefined

/** Reset the session cache (exported for testing) */
export function resetSkillSelectorCache(): void {
  cachedResult = undefined
  cachedCwd = undefined
}

export interface SkillSelectorDeps {
  run: (prompt: string, skillNames: string[]) => Promise<string[]>
}

/**
 * Use the configured model to select relevant skills based on the project fingerprint.
 * Results are cached per working directory — the LLM is only called once per project.
 *
 * Graceful fallback: returns ALL skills on any failure (matches pre-feature behavior).
 */
export async function selectSkillsWithLLM(
  skills: Skill.Info[],
  fingerprint: Fingerprint.Result | undefined,
  deps?: SkillSelectorDeps,
): Promise<Skill.Info[]> {
  const startTime = Date.now()

  // Return cached result if cwd hasn't changed (0ms)
  const cwd = fingerprint?.cwd
  if (cachedResult && cwd === cachedCwd) {
    log.info("returning cached skill selection", {
      count: cachedResult.length,
    })
    Tracer.active?.logSpan({
      name: "skill-selection",
      startTime,
      endTime: Date.now(),
      input: { fingerprint: fingerprint?.tags, source: "cache" },
      output: { count: cachedResult.length, skills: cachedResult.map((s) => s.name) },
    })
    return cachedResult
  }

  function cache(result: Skill.Info[]): Skill.Info[] {
    cachedResult = result
    cachedCwd = cwd
    return result
  }

  try {
    const envContext =
      fingerprint && fingerprint.tags.length > 0
        ? fingerprint.tags.join(", ")
        : "none detected"

    const skillList = skills.map((s) => `- ${s.name}: ${s.description}`)

    const prompt = [
      `Project environment: ${envContext}`,
      "",
      "Available skills:",
      ...skillList,
      "",
      "Return ONLY the names of relevant skills, one per line. No explanations.",
    ].join("\n")

    const skillNames = skills.map((s) => s.name)

    let selected: string[]
    if (deps) {
      selected = await deps.run(prompt, skillNames)
    } else {
      selected = await runWithLLM(prompt, skillNames)
    }

    selected = selected.slice(0, MAX_SKILLS)

    // Zero-selection guard
    if (selected.length === 0) {
      log.info("LLM returned zero skills, returning all")
      return cache(skills)
    }

    // Filter skills by returned names
    const selectedSet = new Set(selected)
    const matched = skills.filter((s) => selectedSet.has(s.name))

    // If no valid matches (LLM returned non-existent names), return all
    if (matched.length === 0) {
      log.info("LLM returned no valid skill names, returning all")
      return cache(skills)
    }

    log.info("selected skills", {
      count: matched.length,
      names: matched.map((s) => s.name),
    })
    Tracer.active?.logSpan({
      name: "skill-selection",
      startTime,
      endTime: Date.now(),
      input: { fingerprint: fingerprint?.tags, totalSkills: skills.length, source: "llm" },
      output: { count: matched.length, skills: matched.map((s) => s.name) },
    })
    return cache(matched)
  } catch (e) {
    log.info("skill selection failed, returning all skills", {
      error: e instanceof Error ? e.message : String(e),
    })
    Tracer.active?.logSpan({
      name: "skill-selection",
      startTime,
      endTime: Date.now(),
      status: "error",
      input: { fingerprint: fingerprint?.tags, source: "fallback" },
      output: { count: skills.length, error: e instanceof Error ? e.message : String(e) },
    })
    return cache(skills)
  }
}

const SYSTEM_PROMPT = [
  "You are a skill selector for a coding assistant.",
  "Given a project environment and available skills, select which skills are relevant for this project.",
  "Return ONLY skill names, one per line. Select 0-15 skills.",
  "Prefer fewer, more relevant skills over many loosely related ones.",
  "Do not include explanations or formatting — just the skill names.",
].join("\n")

async function runWithLLM(prompt: string, validNames: string[]): Promise<string[]> {
  const defaultModel = await Provider.defaultModel()
  const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)

  const agent: Agent.Info = {
    name: SELECTOR_NAME,
    mode: "primary",
    hidden: true,
    options: {},
    permission: [],
    prompt: SYSTEM_PROMPT,
    temperature: 0,
  }

  const user: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: SessionID.descending(),
    role: "user",
    time: { created: Date.now() },
    agent: SELECTOR_NAME,
    model: {
      providerID: model.providerID,
      modelID: model.id,
    },
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const stream = await LLM.stream({
      agent,
      user,
      system: [],
      tools: {},
      model,
      abort: controller.signal,
      sessionID: user.sessionID,
      retries: 1,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    })

    // Drain the stream
    for await (const _ of stream.fullStream) {
      // drain
    }
    const text = await stream.text

    // Parse: one skill name per line, filter to valid names
    const nameSet = new Set(validNames)
    return text
      .split("\n")
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter((line) => nameSet.has(line))
  } finally {
    clearTimeout(timeout)
  }
}
// altimate_change end
