import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileLock, memoryLock, withRepoLock, lockPath } from "../src/lock"

test("two holders of the same repo lock do not overlap", async () => {
  const impl = memoryLock()
  const order: string[] = []
  const body = (tag: string) => async () => {
    order.push(`${tag}:enter`)
    await new Promise((r) => setTimeout(r, 5))
    order.push(`${tag}:exit`)
  }
  await Promise.all([
    withRepoLock("/r", impl, body("a")),
    withRepoLock("/r", impl, body("b")),
  ])
  // Whichever wins, its exit precedes the other's enter.
  expect(order[1]).toBe(`${order[0]!.split(":")[0]}:exit`)
})

test("different repos do not block each other", async () => {
  const impl = memoryLock()
  const order: string[] = []
  await Promise.all([
    withRepoLock("/r1", impl, async () => {
      order.push("r1:enter")
      await new Promise((r) => setTimeout(r, 5))
      order.push("r1:exit")
    }),
    withRepoLock("/r2", impl, async () => {
      order.push("r2:enter")
      order.push("r2:exit")
    }),
  ])
  expect(order.slice(0, 2)).toEqual(["r1:enter", "r2:enter"])
})

test("the lock is released when the body throws", async () => {
  const impl = memoryLock()
  await expect(withRepoLock("/r", impl, async () => { throw new Error("boom") })).rejects.toThrow("boom")
  let ran = false
  await withRepoLock("/r", impl, async () => { ran = true })
  expect(ran).toBe(true)
})

test("the lock file lives beside the repo's git directory", async () => {
  const seen: string[] = []
  const impl = { async acquire(path: string) { seen.push(path); return () => {} } }
  await withRepoLock("/r", impl, async () => {})
  expect(seen).toEqual(["/r/.git/agent-loop.lock"])
})

// F7: fileLock is the implementation production runs, and it reaches libc
// through bun:ffi. If that ever stops resolving, every spawn throws inside
// applySpawn and every item gets struck and tombstoned. Sequential only: a
// contested flock here has no LOCK_NB and would block the event loop for good.
test("the real file lock acquires, releases, and can be taken again", async () => {
  const repo = mkdtempSync(`${tmpdir()}/agent-loop-lock-`)
  mkdirSync(`${repo}/.git`)
  try {
    const impl = fileLock()
    const order: string[] = []
    await withRepoLock(repo, impl, async () => { order.push("first") })
    // Only reached if the first release really dropped the lock: two open file
    // descriptions on one file conflict under flock, same process or not.
    await withRepoLock(repo, impl, async () => { order.push("second") })
    expect(order).toEqual(["first", "second"])
    expect(existsSync(lockPath(repo))).toBe(true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
