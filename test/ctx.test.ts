import { test, expect } from "bun:test"
import { makeCtx } from "../src/ctx"
import type { CtxOpts } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Decision } from "../src/types"

function baseOpts(): CtxOpts {
  return {
    workspace: {
      name: "acme",
      dir: "/w",
      journalPath: "/w/journal.md",
      herdrWorkspace: "acme",
      worktreeBase: "/tmp/acme",
      repos: { web: "/tmp/acme/web" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: {} as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {} as any,
    gitFor: () => ({}) as any,
    herdr: {} as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "not used by this test" }),
    memAvailableMb: async () => 8000,
    sink: () => {},
  }
}

function ctxFor(log: Decision[]) {
  return makeCtx({ ...baseOpts(), sink: (d: Decision) => log.push(d) })
}

test("cache calls the producer once per key and returns the memoized value", async () => {
  const ctx = ctxFor([])
  let calls = 0
  const producer = async () => { calls++; return 42 }
  expect(await ctx.cache("k", producer)).toBe(42)
  expect(await ctx.cache("k", producer)).toBe(42)
  expect(calls).toBe(1)
})

test("cache does not conflate different keys", async () => {
  const ctx = ctxFor([])
  expect(await ctx.cache("a", async () => 1)).toBe(1)
  expect(await ctx.cache("b", async () => 2)).toBe(2)
})

test("concurrent cache calls for one key share a single in-flight producer", async () => {
  const ctx = ctxFor([])
  let calls = 0
  const producer = async () => { calls++; await Bun.sleep(5); return "v" }
  const [x, y] = await Promise.all([ctx.cache("k", producer), ctx.cache("k", producer)])
  expect([x, y]).toEqual(["v", "v"])
  expect(calls).toBe(1)
})

test("log forwards decisions to the sink", () => {
  const log: Decision[] = []
  const ctx = ctxFor(log)
  ctx.log({ pass: "gc", removed: 3 })
  expect(log).toEqual([{ pass: "gc", removed: 3 }])
})

test("usage is read once per account per tick", async () => {
  let calls = 0
  const ctx = makeCtx({ ...baseOpts(), usageFor: async () => { calls++; return { readable: false, reason: "x" } } })
  const a = { id: "loop", provider: "claude", configDir: "~/.a", reserve: 0 } as const
  await ctx.usage(a)
  await ctx.usage(a)
  expect(calls).toBe(1)
})

test("live is off unless asked for, and sleep is injectable", async () => {
  const slept: number[] = []
  const ctx = makeCtx({ ...baseOpts(), live: true, sleep: async (ms) => { slept.push(ms) } })
  expect(ctx.live).toBe(true)
  await ctx.sleep(3000)
  expect(slept).toEqual([3000])
  expect(makeCtx(baseOpts()).live).toBe(false)
})
