// altimate_change start — prompt input line navigation helpers
export type PromptLineNavigationState = {
  scrollY: number
  visualCursor: {
    visualRow: number
  }
  editorView: {
    getTotalVirtualLineCount(): number
  }
}

export type PromptLineEndpointEditor = {
  gotoLineHome(): boolean
  gotoLineEnd(): boolean
}

export function isPromptCursorOnFirstLine(input: PromptLineNavigationState) {
  return input.scrollY + input.visualCursor.visualRow === 0
}

export function isPromptCursorOnLastLine(input: PromptLineNavigationState) {
  return input.scrollY + input.visualCursor.visualRow === Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
}

export function movePromptCursorToLineHome(input: PromptLineEndpointEditor) {
  return input.gotoLineHome()
}

export function movePromptCursorToLineEnd(input: PromptLineEndpointEditor) {
  return input.gotoLineEnd()
}
// altimate_change end
