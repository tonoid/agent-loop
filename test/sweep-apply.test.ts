import { test, expect } from "bun:test"
import { applySweep } from "../src/effects/sweep"
import { memoryLock } from "../src/lock"
import type { Ctx, Job } from "../src/types"

function ctxWith(o: { panes?: any[]; deleteRemote?: boolean } = {}) {
  const calls: string[][] = []
  const git = {
    worktreeRemove: async (p: string) => { calls.push(["worktreeRemove", p]) },
    branchDelete: async (b: string) => { calls.push(["branchDelete", b]) },
    remoteDelete: async (b: string) => { calls.push(["remoteDelete", b]) },
  }
  const ctx = {
    workspace: { worktreeBase: "/b", repos: { web: "/r" } },
    live: true,
    lock: memoryLock(),
    git: () => git,
    herdr: {
      panes: async () => o.panes ?? [],
      tabClose: async (id: string) => { calls.push(["tabClose", id]) },
    },
    cache: <T,>(_k: string, fn: () => Promise<T>) => fn(),
  } as unknown as Ctx
  return { ctx, calls }
}

const job = (o: Partial<Job> = {}): Job =>
  ({ name: "build", workload: "builder", repo: "web", ...o }) as Job

const wt = { path: "/b/wt-build-b7", branch: "build/b7" }

test("the tab is closed by its tab id, then the worktree and branch go", async () => {
  const { ctx, calls } = ctxWith({
    panes: [{ cwd: "/b/wt-build-b7", paneId: "p1", tabId: "w6:t2" }],
  })
  await applySweep(ctx, job(), wt)
  expect(calls).toEqual([
    ["tabClose", "w6:t2"],
    ["worktreeRemove", "/b/wt-build-b7"],
    ["branchDelete", "build/b7"],
  ])
})

test("a worktree whose tab is already gone is still cleaned up", async () => {
  const { ctx, calls } = ctxWith({ panes: [] })
  await applySweep(ctx, job(), wt)
  expect(calls.map((c) => c[0])).toEqual(["worktreeRemove", "branchDelete"])
})

test("the remote branch is deleted only when the job pushes one", async () => {
  const withRemote = ctxWith()
  await applySweep(withRemote.ctx, job({ deleteRemote: true }), wt)
  expect(withRemote.calls.map((c) => c[0])).toContain("remoteDelete")

  const without = ctxWith()
  await applySweep(without.ctx, job(), wt)
  expect(without.calls.map((c) => c[0])).not.toContain("remoteDelete")
})

test("a pane in a sibling worktree is not mistaken for this one", async () => {
  // "wt-build-b4" must not match the pane sitting in "wt-build-b48".
  const { ctx, calls } = ctxWith({
    panes: [{ cwd: "/b/wt-build-b48", paneId: "p9", tabId: "w6:t9" }],
  })
  await applySweep(ctx, job(), { path: "/b/wt-build-b4", branch: "build/b4" })
  expect(calls.map((c) => c[0])).not.toContain("tabClose")
})
