import { test, expect } from "bun:test"
import { sweepJob } from "../src/engine/sweep"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Job, Decision, WorkItem } from "../src/types"

const BASE = "/b"

function harness(opts: {
  worktrees: { path: string; branch: string | null }[]
  agents?: { cwd: string; status: "working" | "idle" | "blocked" | "missing"; paneId: string }[]
  sweepOk?: (k: string) => boolean
  ignoresWorking?: boolean
  captureDone?: (item: WorkItem) => void
  doneResult?: boolean
  live?: boolean
}) {
  const log: Decision[] = []
  const removed: string[] = []
  const ctx = makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/w/journal.md",
      herdrWorkspace: "acme", worktreeBase: BASE, repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: {} as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: opts.live ?? false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {} as any,
    gitFor: () => ({
      worktrees: async () => opts.worktrees,
      lsRemote: async () => [],
      worktreeRemove: async (path: string) => {
        removed.push(path)
        throw new Error("worktree is dirty")
      },
    }) as any,
    herdr: { agents: async () => opts.agents ?? [], panes: async () => [], protocol: async () => 19 } as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "not used by this test" }),
    memAvailableMb: async () => 8000,
    sink: (d) => log.push(d),
  })
  const p: Job = {
    name: "review",
    dir: "/j/review",
    workload: "reviewer",
    repo: "web",
    sweepIgnoresWorking: opts.ignoresWorking,
    discover: async () => [],
    discoverClaimed: async () => [],
    key: async (_c, i: WorkItem) => String(i.number),
    done: async (_c, item) => {
      if (opts.captureDone) opts.captureDone(item)
      return opts.doneResult ?? false
    },
    brief: async () => "go",
    sweepOk: opts.sweepOk ? async (_c, k) => opts.sweepOk!(k) : undefined,
  }
  return { ctx, p, log, removed }
}

test("an owned worktree whose work is finished is swept", async () => {
  const { ctx, p } = harness({
    worktrees: [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }],
    sweepOk: () => true,
  })
  const out = await sweepJob(ctx, p)
  expect(out).toEqual([
    { pass: "sweep", job: "review", worktree: `${BASE}/wt-review-r80`, branch: "review/r80", action: "clean", reason: "sweepOk(r80)" },
  ])
})

test("a foreign worktree in the same base is never touched", async () => {
  const { ctx, p } = harness({
    worktrees: [
      { path: `${BASE}/wt-price`, branch: "feat/price-level" },
      { path: `${BASE}/wt-build-b80`, branch: "build/b80" },
    ],
    sweepOk: () => true,
  })
  expect(await sweepJob(ctx, p)).toEqual([])
})

test("a live agent holds the worktree even when sweepOk is true", async () => {
  const { ctx, p } = harness({
    worktrees: [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }],
    agents: [{ cwd: `${BASE}/wt-review-r80`, status: "working", paneId: "w1:p1" }],
    sweepOk: () => true,
  })
  const out = await sweepJob(ctx, p)
  expect(out[0]!).toMatchObject({ action: "hold", reason: "agent working" })
})

test("sweepIgnoresWorking overrides the live-agent hold", async () => {
  const { ctx, p } = harness({
    worktrees: [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }],
    agents: [{ cwd: `${BASE}/wt-review-r80`, status: "working", paneId: "w1:p1" }],
    sweepOk: () => true,
    ignoresWorking: true,
  })
  const out = await sweepJob(ctx, p)
  expect(out[0]!).toMatchObject({ action: "clean" })
})

test("sweepOk false leaves the worktree for a human", async () => {
  const { ctx, p } = harness({
    worktrees: [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }],
    sweepOk: () => false,
  })
  expect(await sweepJob(ctx, p)).toEqual([
    { pass: "sweep", job: "review", worktree: `${BASE}/wt-review-r80`, branch: "review/r80", action: "hold", reason: "sweepOk(r80) false" },
  ])
})

test("an agent under the worktree, not exactly at it, still holds", async () => {
  const { ctx, p } = harness({
    worktrees: [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }],
    agents: [{ cwd: `${BASE}/wt-review-r80/apps/web`, status: "working", paneId: "w1:p1" }],
    sweepOk: () => true,
  })
  expect((await sweepJob(ctx, p))[0]!).toMatchObject({ action: "hold" })
})

test("sweepOk defaults to done when the job omits it", async () => {
  const { ctx, p } = harness({ worktrees: [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }] })
  // done() returns false in the harness, so nothing is swept
  expect((await sweepJob(ctx, p))[0]!).toMatchObject({ action: "hold" })
})

test("done fallback receives a synthetic item with correct number field", async () => {
  let capturedItem: WorkItem | undefined
  const { ctx, p } = harness({
    worktrees: [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }],
    captureDone: (item) => {
      capturedItem = item
    },
    doneResult: true,
  })
  const out = await sweepJob(ctx, p)
  expect(out[0]!).toMatchObject({ action: "clean", reason: "done(r80)" })
  expect(capturedItem!.id).toBe("key:r80")
  expect(capturedItem!.number).toBe(80)
})

test("done fallback with multi-group date key has number zero", async () => {
  let capturedItem: WorkItem | undefined
  const { ctx, p } = harness({
    worktrees: [{ path: `${BASE}/wt-review-2026-08-19-06`, branch: "review/2026-08-19-06" }],
    captureDone: (item) => {
      capturedItem = item
    },
    doneResult: true,
  })
  const out = await sweepJob(ctx, p)
  expect(out[0]!).toMatchObject({ action: "clean", reason: "done(2026-08-19-06)" })
  expect(capturedItem!.id).toBe("key:2026-08-19-06")
  expect(capturedItem!.number).toBe(0)
})

// F5: the ctx.live branch is what stands between a dry run and every write
// applySweep makes, and nothing exercised it.
test("under live the executor runs, and a throw becomes an error without stranding the rest", async () => {
  const h = harness({
    worktrees: [
      { path: `${BASE}/wt-review-r80`, branch: "review/r80" },
      { path: `${BASE}/wt-review-r81`, branch: "review/r81" },
    ],
    sweepOk: () => true,
    live: true,
  })
  const out = await sweepJob(h.ctx, h.p)
  expect(h.removed).toEqual([`${BASE}/wt-review-r80`, `${BASE}/wt-review-r81`])
  expect(out.filter((d) => d.pass === "error").length).toBe(2)
  expect(out.filter((d) => d.pass === "sweep" && d.action === "clean").length).toBe(2)
})

test("without live the executor never runs", async () => {
  const h = harness({
    worktrees: [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }],
    sweepOk: () => true,
  })
  const out = await sweepJob(h.ctx, h.p)
  expect(h.removed).toEqual([])
  expect(out.some((d) => d.pass === "error")).toBe(false)
})
