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
  // How long one worker runs, in minutes. Used to price a burst while the
  // window is behind its line: a worker is only started when the points left
  // can pay for a run of this length.
  workerRunMin: number
  // Percentage points per minute per worker for this window.
  rateFor(w: Window): number
}

export interface BudgetOut {
  concurrency: number
  limiting: string
  detail: string
  // A zero that is the clock talking rather than the quota: the account is
  // ahead of its line, but the points left still pay for a run. It clears on
  // its own within the hour, so a job that unblocks others can be let through
  // it, while a zero without this flag means there is nothing left to spend.
  paused: boolean
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
    const rate = i.rateFor(w)
    // What one run costs, which is the unit everything below is counted in: a
    // worker is started or it is not, and half a run is not a thing to allow.
    const runCost = rate * Math.max(1, i.workerRunMin)
    // The budget spent evenly across the window, which is what the account has
    // earned the right to spend by now. Being under it is credit, being over
    // it is a debt the clock pays off.
    const elapsed = Math.min(1, Math.max(0, 1 - minutesToReset / Math.max(1, w.windowMinutes)))
    const line = ceiling * elapsed
    const credit = line - w.percent
    // Never start a run the remaining points cannot pay for: usageMax exists so
    // a worker does not meet a 429 mid-task, and that holds however far behind
    // the line the account is.
    const affordable = runCost > 0 ? (ceiling - w.percent) / runCost : 0
    // One worker at the line, more the further behind it the account is, none
    // while it is ahead. The previous rule priced a worker as running without a
    // break until the window resets, which no worker here does: a lane waits on
    // continuous integration, on a review round, on a pull request closing. On
    // a seven-day window that arithmetic asked for 171 points of headroom
    // before it would allow a second worker against a ceiling of 75, so it
    // could only ever allow one, and it dropped that one to zero at 19 percent
    // spent. It also inverts near a reset, because the divisor shrinks: the
    // maplista lane ran 102 and 100 spawns on the two days before its weekly
    // reset and 22 on the day after, and each of those weeks still ended with
    // 35 to 73 points expiring unspent.
    const workers = w.percent > line ? 0 : Math.min(affordable, Math.max(1, credit / runCost))
    const concurrency = Math.max(0, Math.min(i.maxConcurrent, Math.round(workers)))

    if (!best || concurrency < best.concurrency) {
      best = {
        concurrency,
        limiting: w.kind,
        detail: `${w.percent.toFixed(1)}% of ${ceiling.toFixed(1)}, line ${line.toFixed(1)}, with ${Math.round(minutesToReset)}m left`,
        paused: concurrency === 0 && w.percent > line && affordable >= 1,
      }
    }
  }

  return best ?? { concurrency: 0, limiting: "none", detail: "no windows", paused: false }
}
