import { test, expect } from "bun:test"
import { preClean, claim, unclaim } from "../src/effects/spawn"
import { memoryLock } from "../src/lock"
import type { Ctx, Job, WorkItem } from "../src/types"

const item: WorkItem = {
  id: "issue:7", number: 7, title: "t", state: "OPEN", labels: [],
  url: "https://example.test/acme/web/issues/7",
}

const job = (o: Partial<Job> = {}): Job =>
  ({ name: "build", workload: "builder", repo: "web", brief: async () => "go", ...o }) as Job

function ctxWith(o: { worktrees?: any[]; panes?: any[]; labelsAfter?: string[]; branchDeleteThrows?: boolean } = {}) {
  const calls: any[][] = []
  const git = {
    worktrees: async () => o.worktrees ?? [],
    worktreeRemove: async (p: string) => { calls.push(["worktreeRemove", p]) },
    branchDelete: async (b: string) => {
      calls.push(["branchDelete", b])
      if (o.branchDeleteThrows) throw new Error("branch not found")
    },
    remoteDelete: async (b: string) => { calls.push(["remoteDelete", b]) },
  }
  const ctx = {
    workspace: {
      worktreeBase: "/b",
      repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
    },
    live: true,
    lock: memoryLock(),
    git: () => git,
    herdr: {
      panes: async () => o.panes ?? [],
      tabClose: async (id: string) => { calls.push(["tabClose", id]) },
    },
    gh: {
      label: async (r: string, k: string, n: number, x: any) => { calls.push(["label", r, k, n, x]) },
      labelsOf: async () => o.labelsAfter ?? ["agent-wip"],
    },
    cache: <T,>(_k: string, fn: () => Promise<T>) => fn(),
  } as unknown as Ctx
  return { ctx, calls }
}

test("pre-clean removes this key's worktree, branch and tab", async () => {
  const { ctx, calls } = ctxWith({
    worktrees: [{ path: "/b/wt-build-b7", branch: "build/b7" }],
    panes: [{ cwd: "/b/wt-build-b7", paneId: "p1", tabId: "w6:t2" }],
  })
  await preClean(ctx, job(), "b7")
  expect(calls).toEqual([
    ["tabClose", "w6:t2"],
    ["worktreeRemove", "/b/wt-build-b7"],
    ["branchDelete", "build/b7"],
  ])
})

test("pre-clean also catches the slugged directory of the same key", async () => {
  const { ctx, calls } = ctxWith({
    worktrees: [{ path: "/b/wt-build-b7-add-login", branch: "build/b7" }],
  })
  await preClean(ctx, job(), "b7")
  expect(calls.map((c) => c[0])).toEqual(["worktreeRemove", "branchDelete"])
})

test("pre-clean leaves another key's worktree alone", async () => {
  const { ctx, calls } = ctxWith({
    worktrees: [{ path: "/b/wt-build-b48", branch: "build/b48" }],
  })
  await preClean(ctx, job(), "b4")
  // Only this key's own branch name is attempted; b48's worktree is untouched.
  expect(calls).toEqual([["branchDelete", "build/b4"]])
})

// A rollback whose worktreeRemove succeeded and whose branchDelete did not
// leaves a branch no worktree listing can see, and `worktree add -b` refuses
// while it exists: the key would be dead forever.
test("pre-clean deletes an orphaned branch no worktree lists, and does not throw", async () => {
  const { ctx, calls } = ctxWith({ worktrees: [] })
  await preClean(ctx, job(), "b7")
  expect(calls).toEqual([["branchDelete", "build/b7"]])
})

test("a branch delete that fails does not fail the pre-clean", async () => {
  const { ctx } = ctxWith({ branchDeleteThrows: true })
  await preClean(ctx, job(), "b7")
})

test("a claim is applied and then confirmed by re-reading the labels", async () => {
  const { ctx, calls } = ctxWith({ labelsAfter: ["agent-wip", "bug"] })
  expect(await claim(ctx, job(), item)).toBe(true)
  expect(calls).toEqual([["label", "acme/web", "issue", 7, { add: ["agent-wip"] }]])
})

test("a claim the forge did not actually apply is reported as unclaimed", async () => {
  const { ctx } = ctxWith({ labelsAfter: ["bug"] })
  expect(await claim(ctx, job(), item)).toBe(false)
})

test("unclaim removes the claim label", async () => {
  const { ctx, calls } = ctxWith()
  await unclaim(ctx, item)
  expect(calls).toEqual([["label", "acme/web", "issue", 7, { remove: ["agent-wip"] }]])
})
