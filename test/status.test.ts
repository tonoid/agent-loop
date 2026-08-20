// test/status.test.ts
import { test, expect } from "bun:test"
import { renderStatus } from "../src/status"
import type { AccountConfig, AccountUsage } from "../src/types"

const NOW = new Date("2026-08-19T09:00:00Z")
const acct = (o: Partial<AccountConfig> = {}): AccountConfig =>
  ({ id: "loop", provider: "claude", configDir: "~/.a", reserve: 0, ...o })

const usage = (percent: number): AccountUsage => ({
  readable: true,
  windows: [{
    kind: "session", group: "g", percent,
    resetsAt: new Date(NOW.getTime() + 200 * 60000),
    windowMinutes: 300, observedAt: NOW,
  }],
})

test("each account reports its windows and whether it is usable", async () => {
  const lines = await renderStatus({
    now: NOW,
    accounts: [acct(), acct({ id: "main", reserve: 40 })],
    usageFor: async (a) => (a.id === "loop" ? usage(10) : { readable: false, reason: "401 after refresh" }),
    refreshExpiryFor: async () => null,
    spawnsToday: 3,
    workspaces: [{ name: "acme", paused: [] }],
  })
  expect(lines.join("\n")).toContain("loop")
  expect(lines.join("\n")).toContain("session 10.0%")
  expect(lines.join("\n")).toContain("main: unreadable (401 after refresh)")
})

test("a refresh token near its hard ceiling is called out by name", async () => {
  const lines = await renderStatus({
    now: NOW,
    accounts: [acct()],
    usageFor: async () => usage(10),
    refreshExpiryFor: async () => new Date(NOW.getTime() + 3 * 24 * 3600_000),
    spawnsToday: 0,
    workspaces: [{ name: "acme", paused: [] }],
  })
  expect(lines.join("\n")).toContain("refresh token expires in 3d")
})

test("paused jobs and the day's spawn count are reported", async () => {
  const lines = await renderStatus({
    now: NOW,
    accounts: [],
    usageFor: async () => ({ readable: false, reason: "none" }),
    refreshExpiryFor: async () => null,
    spawnsToday: 7,
    workspaces: [{ name: "acme", paused: ["review"] }],
  })
  expect(lines.join("\n")).toContain("spawns today: 7")
  expect(lines.join("\n")).toContain("acme: paused review")
})

test("paused jobs are listed per workspace", async () => {
  const lines = await renderStatus({
    now: new Date("2026-08-19T09:00:00Z"),
    accounts: [],
    usageFor: async () => ({ readable: true, windows: [] }),
    refreshExpiryFor: async () => null,
    spawnsToday: 3,
    workspaces: [
      { name: "acme", paused: ["build"] },
      { name: "other", paused: [] },
    ],
  })
  expect(lines).toContain("acme: paused build")
  expect(lines).toContain("other: paused nothing")
})
