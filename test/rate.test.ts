// test/rate.test.ts
import { test, expect } from "bun:test"
import { sampleRate, rateOf, recordAndLearn } from "../src/router/rate"
import { openGlobalState } from "../src/globalstate"
import type { AccountConfig, Window } from "../src/types"

const T0 = new Date("2026-08-19T09:00:00Z")
const T1 = new Date("2026-08-19T09:20:00Z")

const acct = (o: Partial<AccountConfig> = {}): AccountConfig => ({
  id: "loop", provider: "claude", configDir: "~/.a", reserve: 0, ...o,
})
const win = (percent: number, observedAt: Date): Window => ({
  kind: "session", group: "g", percent,
  resetsAt: new Date("2026-08-19T13:00:00Z"), windowMinutes: 300, observedAt,
})

test("a sample is points per minute per worker", () => {
  const s = sampleRate({ percent: 10, at: T0.getTime() }, { percent: 14, at: T1.getTime() }, 2)
  expect(s).toBeCloseTo(4 / 20 / 2, 10)
})

test("no workers, no elapsed time, and a window reset teach nothing", () => {
  const prev = { percent: 10, at: T0.getTime() }
  expect(sampleRate(prev, { percent: 14, at: T1.getTime() }, 0)).toBeNull()
  expect(sampleRate(prev, { percent: 14, at: T0.getTime() }, 2)).toBeNull()
  expect(sampleRate(prev, { percent: 2, at: T1.getTime() }, 2)).toBeNull()
  expect(sampleRate(prev, { percent: 10, at: T1.getTime() }, 2)).toBeNull()
})

test("rateOf falls back to the seed until an ewma exists", () => {
  const s = openGlobalState(":memory:")
  expect(rateOf(s, "claude", "session", 0.05)).toBe(0.05)
  s.observeRate("claude", "session", 0.2)
  expect(rateOf(s, "claude", "session", 0.05)).toBe(0.2)
  s.close()
})

test("a loop-only account records snapshots and learns from them", () => {
  const s = openGlobalState(":memory:")
  const only = acct({ soleConsumer: true })
  recordAndLearn(s, only, [win(10, T0)], 2)
  expect(s.rate("claude", "session")).toBeNull() // nothing to compare against yet
  recordAndLearn(s, only, [win(14, T1)], 2)
  expect(s.rate("claude", "session")).toBeCloseTo(4 / 20 / 2, 10)
  s.close()
})

test("a shared account records snapshots but never teaches", () => {
  const s = openGlobalState(":memory:")
  const a = acct({ id: "main", reserve: 40 })
  recordAndLearn(s, a, [win(10, T0)], 2)
  recordAndLearn(s, a, [win(40, T1)], 2)
  expect(s.rate("claude", "session")).toBeNull()
  expect(s.lastUsage("main", "session", T1.getTime())!.percent).toBe(10)
  s.close()
})

// The trap that starved a live box: reserve is about protecting quota, not
// about who spends it. An account can hold nothing back and still have a human
// on it, and one sample from that human is enough to starve every account,
// because the EWMA is keyed per provider rather than per account.
test("a zero reserve is not a declaration that only the loop spends here", () => {
  const s = openGlobalState(":memory:")
  const shared = acct({ id: "mine", reserve: 0 })
  recordAndLearn(s, shared, [win(10, T0)], 1)
  recordAndLearn(s, shared, [win(40, T1)], 1)
  expect(s.rate("claude", "session")).toBeNull()
  s.close()
})

// The seed is a per-window-kind quantity configured as one number. Read
// literally on a weekly window it prices a worker at thirty-three window-fulls,
// which rounds every account to zero workers and starves the whole box.
test("the seed is priced against the window it is read on, a measured rate is not", () => {
  const g = openGlobalState(":memory:")
  // A 5-hour window is the reference: the seed passes through unchanged.
  expect(rateOf(g, "claude", "session", 0.35, 300)).toBeCloseTo(0.35, 6)
  // A weekly window is 33.6 times longer, so a worker paces it 33.6x slower.
  expect(rateOf(g, "claude", "weekly_all", 0.35, 10080)).toBeCloseTo(0.35 / 33.6, 6)
  // No window length at all keeps the old reading rather than inventing one.
  expect(rateOf(g, "claude", "weekly_all", 0.35)).toBeCloseTo(0.35, 6)

  // A measured EWMA is already per kind, so it is used exactly as learned.
  g.observeRate("claude", "weekly_all", 0.01)
  expect(rateOf(g, "claude", "weekly_all", 0.35, 10080)).toBeCloseTo(0.01, 6)
})
