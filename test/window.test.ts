import { test, expect } from "bun:test"
import { windowSane, checkWindows, CLAUDE_WINDOW_MINUTES } from "../src/router/window"
import { grokReader } from "../src/router/providers/grok"
import type { Window, AccountConfig } from "../src/types"

const NOW = new Date("2026-08-19T09:00:00Z")
const w = (o: Partial<Window>): Window => ({
  kind: "session",
  group: "g",
  percent: 10,
  resetsAt: new Date("2026-08-19T11:00:00Z"),
  windowMinutes: 300,
  observedAt: NOW,
  ...o,
})

test("a window resetting inside its own span in either direction is sane", () => {
  expect(windowSane(w({}), NOW)).toBe(true)
  expect(windowSane(w({ resetsAt: new Date("2026-08-19T05:00:00Z") }), NOW)).toBe(true)
})

test("epoch seconds read as milliseconds is caught", () => {
  // resets_at 1787592195 seconds, used unconverted, lands in 1970.
  expect(windowSane(w({ resetsAt: new Date(1787592195) }), NOW)).toBe(false)
})

test("a snapshot older than its own window carries no information", () => {
  const stale = w({ observedAt: new Date("2026-08-19T02:00:00Z") })
  expect(windowSane(stale, NOW)).toBe(false)
})

test("a non-finite percent is not sane", () => {
  // Both readers do Number(...) on a payload field that may be absent, so a
  // missing percent arrives as NaN rather than throwing. Left unchecked this
  // window would still be "sane" and the reader would hand back
  // { readable: true, windows }: NaN then flows into concurrencyFor and
  // makes headroom NaN, which is falsy in the ranking sort, so a poisoned
  // account can beat a healthy one on id order alone instead of being
  // rejected as unreadable here.
  expect(windowSane(w({ percent: NaN }), NOW)).toBe(false)
  expect(checkWindows([w({ percent: NaN })], NOW)).toContain("session")
})

test("checkWindows names the first insane window and passes clean ones", () => {
  expect(checkWindows([w({}), w({ kind: "weekly_all", windowMinutes: 10080 })], NOW)).toBeNull()
  expect(checkWindows([w({ kind: "bad", resetsAt: new Date(0) })], NOW)).toContain("bad")
})

test("the claude window map has no undefined minutes for a known kind", () => {
  expect(CLAUDE_WINDOW_MINUTES.session).toBe(300)
  expect(CLAUDE_WINDOW_MINUTES.weekly_all).toBe(10080)
  expect(CLAUDE_WINDOW_MINUTES.weekly_scoped).toBe(10080)
})

test("grok is always unreadable, and says why", async () => {
  const a: AccountConfig = { id: "alt", provider: "grok", configDir: "~/g", reserve: 0 }
  const u = await grokReader(a, NOW)
  expect(u.readable).toBe(false)
  expect(u.readable === false && u.reason).toMatch(/no usage signal/)
})
