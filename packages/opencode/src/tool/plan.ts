import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { type SessionID, MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

async function getLastModel(sessionID: SessionID) {
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = path.relative(Instance.worktree, Session.plan(session))
    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      // altimate_change start — UI copy reflects canonical agent name (renamed from "build")
      questions: [
        {
          question: `Plan at ${plan} is complete. Would you like to switch to the builder agent and start implementing?`,
          header: "Builder Agent",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to builder agent and start implementing the plan" },
            { label: "No", description: "Stay with plan agent to continue refining the plan" },
          ],
        },
      ],
      // altimate_change end
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const answer = answers[0]?.[0]
    // altimate_change start — reject on anything other than explicit "Yes" (covers cancel/dismiss/network drop).
    // v1.4.0 changed this to `answer === "No"` which silently confirms on dismiss — unsafe for agent transitions.
    if (answer !== "Yes") throw new Question.RejectedError()
    // altimate_change end

    const model = await getLastModel(ctx.sessionID)

    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: ctx.sessionID,
      role: "user",
      time: {
        created: Date.now(),
      },
      // altimate_change start — use canonical "builder" name (renamed from "build")
      // The Agent.get() alias in agent.ts:408 maps the legacy "build" to "builder"
      // so the session still executes correctly, but the telemetry agent_outcome
      // event in prompt.ts records the literal `lastUser.agent` value. Hardcoding
      // "build" here meant every plan-exit invocation showed up as a separate
      // (and confusingly-named) `agent: "build"` row in agent_outcome telemetry —
      // 133 invocations in 14 days, 0% completion in the dashboard, distinct
      // from builder's actual numbers. Using the canonical name folds these
      // back into the right bucket.
      agent: "builder",
      // altimate_change end
      model,
    }
    await Session.updateMessage(userMsg)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
      synthetic: true,
    } satisfies MessageV2.TextPart)

    // altimate_change start — title/output text reflects canonical "builder" name (renamed from "build")
    return {
      title: "Switching to builder agent",
      output: "User approved switching to builder agent. Wait for further instructions.",
      metadata: {},
    }
    // altimate_change end
  },
})

/*
export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = path.relative(Instance.worktree, Session.plan(session))

    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: [
        {
          question: `Would you like to switch to the plan agent and create a plan saved to ${plan}?`,
          header: "Plan Mode",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to plan agent for research and planning" },
            { label: "No", description: "Stay with build agent to continue making changes" },
          ],
        },
      ],
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const answer = answers[0]?.[0]

    if (answer === "No") throw new Question.RejectedError()

    const model = await getLastModel(ctx.sessionID)

    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: ctx.sessionID,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: "plan",
      model,
    }
    await Session.updateMessage(userMsg)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: "User has requested to enter plan mode. Switch to plan mode and begin planning.",
      synthetic: true,
    } satisfies MessageV2.TextPart)

    return {
      title: "Switching to plan agent",
      output: `User confirmed to switch to plan mode. A new message has been created to switch you to plan mode. The plan file will be at ${plan}. Begin planning.`,
      metadata: {},
    }
  },
})
*/
