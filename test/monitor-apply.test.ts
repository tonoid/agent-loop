import { test, expect } from "bun:test"
import { applyNudge, applyEscalate } from "../src/effects/monitor"
import type { Ctx, Job, WorkItem } from "../src/types"

const item: WorkItem = {
  id: "pr:80", number: 80, title: "t", state: "OPEN", labels: [],
  url: "https://example.test/acme/web/pull/80",
}

function ctxWith(o: { panes?: any[] } = {}) {
  const calls: any[][] = []
  const ctx = {
    workspace: {
      worktreeBase: "/b",
      repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
    },
    live: true,
    herdr: {
      panes: async () => o.panes ?? [{ cwd: "/b/wt-review-r80", paneId: "p1", tabId: "w6:t2" }],
      agentPrompt: async (target: string, text: string) => { calls.push(["prompt", target, text]) },
    },
    gh: { label: async (repo: string, kind: string, n: number, x: any) => { calls.push(["label", repo, kind, n, x]) } },
    cache: <T,>(_k: string, fn: () => Promise<T>) => fn(),
  } as unknown as Ctx
  return { ctx, calls }
}

const job = (o: Partial<Job> = {}): Job =>
  ({ name: "review", workload: "reviewer", repo: "web", ...o }) as Job

test("a nudge goes to the pane at the item's worktree", async () => {
  const { ctx, calls } = ctxWith()
  await applyNudge(ctx, job({ nudge: async () => "still there?" }), item, "r80")
  expect(calls).toEqual([["prompt", "p1", "still there?"]])
})

test("a job with no nudge hook still gets a usable default", async () => {
  const { ctx, calls } = ctxWith()
  await applyNudge(ctx, job(), item, "r80")
  expect(calls[0]![0]).toBe("prompt")
  expect(String(calls[0]![2])).toContain("r80")
})

test("nudging an item whose pane is gone is an error the caller can log", async () => {
  const { ctx } = ctxWith({ panes: [] })
  await expect(applyNudge(ctx, job(), item, "r80")).rejects.toThrow(/no pane/)
})

test("escalation asks the agent to park the item itself", async () => {
  const { ctx, calls } = ctxWith()
  await applyEscalate(ctx, job({ escalate: async () => "post your question and stop" }), item, "r80")
  expect(calls).toEqual([["prompt", "p1", "post your question and stop"]])
})

test("with no escalate hook the loop parks the item itself and frees the slot", async () => {
  const { ctx, calls } = ctxWith()
  await applyEscalate(ctx, job(), item, "r80")
  expect(calls).toEqual([
    ["label", "acme/web", "pr", 80, { add: ["needs-human"], remove: ["agent-wip"] }],
  ])
})

// The engine has already logged ESCALATE and cleared the blocked mark by the
// time this runs, so a silent return reads as an action that never happened and
// the item cycles: blocked, wait the timeout, escalate nothing, blocked.
test("a trackerless item escalates to the job's onFail, which is where its verdict lives", async () => {
  const { ctx, calls } = ctxWith()
  const occurrence: WorkItem = { id: "key:20260819-0910", number: 0, title: "nightly", state: "OPEN", labels: [] }
  const failed: string[] = []
  const p = job({ onFail: async (_c, _i, tail) => { failed.push(tail) } })
  await applyEscalate(ctx, p, occurrence, "20260819-0910")
  expect(calls).toEqual([])
  expect(failed.length).toBe(1)
  expect(failed[0]!).toContain("blocked past the escalation timeout")
})

test("a trackerless item with no onFail is a no-op, and labels nothing", async () => {
  const { ctx, calls } = ctxWith()
  const occurrence: WorkItem = { id: "key:20260819-0910", number: 0, title: "nightly", state: "OPEN", labels: [] }
  await applyEscalate(ctx, job(), occurrence, "20260819-0910")
  expect(calls).toEqual([])
})

import { applyRestart, applyFail, applyDone, FAIL_TAIL_LINES } from "../src/effects/monitor"
import { memoryLock } from "../src/lock"

function liveCtx(o: { account?: string | null; tail?: string } = {}) {
  const calls: any[][] = []
  const ctx = {
    workspace: {
      worktreeBase: "/b",
      repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
    },
    config: {
      // The kind is deliberately not "claude": a restart that reached for a
      // hard-coded default would be indistinguishable otherwise.
      accounts: [{ id: "loop", provider: "codex", configDir: "~/.a", reserve: 0, agentKind: "codex", startArgs: ["--yolo"] }],
    },
    live: true,
    sleep: async () => {},
    global: { accountFor: () => (o.account === undefined ? "loop" : o.account) },
    herdr: {
      panes: async () => [{ cwd: "/b/wt-review-r80", paneId: "p1", tabId: "w6:t2" }],
      agentStart: async (a: any) => { calls.push(["start", a.pane, a.kind, a.name, ...a.args]) },
      agentPrompt: async (t: string, text: string) => { calls.push(["prompt", t, text]) },
      agentSendKeys: async () => { calls.push(["enter"]) },
      agentStatus: async () => "working",
      agentRead: async (t: string, n: number) => { calls.push(["read", t, n]); return o.tail ?? "line" },
      tabClose: async (tabId: string) => { calls.push(["tabClose", tabId]) },
    },
    gh: {
      label: async (r: string, k: string, n: number, x: any) => { calls.push(["label", r, k, n, x]) },
      comment: async (r: string, k: string, n: number, body: string) => { calls.push(["comment", r, k, n, body]) },
    },
    lock: memoryLock(),
    git: () => ({
      worktrees: async () => [{ path: "/b/wt-review-r80", branch: "review/r80" }],
      worktreeRemove: async (path: string) => { calls.push(["worktreeRemove", path]) },
      branchDelete: async (b: string) => { calls.push(["branchDelete", b]) },
    }),
    cache: <T,>(_k: string, fn: () => Promise<T>) => fn(),
  } as unknown as Ctx
  return { ctx, calls }
}

test("a restart reuses the spawns table's account for kind and start args", async () => {
  const { ctx, calls } = liveCtx()
  await applyRestart(ctx, job({ brief: async () => "the brief" }), item, "r80")
  expect(calls[0]).toEqual(["start", "p1", "codex", "review-r80", "--yolo"])
  expect(calls[1]).toEqual(["prompt", "p1", "the brief"])
})

// Guessing here would start some other provider's agent in a pane whose --env
// points at this account's config directory, on an account nothing accounts for.
test("a restart with no spawns attribution refuses rather than guessing a kind", async () => {
  const { ctx, calls } = liveCtx({ account: null })
  await expect(applyRestart(ctx, job({ brief: async () => "b" }), item, "r80"))
    .rejects.toThrow(/refusing to guess/)
  expect(calls).toEqual([])
})

test("done removes the claim label and nothing else", async () => {
  const { ctx, calls } = liveCtx()
  await applyDone(ctx, item)
  expect(calls).toEqual([["label", "acme/web", "pr", 80, { remove: ["agent-wip"] }]])
})

test("the default failure tombstones the item and posts the transcript tail", async () => {
  const { ctx, calls } = liveCtx({ tail: "stack trace here" })
  await applyFail(ctx, job(), item, "r80")
  expect(calls[0]).toEqual(["read", "p1", FAIL_TAIL_LINES])
  expect(calls[1]).toEqual([
    "label", "acme/web", "pr", 80, { add: ["agent-failed"], remove: ["agent-wip"] },
  ])
  const body = String(calls[2]![4])
  expect(body).toContain("```")
  expect(body).toContain("stack trace here")
})

test("a job's own onFail replaces the default entirely", async () => {
  const { ctx, calls } = liveCtx()
  const seen: string[] = []
  await applyFail(ctx, job({ onFail: async (_c, _i, tail) => { seen.push(tail) } }), item, "r80")
  expect(seen).toEqual(["line"])
  expect(calls.map((c) => c[0])).not.toContain("label")
})

test("a failure whose pane is already gone still tombstones the item", async () => {
  const { ctx, calls } = liveCtx()
  ;(ctx.herdr as any).panes = async () => []
  await applyFail(ctx, job(), item, "r80")
  expect(calls.map((c) => c[0])).toEqual(["label", "comment"])
})

// A tracked item's failure is terminal because the failed label takes it out of
// discovery. A routine has no label, so without releasing its worktree the
// monitor finds the same finished worker next tick and fails it again: on a
// daily routine that is one FAIL and one journal line every two minutes until
// tomorrow's occurrence.
test("a trackerless failure releases the worktree, so it happens once", async () => {
  const { ctx, calls } = liveCtx()
  const routineItem = { id: "key:20260820-0415", number: 0, title: "run", state: "OPEN", labels: [] } as WorkItem
  const seen: string[] = []
  await applyFail(
    ctx,
    job({ name: "review", repo: "web", onFail: async (_c, _i, tail) => { seen.push(tail) } }),
    routineItem,
    "r80",
  )
  expect(seen).toEqual(["line"])
  // No label: there is nothing to label.
  expect(calls.map((c) => c[0])).not.toContain("label")
  // The claim released, which for a routine is the worktree, its branch and tab.
  expect(calls.map((c) => c[0])).toContain("worktreeRemove")
  expect(calls.map((c) => c[0])).toContain("branchDelete")
})
