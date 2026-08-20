import type { Window } from "../types"

export interface BudgetIn {
  windows: Window[]
  now: Date
  reserve: number
  // Held back per weekday the human still has inside this window, on top of
  // the flat reserve. Zero leaves the flat reserve as the whole mechanism.
  reservePerWeekday?: number
  // What an hour of a Saturday or Sunday is worth against an hour of a weekday.
  weekendWeight?: number
  usageMax: number
  releaseBefore: number
  maxConcurrent: number
  // Percentage points per minute per worker for this window.
  rateFor(w: Window): number
}

export interface BudgetOut {
  concurrency: number
  limiting: string
  detail: string
}

// How much working time a human still has inside this window, in weekday
// equivalents, integrated hour by hour from now rather than counted in whole
// days. Two reasons it is hours: a day counter jumps twenty points at midnight
// on a window that did not change, and it can only value a Saturday at a whole
// weekday or at nothing. Weekend hours are worth weekendWeight of a weekday
// hour, so a weekend keeps a small assignment instead of none.
export function weekdayEquivalents(now: Date, until: Date, weekendWeight = 0): number {
  if (until.getTime() <= now.getTime()) return 0
  let total = 0
  let cursor = now
  // A window longer than a year is a misread payload, not a reason to spin.
  for (let guard = 0; cursor < until && guard < 366 * 24; guard++) {
    const midnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    const end = midnight < until ? midnight : until
    const day = cursor.getDay()
    const weight = day === 0 || day === 6 ? weekendWeight : 1
    total += ((end.getTime() - cursor.getTime()) / 86400000) * weight
    cursor = end
  }
  return total
}

export function concurrencyFor(i: BudgetIn): BudgetOut {
  let best: BudgetOut | null = null

  for (const w of i.windows) {
    // Clamped at one minute: at the instant of reset the true divisor is zero,
    // which would report infinite headroom on a window with none.
    const minutesToReset = Math.max(1, (w.resetsAt.getTime() - i.now.getTime()) / 60000)
    // Quota the developer can no longer spend is not worth holding, so the
    // reserve is released once the window is about to roll. usageMax is never
    // released: the reserve breaks, the hard ceiling does not, so a worker
    // never starts into a window that will 429 mid-task.
    // The flat reserve is a floor under the per-weekday one, not an alternative
    // to it, so an account can hold a minimum and still widen it when the
    // human has more of the window left to work through.
    const perWeekday =
      (i.reservePerWeekday ?? 0) * weekdayEquivalents(i.now, w.resetsAt, i.weekendWeight ?? 0)
    const reserveNow =
      minutesToReset <= i.releaseBefore ? 0 : Math.min(100, Math.max(i.reserve, perWeekday))
    const ceiling = Math.min(i.usageMax, 100 - reserveNow)
    const budgetRate = (ceiling - w.percent) / minutesToReset
    const rate = i.rateFor(w)
    const workers = rate > 0 ? budgetRate / rate : 0
    const concurrency = Math.max(0, Math.min(i.maxConcurrent, Math.round(workers)))

    if (!best || concurrency < best.concurrency) {
      best = {
        concurrency,
        limiting: w.kind,
        detail: `${w.percent.toFixed(1)}% of ${ceiling.toFixed(1)} with ${Math.round(minutesToReset)}m left`,
      }
    }
  }

  return best ?? { concurrency: 0, limiting: "none", detail: "no windows" }
}
