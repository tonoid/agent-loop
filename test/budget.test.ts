import { test, expect } from "bun:test"
import { concurrencyFor, weekdayEquivalents, type BudgetIn } from "../src/router/budget"
import type { Window } from "../src/types"

const NOW = new Date("2026-08-19T09:00:00Z")
const at = (min: number) => new Date(NOW.getTime() + min * 60000)
const w = (kind: string, percent: number, resetsInMin: number, windowMinutes = 300): Window => ({
  kind, group: "g", percent, resetsAt: at(resetsInMin), windowMinutes, observedAt: NOW,
})

const input = (windows: Window[], o: Partial<Parameters<typeof concurrencyFor>[0]> = {}) => ({
  windows, now: NOW, reserve: 0, usageMax: 90, releaseBefore: 120, maxConcurrent: 4,
  rateFor: () => 0.05, ...o,
})

test("an account under pace gets workers proportional to its budget", () => {
  // 90 - 10 = 80 points over 200 minutes = 0.4 points/min; at 0.05 per worker
  // that is 8 workers, clamped to maxConcurrent.
  expect(concurrencyFor(input([w("session", 10, 200)])).concurrency).toBe(4)
  expect(concurrencyFor(input([w("session", 10, 200)], { maxConcurrent: 6 })).concurrency).toBe(6)
})

test("an account over pace starves", () => {
  // 20 points left over 1000 minutes = 0.02 points/min, under one worker.
  expect(concurrencyFor(input([w("session", 70, 1000, 10080)])).concurrency).toBe(0)
})

test("an account past its ceiling gets zero, never a negative", () => {
  expect(concurrencyFor(input([w("session", 95, 200)])).concurrency).toBe(0)
})

test("a window about to reset with budget unspent maxes out", () => {
  expect(concurrencyFor(input([w("session", 10, 1)])).concurrency).toBe(4)
})

test("the tightest window decides and is named", () => {
  const out = concurrencyFor(input([w("session", 10, 200), w("weekly_all", 88, 5000, 10080)]))
  expect(out.concurrency).toBe(0)
  expect(out.limiting).toBe("weekly_all")
})

test("the reserve lowers the ceiling until releaseBefore drops it", () => {
  const far = input([w("session", 58, 200)], { reserve: 40 })
  // ceiling min(90, 100-40) = 60, so 2 points over 200 minutes: no workers.
  expect(concurrencyFor(far).concurrency).toBe(0)
  // The same account inside releaseBefore: the reserve is released, the ceiling
  // is usageMax again, and 32 points over 100 minutes fills every slot.
  const near = input([w("session", 58, 100)], { reserve: 40 })
  expect(concurrencyFor(near).concurrency).toBe(4)
})

test("usageMax is never released, even at the edge of the reset", () => {
  expect(concurrencyFor(input([w("session", 95, 1)], { reserve: 40 })).concurrency).toBe(0)
})

test("no windows means no concurrency", () => {
  expect(concurrencyFor(input([])).concurrency).toBe(0)
})

test("a non-positive rate cannot manufacture infinite workers", () => {
  expect(concurrencyFor(input([w("session", 10, 200)], { rateFor: () => 0 })).concurrency).toBe(0)
})

// Hours, not whole days: a day counter jumps twenty points at midnight on a
// window that did not change, and it cannot price a Saturday at anything
// between a whole weekday and nothing.
test("weekdayEquivalents integrates the remaining time, weekends discounted", () => {
  const thu = (h = 8) => new Date(2026, 7, 20, h, 0)      // Thursday
  const on = (d: number, h = 8) => new Date(2026, 7, d, h, 0)
  const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 4)

  // Sixteen hours of Thursday left, so two thirds of a weekday.
  near(weekdayEquivalents(thu(), on(21)), 1)
  near(weekdayEquivalents(thu(), on(20, 20)), 0.5)
  // Thursday 08:00 to next Tuesday 08:00: Thu 16h, Fri 24h, Mon 24h, Tue 8h.
  near(weekdayEquivalents(thu(), on(25)), 3)
  // The weekend in the middle is worth a quarter of its 48 hours.
  near(weekdayEquivalents(thu(), on(25), 0.25), 3.5)
  // A pure weekend is never zero once it carries a weight.
  near(weekdayEquivalents(on(22, 0), on(24, 0), 0.25), 0.5)
  near(weekdayEquivalents(on(22, 0), on(24, 0)), 0)
  // No cliff at midnight: an hour of clock is an hour of reserve.
  near(weekdayEquivalents(thu(23), on(21)) - weekdayEquivalents(thu(22), on(21)), -1 / 24)
  near(weekdayEquivalents(thu(), on(19)), 0)
})

test("the per-weekday reserve widens the flat one and never shrinks it", () => {
  const now = new Date(2026, 7, 20, 8, 0)                  // Thursday
  const w = (kind: string, percent: number, resetsAt: Date, windowMinutes: number) =>
    ({ kind, group: "", percent, resetsAt, windowMinutes, observedAt: now })
  const at = (o: Partial<BudgetIn> = {}) => concurrencyFor({
    windows: [w("weekly_all", 10, new Date(2026, 7, 25, 8, 0), 10080)],  // next Tuesday
    now, reserve: 0, usageMax: 90, releaseBefore: 120, maxConcurrent: 4,
    rateFor: () => 0.0104, ...o,
  })

  // Three weekday equivalents at 20 each, plus a quarter-weighted weekend.
  expect(at({ reservePerWeekday: 20, weekendWeight: 0 }).detail).toContain("of 40")
  expect(at({ reservePerWeekday: 20, weekendWeight: 0.25 }).detail).toContain("of 30")
  // The flat reserve is a floor, not an alternative: 80 wins over 3 x 20.
  expect(at({ reserve: 80, reservePerWeekday: 20 }).detail).toContain("of 20")
  // And the per-weekday one wins when it is the larger.
  expect(at({ reserve: 10, reservePerWeekday: 20, weekendWeight: 0 }).detail).toContain("of 40")
  // Unset is the old flat behaviour exactly.
  expect(at({ reserve: 40 }).detail).toContain("of 60")
})
