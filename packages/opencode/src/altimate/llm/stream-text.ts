/** Read an AI SDK text stream without losing provider errors to .text's fallback error. */
export async function readStreamText(stream: {
  fullStream: AsyncIterable<{ type: string; error?: unknown }>
  readonly text: PromiseLike<string>
}): Promise<string> {
  const text = Promise.resolve(stream.text)
  // .text can reject with NoOutputGeneratedError while fullStream contains the
  // original provider error. Observe its rejection, but prefer the stream error.
  void text.catch(() => {})
  for await (const part of stream.fullStream) {
    if (part.type === "error") throw part.error
  }
  return text
}

/** A tool call the model made in one step, as the AI SDK reports it. */
export interface StepToolCall {
  toolCallId: string
  toolName: string
  input: unknown
  /** The SDK could not parse the call or the tool does not exist. */
  invalid?: boolean
}

/**
 * Read one AI SDK step without discarding its tool calls: the text, why the
 * step ended, the tool calls it made, and the response messages to append to
 * the conversation for the next step. Tools without an `execute` are not run
 * by the SDK; the caller runs them and appends the results. Like
 * `readStreamText`, a stream error is thrown rather than lost.
 */
export async function readStreamStep(stream: {
  fullStream: AsyncIterable<{ type: string; error?: unknown }>
  readonly text: PromiseLike<string>
  readonly finishReason: PromiseLike<string>
  readonly response: PromiseLike<{ messages: unknown[] }>
}): Promise<{ text: string; finishReason: string; toolCalls: StepToolCall[]; messages: unknown[] }> {
  const toolCalls: StepToolCall[] = []
  const text = await readStreamText({
    text: stream.text,
    fullStream: (async function* () {
      for await (const part of stream.fullStream) {
        if (part.type === "tool-call") {
          const p = part as unknown as StepToolCall
          toolCalls.push({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input, invalid: p.invalid })
        }
        yield part
      }
    })(),
  })
  const [finishReason, response] = await Promise.all([stream.finishReason, stream.response])
  return { text, finishReason, toolCalls, messages: response?.messages ?? [] }
}
