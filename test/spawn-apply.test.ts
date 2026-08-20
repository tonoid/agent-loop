import { test, expect } from "bun:test"
import { applySpawn, STRIKE_MARK } from "../src/effects/spawn"
import { openState } from "../src/state"
import { memoryLock } from "../src/lock"
import type { AccountConfig, Ctx, Job, WorkItem } from "../src/types"

const item: WorkItem = {
  id: "issue:7", number: 7, title: "t", state: "OPEN", labels: [],
  url: "https://example.test/acme/web/issues/7",
}
const account: AccountConfig = {
  id: "loop", provider: "claude", configDir: "/home/x/.a", reserve: 0, agentKind: "claude",
}

function ctxWith(o: { claimSticks?: boolean; failAt?: string } = {}) {
  const calls: any[][] = []
  const marks = openState(":memory:")
  const spawns: any[][] = []
  const boom = (stage: string) => {
    if (o.failAt === stage) throw new Error(`${stage} exploded`)
  }
  // The worktree list has to reflect what was actually created, or the
  // rollback assertion below passes against a double that never had anything
  // to remove.
  let created: any[] = []
  const git = {
    worktrees: async () => created,
    fetch: async () => { boom("fetch") },
    worktreeAdd: async (p: string, b: string) => {
      calls.push(["worktreeAdd", p])
      created = [{ path: p, branch: b }]
      boom("worktreeAdd")
    },
    worktreeRemove: async (p: string) => { calls.push(["worktreeRemove", p]); created = [] },
    branchDelete: async (b: string) => { calls.push(["branchDelete", b]) },
    remoteDelete: async () => {},
  }
  const ctx = {
    workspace: {
      herdrWorkspace: "acme", worktreeBase: "/b", repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
    },
    config: { accounts: [account] },
    now: new Date("2026-08-19T09:00:00Z"),
    live: true,
    sleep: async () => {},
    lock: memoryLock(),
    marks,
    global: {
      spawnAdd: (...a: any[]) => { spawns.push(a) },
      confirm: (...a: any[]) => { spawns.push(["confirm", ...a]) },
      release: (...a: any[]) => { spawns.push(["release", ...a]) },
      accountFor: () => "loop",
    },
    git: () => git,
    gh: {
      label: async (_r: string, _k: string, _n: number, x: any) => { calls.push(["label", JSON.stringify(x)]) },
      labelsOf: async () => (o.claimSticks === false ? [] : ["agent-wip"]),
    },
    herdr: {
      workspaces: async () => [{ id: "w6", label: "acme" }],
      tabCreate: async () => { calls.push(["tabCreate"]); boom("tabCreate") },
      tabClose: async (id: string) => { calls.push(["tabClose", id]) },
      panes: async () => [{ cwd: "/b/wt-build-b7", paneId: "p1", tabId: "w6:t2" }],
      agentStart: async () => { calls.push(["agentStart"]); boom("agentStart") },
      agentPrompt: async () => { calls.push(["agentPrompt"]) },
      agentStatus: async () => "working",
      agentSendKeys: async () => {},
      agentRead: async () => "tail",
    },
    cache: <T,>(_k: string, fn: () => Promise<T>) => fn(),
  } as unknown as Ctx
  return { ctx, calls, marks, spawns }
}

const job = (o: Partial<Job> = {}): Job =>
  ({
    name: "build", workload: "builder", repo: "web",
    base: async () => "origin/develop", brief: async () => "go", ...o,
  }) as Job

test("a successful spawn records the spawn row and the spawned mark last", async () => {
  const { ctx, calls, marks, spawns } = ctxWith()
  await applySpawn(ctx, job(), item, "b7", account)
  expect(calls.map((c) => c[0])).toEqual([
    // The leading branchDelete is pre-clean's unconditional delete by computed
    // name, which runs even on a clean slate.
    "branchDelete", "label", "worktreeAdd", "tabCreate", "agentStart", "agentPrompt",
  ])
  expect(spawns).toEqual([["confirm", "build", "b7", new Date("2026-08-19T09:00:00Z")]])
  expect(marks.has("build", "b7", "spawned")).toBe(true)
})

test("a claim that does not stick skips the item without a strike", async () => {
  const { ctx, calls, marks, spawns } = ctxWith({ claimSticks: false })
  await expect(applySpawn(ctx, job(), item, "b7", account)).rejects.toThrow(/claim/)
  expect(calls.map((c) => c[0])).not.toContain("worktreeAdd")
  expect(marks.has("build", "b7", STRIKE_MARK)).toBe(false)
  // The reservation was taken in the router before applySpawn ever ran, so a
  // claim that never sticks must still release it - a failed claim gets no
  // strike, but it must not leak a pending row either.
  expect(spawns).toEqual([["release", "build", "b7", new Date("2026-08-19T09:00:00Z")]])
})

test("the first infrastructure failure unclaims and rolls back, without tombstoning", async () => {
  const { ctx, calls, marks } = ctxWith({ failAt: "agentStart" })
  await expect(applySpawn(ctx, job(), item, "b7", account)).rejects.toThrow(/exploded/)
  const labelCalls = calls.filter((c) => c[0] === "label").map((c) => c[1])
  expect(labelCalls).toEqual([
    JSON.stringify({ add: ["agent-wip"] }),
    JSON.stringify({ remove: ["agent-wip"] }),
  ])
  expect(calls.map((c) => c[0])).toContain("worktreeRemove")
  expect(marks.has("build", "b7", STRIKE_MARK)).toBe(true)
})

test("the second failure on the same key tombstones it with the failed label", async () => {
  const { ctx, calls, marks } = ctxWith({ failAt: "agentStart" })
  marks.set("build", "b7", STRIKE_MARK)
  await expect(applySpawn(ctx, job(), item, "b7", account)).rejects.toThrow(/exploded/)
  expect(calls.filter((c) => c[0] === "label").map((c) => c[1])).toContain(
    JSON.stringify({ add: ["agent-failed"], remove: ["agent-wip"] }),
  )
  expect(marks.has("build", "b7", STRIKE_MARK)).toBe(false)
})

test("a failed spawn releases its reservation", async () => {
  const { ctx, spawns } = ctxWith({ failAt: "agentStart" })
  await expect(applySpawn(ctx, job(), item, "b7", account)).rejects.toThrow(/exploded/)
  expect(spawns).toEqual([["release", "build", "b7", new Date("2026-08-19T09:00:00Z")]])
})

test("a success clears an earlier strike", async () => {
  const { ctx, marks } = ctxWith()
  marks.set("build", "b7", STRIKE_MARK)
  await applySpawn(ctx, job(), item, "b7", account)
  expect(marks.has("build", "b7", STRIKE_MARK)).toBe(false)
})

// A routine has no url, so there is no label to move and repoOf would throw.
// Thrown from the strike branch, that replaces the original error, which is
// the one saying what actually broke: the tick reports "no url to derive a
// repo from" for a failure that had nothing to do with a url.
test("a trackerless item's second failure clears the strike and keeps the real error", async () => {
  const routineItem: WorkItem = {
    id: "key:20260820-0610", number: 0, title: "digest", state: "OPEN", labels: [],
  }
  const { ctx, calls, marks } = ctxWith({ failAt: "agentStart" })
  marks.set("build", "b7", STRIKE_MARK)
  await expect(applySpawn(ctx, job(), routineItem, "b7", account)).rejects.toThrow(/exploded/)
  expect(calls.filter((c) => c[0] === "label")).toEqual([])
  expect(marks.has("build", "b7", STRIKE_MARK)).toBe(false)
})
