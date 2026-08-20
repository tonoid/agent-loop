import type { Window } from "../types"

// The payload does not carry a window length, so it is inferred from the kind.
// Documented assumption: session is 5 hours, both weekly kinds are 7 days.
export const CLAUDE_WINDOW_MINUTES: Record<string, number> = {
  session: 300,
  weekly_all: 10080,
  weekly_scoped: 10080,
}

// A window only describes its own span. A reset time further than one span away
// in either direction is a unit error or gross clock skew, and a snapshot taken
// more than one span ago says nothing about the window it names. Never infer
// "percent is 0" from a reset time in the past.
export function windowSane(w: Window, now: Date): boolean {
  const span = w.windowMinutes * 60000
  const t = w.resetsAt.getTime()
  if (Number.isNaN(t) || !(w.windowMinutes > 0)) return false
  if (t < now.getTime() - span || t > now.getTime() + span) return false
  // Both readers do Number(...) on a payload field that may be absent, so a
  // missing percent flows through as NaN rather than throwing. Left
  // unchecked, NaN <= have is false (so the account is never skipped as
  // exhausted) and y.headroom - x.headroom is NaN in the ranking sort
  // (falsy, so it decides nothing), letting a poisoned account outrank a
  // healthy one on alphabetical id alone. Same NaN-poisoning class as the
  // claude reader's throw-on-unknown-kind, guarded here in the opposite
  // direction: reject the bad value instead of throwing on it.
  if (!Number.isFinite(w.percent)) return false
  return now.getTime() - w.observedAt.getTime() <= span
}

export function checkWindows(ws: Window[], now: Date): string | null {
  for (const w of ws) {
    if (!windowSane(w, now)) {
      return `window "${w.kind}" is not sane: resetsAt ${w.resetsAt.toISOString()}, observedAt ${w.observedAt.toISOString()}, span ${w.windowMinutes}m`
    }
  }
  return null
}
