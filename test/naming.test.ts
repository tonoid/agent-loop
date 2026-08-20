import { test, expect } from "bun:test"
import { worktreePath, branchName, owns, keyOf, matchesCwd } from "../src/engine/naming"

const BASE = "/home/u/projects/acme"

test("names derive from the job name and the key", () => {
  expect(worktreePath(BASE, "review", "r80")).toBe("/home/u/projects/acme/wt-review-r80")
  expect(branchName("review", "r80")).toBe("review/r80")
})

test("a worktree is owned only when path AND branch both match", () => {
  expect(owns("review", BASE, { path: `${BASE}/wt-review-r80`, branch: "review/r80" })).toBe(true)
  // human checkout sitting in the base: path matches the wt- prefix, branch does not
  expect(owns("review", BASE, { path: `${BASE}/wt-price`, branch: "feat/price-level" })).toBe(false)
  // right branch, wrong base
  expect(owns("review", BASE, { path: "/tmp/wt-review-r80", branch: "review/r80" })).toBe(false)
  // another job's worktree
  expect(owns("review", BASE, { path: `${BASE}/wt-build-b80`, branch: "build/b80" })).toBe(false)
  // detached worktree is never owned
  expect(owns("review", BASE, { path: `${BASE}/wt-review-r80`, branch: null })).toBe(false)
})

test("a worktree whose branch names a different key than its path is not owned", () => {
  expect(owns("review", BASE, { path: `${BASE}/wt-review-r80`, branch: "review/r999" })).toBe(false)
  expect(owns("review", BASE, { path: `${BASE}/wt-review-r8`, branch: "review/r80" })).toBe(false)
})

test("a worktree carrying a title slug after the key is still owned", () => {
  expect(owns("review", BASE, { path: `${BASE}/wt-review-r80-fix-the-parser`, branch: "review/r80" })).toBe(true)
})

test("two jobs whose names share a prefix do not claim each other", () => {
  expect(owns("review", BASE, { path: `${BASE}/wt-review-extra-r1`, branch: "review-extra/r1" })).toBe(false)
  expect(owns("review-extra", BASE, { path: `${BASE}/wt-review-extra-r1`, branch: "review-extra/r1" })).toBe(true)
})

test("keyOf recovers the raw key from a branch, or null for a foreign branch", () => {
  expect(keyOf("review", "review/r80")).toBe("r80")
  expect(keyOf("review", "review/2026-08-19-06")).toBe("2026-08-19-06")
  expect(keyOf("review", "build/b80")).toBeNull()
  expect(keyOf("review", "review")).toBeNull()
  expect(keyOf("review", "review/")).toBeNull()
})

test("cwd matches a worktree exactly, or under a - or / suffix, but never a bare prefix", () => {
  const wt = `${BASE}/wt-build-b4`
  expect(matchesCwd(wt, wt)).toBe(true)
  expect(matchesCwd(`${wt}/apps/web`, wt)).toBe(true)
  expect(matchesCwd(`${wt}-slug`, wt)).toBe(true)
  expect(matchesCwd(`${BASE}/wt-build-b48-applying-filter`, wt)).toBe(false)
  expect(matchesCwd(`${wt}-8`, wt)).toBe(false)
})
