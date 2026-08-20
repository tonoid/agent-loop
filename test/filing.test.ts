import { test, expect } from "bun:test"
import { filingBudget, auditFiling } from "../src/filing"
import { renderDecision } from "../src/render"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Job, WorkItem, Ctx } from "../src/types"

const open = (n: number): WorkItem => ({
  id: `issue:${n}`, number: n, title: "t", state: "OPEN", labels: [],
  url: `https://example.test/acme/web/issues/${n}`,
})

function build(o: { queueDepth?: number; created?: string[] } = {}) {
  const consumer: Job = {
    name: "build", dir: "/j/build", workload: "builder", repo: "web",
    discover: async () => Array.from({ length: o.queueDepth ?? 0 }, (_, i) => open(i + 1)),
    discoverClaimed: async () => [], key: async () => "b1",
    done: async () => false, brief: async () => "",
  }
  const producer: Job = {
    name: "review", dir: "/j/review", workload: "reviewer", repo: "web",
    filing: { queue: "build", maxOpen: 40, perRound: 2, dedupeBy: "path" },
    discover: async () => [], discoverClaimed: async () => [], key: async () => "r1",
    done: async () => false, brief: async () => "",
  }
  const ctx = makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/j/journal.md",
      herdrWorkspace: "acme", worktreeBase: "/b", repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [consumer, producer],
    },
    config: { accounts: [] } as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {
      issueList: async () => (o.created ?? []).map((at, i) => ({ ...open(100 + i), createdAt: at })),
    } as any,
    gitFor: () => ({ remoteSlug: async () => "acme/web" }) as any,
    herdr: {} as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "unused" }),
    memAvailableMb: async () => 8000,
    sink: () => {},
  })
  return { ctx, producer, consumer }
}

test("the budget is the room left in the consumer's queue, capped at perRound", async () => {
  const { ctx, producer } = build({ queueDepth: 5 })
  expect(await filingBudget(ctx, producer)).toEqual({ openQueue: 5, filingBudget: 2 })
})

test("a full queue closes the budget entirely", async () => {
  const { ctx, producer } = build({ queueDepth: 40 })
  expect(await filingBudget(ctx, producer)).toEqual({ openQueue: 40, filingBudget: 0 })
})

test("a nearly full queue is capped by the room, not by perRound", async () => {
  const { ctx, producer } = build({ queueDepth: 39 })
  expect(await filingBudget(ctx, producer)).toEqual({ openQueue: 39, filingBudget: 1 })
})

test("a job with no filing config has no budget and no audit", async () => {
  const { ctx, consumer } = build()
  expect(await filingBudget(ctx, consumer)).toEqual({ openQueue: 0, filingBudget: 0 })
  expect(await auditFiling(ctx, consumer, "b1")).toBe(null)
})

test("the audit counts only items created since this run started", async () => {
  const { ctx, producer } = build({
    created: ["2026-08-19T07:00:00Z", "2026-08-19T08:30:00Z", "2026-08-19T08:45:00Z", "2026-08-19T08:50:00Z"],
  })
  ctx.marks.set("review", "r1", "spawned")
  ;(ctx.marks as any).backdate("review", "r1", "spawned", 60)
  const audit = await auditFiling(ctx, producer, "r1")
  expect(audit).toEqual({ filed: 3, budget: 2 })
})

test("an unspawned key is not audited", async () => {
  const { ctx, producer } = build({ created: ["2026-08-19T08:59:00Z"] })
  expect(await auditFiling(ctx, producer, "r1")).toBe(null)
})

test("the overfill line names the numbers", () => {
  expect(renderDecision({ pass: "audit", job: "review", key: "r1", filed: 5, budget: 2 }))
    .toBe("OVERFILED review r1 3 over budget (filed 5, perRound 2)")
  expect(renderDecision({ pass: "warn", job: "review", reason: "no closing issue on pr:80" }))
    .toBe("WARN review (no closing issue on pr:80)")
})
