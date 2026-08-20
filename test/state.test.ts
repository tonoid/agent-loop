import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { openState, dryMarks } from "../src/state"

test("a mark is absent until set, then present", () => {
  const s = openState(":memory:")
  expect(s.has("review", "r80", "nudged")).toBe(false)
  s.set("review", "r80", "nudged")
  expect(s.has("review", "r80", "nudged")).toBe(true)
  s.close()
})

test("marks are scoped by job and by key", () => {
  const s = openState(":memory:")
  s.set("review", "r80", "nudged")
  expect(s.has("build", "r80", "nudged")).toBe(false)
  expect(s.has("review", "r81", "nudged")).toBe(false)
  s.close()
})

test("clear removes a mark", () => {
  const s = openState(":memory:")
  s.set("review", "r80", "nudged")
  s.clear("review", "r80", "nudged")
  expect(s.has("review", "r80", "nudged")).toBe(false)
  s.close()
})

test("setting a mark twice does not duplicate it and keeps the first timestamp", () => {
  const s = openState(":memory:")
  s.set("review", "r80", "nudged")
  const first = s.age("review", "r80", "nudged")
  s.set("review", "r80", "nudged")
  expect(s.age("review", "r80", "nudged")).toBe(first)
  s.close()
})

test("age is null for an absent mark and a number for a present one", () => {
  const s = openState(":memory:")
  expect(s.age("review", "r80", "nudged")).toBeNull()
  s.set("review", "r80", "nudged")
  expect(s.age("review", "r80", "nudged")).toBeGreaterThanOrEqual(0)
  s.close()
})

test("openState migrates a pre-rename database with a plugin column", () => {
  const dir = mkdtempSync(`${tmpdir()}/agent-loop-state-migrate-`)
  const path = `${dir}/state.db`
  const old = new Database(path)
  old.exec(`
    CREATE TABLE marks (
      plugin TEXT NOT NULL,
      key    TEXT NOT NULL,
      mark   TEXT NOT NULL,
      at     INTEGER NOT NULL,
      PRIMARY KEY (plugin, key, mark)
    )
  `)
  old.query("INSERT INTO marks (plugin, key, mark, at) VALUES (?, ?, ?, ?)").run(
    "review", "r80", "nudged", Date.now(),
  )
  old.close()

  const s = openState(path)
  expect(s.has("review", "r80", "nudged")).toBe(true)
  s.close()
})

test("gc removes marks older than the cutoff and keeps newer ones", () => {
  const s = openState(":memory:")
  s.set("review", "old", "nudged")
  s.set("review", "new", "nudged")
  s.backdate("review", "old", "nudged", 20 * 24 * 60)
  expect(s.gc(14)).toBe(1)
  expect(s.has("review", "old", "nudged")).toBe(false)
  expect(s.has("review", "new", "nudged")).toBe(true)
  s.close()
})

test("a dry mark is visible through the overlay and absent from the database", () => {
  const inner = openState(":memory:")
  const dry = dryMarks(inner)
  dry.set("review", "80", "nudged")
  expect(dry.has("review", "80", "nudged")).toBe(true)
  expect(inner.has("review", "80", "nudged")).toBe(false)
  inner.close()
})

test("the next dry tick starts over, because the first one nudged nothing", () => {
  const inner = openState(":memory:")
  dryMarks(inner).set("review", "80", "nudged")
  expect(dryMarks(inner).has("review", "80", "nudged")).toBe(false)
  inner.close()
})

test("the overlay reads marks the database already holds", () => {
  const inner = openState(":memory:")
  inner.set("digest", "20260820-0910", "spawned")
  const dry = dryMarks(inner)
  expect(dry.has("digest", "20260820-0910", "spawned")).toBe(true)
  expect(dry.age("digest", "20260820-0910", "spawned")).toBe(0)
  inner.close()
})

test("a dry clear hides a stored mark without deleting it", () => {
  const inner = openState(":memory:")
  inner.set("review", "80", "blocked")
  const dry = dryMarks(inner)
  dry.clear("review", "80", "blocked")
  expect(dry.has("review", "80", "blocked")).toBe(false)
  expect(dry.age("review", "80", "blocked")).toBe(null)
  expect(inner.has("review", "80", "blocked")).toBe(true)
  inner.close()
})

test("setting an overlay mark twice keeps the first timestamp", () => {
  const inner = openState(":memory:")
  const dry = dryMarks(inner)
  dry.set("review", "80", "blocked")
  dry.backdate("review", "80", "blocked", 200)
  dry.set("review", "80", "blocked")
  expect(dry.age("review", "80", "blocked")).toBe(200)
  inner.close()
})

test("a dry tick collects nothing and says so", () => {
  const inner = openState(":memory:")
  inner.set("review", "old", "nudged")
  inner.backdate("review", "old", "nudged", 60 * 24 * 30)
  expect(dryMarks(inner).gc(14)).toBe(0)
  expect(inner.has("review", "old", "nudged")).toBe(true)
  inner.close()
})

test("all lists every mark, ordered, for the operator to read", () => {
  const s = openState(":memory:")
  s.set("review", "80", "nudged")
  s.set("digest", "20260820-0910", "spawned")
  expect(s.all().map((r) => `${r.job} ${r.key} ${r.mark}`)).toEqual([
    "digest 20260820-0910 spawned",
    "review 80 nudged",
  ])
  expect(s.all()[0]!.at).toBeGreaterThan(0)
  s.close()
})
