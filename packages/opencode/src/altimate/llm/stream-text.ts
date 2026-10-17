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
