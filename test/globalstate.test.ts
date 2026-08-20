// test/globalstate.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { Database } from "bun:sqlite"
import { tmpdir } from "node:os"
import { openGlobalState, EWMA_ALPHA } from "../src/globalstate"
import type { Window } from "../src/types"

const win = (kind: string, percent: number, at: string): Window => ({
  kind,
  group: "g",
  percent,
  resetsAt: new Date("2026-08-19T14:00:00Z"),
  windowMinutes: 300,
  observedAt: new Date(at),
})

test("lastUsage returns the newest snapshot strictly before the cutoff", () => {
  const s = openGlobalState(":memory:")
  s.recordUsage("loop", win("session", 10, "2026-08-19T09:00:00Z"))
  s.recordUsage("loop", win("session", 14, "2026-08-19T09:30:00Z"))
  const cutoff = new Date("2026-08-19T09:30:00Z").getTime()
  expect(s.lastUsage("loop", "session", cutoff)).toEqual({
    percent: 10,
    at: new Date("2026-08-19T09:00:00Z").getTime(),
  })
  expect(s.lastUsage("loop", "weekly_all", cutoff)).toBeNull()
  s.close()
})

test("the same window observed twice at one instant is stored once", () => {
  const s = openGlobalState(":memory:")
  s.recordUsage("loop", win("session", 10, "2026-08-19T09:00:00Z"))
  s.recordUsage("loop", win("session", 99, "2026-08-19T09:00:00Z"))
  const later = new Date("2026-08-19T10:00:00Z").getTime()
  expect(s.lastUsage("loop", "session", later)!.percent).toBe(10)
  s.close()
})

test("the first rate sample seeds the ewma and later samples blend", () => {
  const s = openGlobalState(":memory:")
  expect(s.rate("claude", "session")).toBeNull()
  expect(s.observeRate("claude", "session", 0.4)).toBe(0.4)
  const blended = EWMA_ALPHA * 0.8 + (1 - EWMA_ALPHA) * 0.4
  expect(s.observeRate("claude", "session", 0.8)).toBeCloseTo(blended, 10)
  expect(s.rate("claude", "session")).toBeCloseTo(blended, 10)
  expect(s.rate("claude", "weekly_all")).toBeNull()
  s.close()
})

test("accountFor is scoped by workspace, so one job name in two services does not collide", () => {
  const s = openGlobalState(":memory:")
  const at = new Date("2026-08-19T09:00:00Z")
  s.spawnAdd("loop", "acme", "build", "b7", at)
  s.spawnAdd("main", "other", "build", "b7", new Date(at.getTime() + 1000))
  expect(s.accountFor("acme", "build", "b7")).toBe("loop")
  expect(s.accountFor("other", "build", "b7")).toBe("main")
  expect(s.accountFor("third", "build", "b7")).toBeNull()
  s.close()
})

test("accountFor matches an exact key and a slugged directory", () => {
  const s = openGlobalState(":memory:")
  s.spawnAdd("loop", "acme", "review", "r80", new Date("2026-08-19T09:00:00Z"))
  expect(s.accountFor("acme", "review", "r80")).toBe("loop")
  expect(s.accountFor("acme", "review", "r80-2fa-login")).toBe("loop")
  expect(s.accountFor("acme", "review", "r8")).toBeNull()
  expect(s.accountFor("acme", "build", "r80")).toBeNull()
  s.close()
})

test("spawnsSince counts spawn rows at or after the cutoff", () => {
  const s = openGlobalState(":memory:")
  s.spawnAdd("loop", "acme", "review", "r1", new Date("2026-08-18T23:00:00Z"))
  s.spawnAdd("loop", "acme", "review", "r2", new Date("2026-08-19T01:00:00Z"))
  s.spawnAdd("main", "acme", "build", "b3", new Date("2026-08-19T02:00:00Z"))
  expect(s.spawnsSince(Date.UTC(2026, 7, 19))).toBe(2)
  s.close()
})

test("a reservation counts against the cap immediately", () => {
  const s = openGlobalState(":memory:")
  const at = new Date("2026-08-19T09:00:00Z")
  const since = Date.UTC(2026, 7, 19)
  expect(s.reserve("loop", "acme", "build", "b1", at, 2, since)).toBe(true)
  expect(s.reserve("loop", "acme", "build", "b2", at, 2, since)).toBe(true)
  expect(s.reserve("loop", "acme", "build", "b3", at, 2, since)).toBe(false)
  expect(s.spawnsSince(since)).toBe(2)
  s.close()
})

test("a released reservation frees its slot again", () => {
  const s = openGlobalState(":memory:")
  const at = new Date("2026-08-19T09:00:00Z")
  const since = Date.UTC(2026, 7, 19)
  s.reserve("loop", "acme", "build", "b1", at, 1, since)
  expect(s.reserve("loop", "acme", "build", "b2", at, 1, since)).toBe(false)
  s.release("build", "b1", at)
  expect(s.spawnsSince(since)).toBe(0)
  expect(s.reserve("loop", "acme", "build", "b2", at, 1, since)).toBe(true)
  s.close()
})

test("a confirmed reservation is permanent and still attributes the account", () => {
  const s = openGlobalState(":memory:")
  const at = new Date("2026-08-19T09:00:00Z")
  s.reserve("loop", "acme", "review", "r80", at, 10, Date.UTC(2026, 7, 19))
  s.confirm("review", "r80", at)
  s.release("review", "r80", at) // a late release must not delete a confirmed row
  expect(s.accountFor("acme", "review", "r80")).toBe("loop")
  expect(s.spawnsSince(Date.UTC(2026, 7, 19))).toBe(1)
  s.close()
})

test("the cap holds across two separate connections to the same file", () => {
  // Every other test shares one :memory: connection, which proves nothing
  // about the point of BEGIN IMMEDIATE: that a real second workspace, with
  // its own process and its own connection, is locked out too.
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-globalstate-`)
  const path = `${dir}/global.db`
  const a = openGlobalState(path)
  const b = openGlobalState(path)
  const at = new Date("2026-08-19T09:00:00Z")
  const since = Date.UTC(2026, 7, 19)
  expect(a.reserve("loop", "acme", "build", "b1", at, 1, since)).toBe(true)
  expect(b.reserve("main", "acme", "build", "b2", at, 1, since)).toBe(false)
  a.close()
  b.close()
})

test("openGlobalState migrates a pre-rename database with a ledger table", () => {
  // Not :memory:: the whole point is a file written by an older build and
  // found again at the unchanged path. CREATE TABLE IF NOT EXISTS is a no-op
  // against a database that has `ledger` and no `spawns`, so without the
  // rename the daily cap resets to zero, every account reads zero in flight,
  // and accountFor returns null for every worker already running.
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-globalstate-migrate-`)
  const path = `${dir}/state.db`
  const old = new Database(path)
  old.exec(`
    CREATE TABLE ledger (
      account TEXT NOT NULL,
      plugin  TEXT NOT NULL,
      key     TEXT NOT NULL,
      at      INTEGER NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (plugin, key, at)
    )
  `)
  const at = Date.UTC(2026, 7, 19, 9)
  old.query("INSERT INTO ledger (account, plugin, key, at) VALUES (?, ?, ?, ?)").run(
    "loop", "review", "r80", at,
  )
  old.close()

  const s = openGlobalState(path)
  // The row still counts against the daily cap, which is workspace-agnostic,
  // but it resolves no account: a legacy row carries no workspace, so
  // matching it for any workspace's query is the exact cross-workspace
  // collision the `workspace` column exists to prevent (two workspaces with
  // a same-named job and a colliding key would both resolve it).
  expect(s.spawnsSince(Date.UTC(2026, 7, 19))).toBe(1)
  expect(s.accountFor("acme", "review", "r80")).toBeNull()
  s.spawnAdd("main", "acme", "review", "r81", new Date(at + 1000))
  expect(s.accountFor("acme", "review", "r81")).toBe("main")
  s.close()
})
