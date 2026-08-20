import type { GlobalStore, UsageSample } from "../globalstate"
import type { AccountConfig, Window } from "../types"

// Under a minute the percent resolution of the payload dominates the delta.
export const MIN_SAMPLE_MINUTES = 1

export function sampleRate(
  prev: UsageSample,
  cur: UsageSample,
  workers: number,
): number | null {
  const elapsed = (cur.at - prev.at) / 60000
  if (workers < 1 || elapsed < MIN_SAMPLE_MINUTES) return null
  const delta = cur.percent - prev.percent
  // A flat interval means the workers were not spending; a drop means the
  // window rolled between snapshots. Neither measures a worker.
  if (delta <= 0) return null
  return delta / elapsed / workers
}

// The seed is one number standing in for a quantity that differs per window
// kind by two orders of magnitude, so it is read against the window it prices:
// 0.35 points/min is a worker burning about one 5-hour window over five hours,
// and the same worker paces a weekly window over a week. Taken literally on a
// weekly window instead, it claims a worker spends thirty-three window-fulls,
// so budgetRate/rate rounds to zero workers and every account starves forever.
// A measured EWMA is already per kind and is used as-is.
export const SEED_REFERENCE_MINUTES = 300

export function rateOf(
  store: GlobalStore,
  provider: string,
  kind: string,
  seed: number,
  windowMinutes?: number,
): number {
  const learned = store.rate(provider, kind)
  if (learned !== null && learned !== undefined) return learned
  return windowMinutes && windowMinutes > 0
    ? seed * (SEED_REFERENCE_MINUTES / windowMinutes)
    : seed
}

export function recordAndLearn(
  store: GlobalStore,
  a: AccountConfig,
  windows: Window[],
  workers: number,
): void {
  for (const w of windows) {
    const prev = store.lastUsage(a.id, w.kind, w.observedAt.getTime())
    store.recordUsage(a.id, w)
    // A human sharing the account lands in the same delta and would teach the
    // fleet that a worker costs several times what it does, and one poisoned
    // sample starves every account: the EWMA is per provider, not per account.
    // Only an account explicitly declared loop-only may teach it. A zero
    // reserve does not imply that; it only says nothing is being held back.
    if (!a.soleConsumer || !prev) continue
    const s = sampleRate(prev, { percent: w.percent, at: w.observedAt.getTime() }, workers)
    if (s !== null) store.observeRate(a.provider, w.kind, s)
  }
}
