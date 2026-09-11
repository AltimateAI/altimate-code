import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

// Codex re-review round 8 (cycle-stability/ready-pending test coverage): a reactive
// defer-then-retry primitive — call `.defer()` when a caller can't act yet (e.g. a readiness
// signal is still pending), and the wrapped `retry` callback fires automatically, exactly once,
// the NEXT time `pending()` reads false. Extracted as a standalone, importable function so the
// SAME production code path is exercised by both a real consumer (component/prompt/index.tsx's
// submit gate — see `readyPending`'s declaration there) and its test
// (test/context/ready-pending.test.tsx) — the test was previously a hand-rolled reimplementation
// of this exact shape, which meant reverting the real fix in prompt/index.tsx left the test
// passing regardless, since it never touched production code at all.
export function createDeferredRetry(pending: Accessor<boolean>, retry: () => void) {
  let deferred = false
  createEffect(() => {
    if (pending() || !deferred) return
    deferred = false
    retry()
  })
  return {
    defer() {
      deferred = true
    },
  }
}

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
