import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

// altimate_change start — Codex re-review round 8 (cycle-stability/ready-pending test coverage) /
// round 9 (stale-revision cancellation): a reactive defer-then-retry primitive — call `.defer()`
// when a caller can't act yet (e.g. a readiness signal is still pending), and the wrapped `retry`
// callback fires automatically, exactly once, the NEXT time `pending()` reads false. Extracted as
// a standalone, importable function so the SAME production code path is exercised by both a real
// consumer (component/prompt/index.tsx's submit gate — see `readyPending`'s declaration there)
// and its test (test/context/ready-pending.test.tsx) — the test was previously a hand-rolled
// reimplementation of this exact shape, which meant reverting the real fix in prompt/index.tsx
// left the test passing regardless, since it never touched production code at all.
//
// `options.getRevision`, if given, is called ONCE at `.defer()` time (capturing whatever it
// returns) and again right before `retry()` would fire — if the two differ (by JSON equality),
// `retry()` is skipped entirely rather than fired against stale state. This is what
// component/prompt/index.tsx's submit gate uses to snapshot the prompt (text + attachments) at
// the moment a submission defers: without it, a user who deferred prompt A, then edited the box
// to B WITHOUT pressing Enter again, would have B silently auto-submitted the instant readiness
// resolved — a send the user never asked for, not a resend of the one they did.
export function createDeferredRetry<T = void>(
  pending: Accessor<boolean>,
  retry: () => void,
  options?: { getRevision?: () => T },
) {
  let deferred = false
  let capturedRevision: T | undefined
  createEffect(() => {
    if (pending() || !deferred) return
    deferred = false
    if (options?.getRevision && JSON.stringify(options.getRevision()) !== JSON.stringify(capturedRevision)) return
    retry()
  })
  return {
    defer() {
      deferred = true
      capturedRevision = options?.getRevision?.()
    },
  }
}
// altimate_change end

export function createDebouncedSignal<T>(value: T, ms: number): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal(value)
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (next: T) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      set(() => next)
    }, ms)
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return [get, debounced]
}

export function createFadeIn(show: Accessor<boolean>, enabled: Accessor<boolean>) {
  const [alpha, setAlpha] = createSignal(show() ? 1 : 0)
  let revealed = show()

  createEffect(
    on([show, enabled], ([visible, animate]) => {
      if (!visible) {
        setAlpha(0)
        return
      }

      if (!animate || revealed) {
        revealed = true
        setAlpha(1)
        return
      }

      const start = performance.now()
      revealed = true
      setAlpha(0)

      const timer = setInterval(() => {
        const progress = Math.min((performance.now() - start) / 160, 1)
        setAlpha(progress * progress * (3 - 2 * progress))
        if (progress >= 1) clearInterval(timer)
      }, 16)

      onCleanup(() => clearInterval(timer))
    }),
  )

  return alpha
}
