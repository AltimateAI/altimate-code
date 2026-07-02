import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { QuestionID } from "@/question/schema"
import { Question } from "../../question"
import z from "zod"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { zod } from "../../util/effect-zod"

export const QuestionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending questions",
        description: "Get all pending question requests across all sessions.",
        operationId: "question.list",
        responses: {
          200: {
            description: "List of pending questions",
            content: {
              "application/json": {
                schema: resolver(z.array(zod(Question.Request))),
              },
            },
          },
        },
      }),
      async (c) => {
        const questions = await Question.list()
        return c.json(questions)
      },
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Reply to question request",
        description: "Provide answers to a question request from the AI assistant.",
        operationId: "question.reply",
        responses: {
          200: {
            description: "Question answered successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          // altimate_change start — upstream_fix: use QuestionID.zod so invalid prefixes reject at the Hono edge
          requestID: QuestionID.zod,
          // altimate_change end
        }),
      ),
      validator("json", zod(Question.Reply)),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        await Question.reply({
          requestID: params.requestID,
          answers: json.answers,
        })
        return c.json(true)
      },
    )
    .post(
      "/:requestID/reject",
      describeRoute({
        summary: "Reject question request",
        description: "Reject a question request from the AI assistant.",
        operationId: "question.reject",
        responses: {
          200: {
            description: "Question rejected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          // altimate_change start — upstream_fix: use QuestionID.zod so invalid prefixes reject at the Hono edge
          requestID: QuestionID.zod,
          // altimate_change end
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Question.reject(params.requestID)
        return c.json(true)
      },
    ),
)
