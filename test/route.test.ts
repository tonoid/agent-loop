import { test, expect } from "bun:test"
import { chooseAccount } from "../src/router/route"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import type { AccountConfig, AccountUsage, Config, Ctx, Job, WorkItem, Window, WorkspaceConfig } from "../src/types"

const NOW = new Date("2026-08-19T09:00:00Z")
const BASE = "/b"

const acct = (id: string, o: Partial<AccountConfig> = {}): AccountConfig => ({
  id, provider: "claude", configDir: `~/.${id}`, reserve: 0, ...o,
})

// 90 - 10 = 80 points over 200 minutes at the 0.05 seed: more than maxConcurrent.
const roomy = (): AccountUsage => ({
  readable: true,
  windows: [{
    kind: "session", group: "g", percent: 10,
    resetsAt: new Date(NOW.getTime() + 200 * 60000),
    windowMinutes: 300, observedAt: NOW,
  } satisfies Window],
})
const tight = (percent: number): AccountUsage => ({
  readable: true,
  windows: [{
    kind: "session", group: "g", percent,
    resetsAt: new Date(NOW.getTime() + 200 * 60000),
    windowMinutes: 300, observedAt: NOW,
  } satisfies Window],
})

const job = (o: Partial<Job> = {}): Job => ({
  name: "review", workload: "reviewer", repo: "web",
  discover: async () => [], discoverClaimed: async () => [],
  key: async () => "r80", done: async () => false, ...o,
} as Job)

const item = (o: Partial<WorkItem> = {}): WorkItem => ({
  id: "pr:80", number: 80, title: "t", state: "OPEN", labels: [],
  url: "https://example.test/acme/web/pull/80", ...o,
})

const wsCfg = (name: string, base: string, jobs: Job[]): WorkspaceConfig => ({
  name, dir: `/w/${name}`, journalPath: `/w/${name}/journal.md`,
  herdrWorkspace: name, worktreeBase: base, repos: { web: `/r/${name}` },
  naming: { labels: { claim: "c", failed: "f", park: "p", priority: [] }, mergeMethod: "squash" },
  jobs,
})

function build(o: {
  accounts: AccountConfig[]
  usage: Record<string, AccountUsage>
  agents?: Array<{ cwd: string; status: string; paneId: string }>
  jobs?: Job[]
  workspace?: WorkspaceConfig
  workspaces?: WorkspaceConfig[]
  memMb?: number
  config?: Partial<Config>
  body?: string
  rejects?: string[]
}) {
  const global = openGlobalState(":memory:")
  const config: Config = {
    accounts: o.accounts,
    maxConcurrentPerAccount: 4,
    minFreeMb: 3000,
    usageMax: 90,
    releaseBefore: 120,
    maxSpawnsPerDay: 200,
    blockedTimeoutMin: 180,
    holdTimeoutMin: 180,
    workerRateSeed: 0.05,
    workspaces: [],
    ...o.config,
  }
  const ctx = makeCtx({
    workspace: o.workspace ?? wsCfg("acme", BASE, o.jobs ?? [job()]),
    workspaces: o.workspaces,
    config,
    now: NOW,
    live: false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: { prView: async () => ({ body: o.body ?? "" }) } as any,
    gitFor: () => ({}) as any,
    herdr: { agents: async () => o.agents ?? [], panes: async () => [], protocol: async () => 19 } as any,
    marks: openState(":memory:"),
    global,
    usageFor: async (a) => {
      // Simulates a reader that throws (missing dir, bad payload, a bare
      // fetch, a database that won't open), the trigger for finding 1.
      if (o.rejects?.includes(a.id)) throw new Error(`boom reading ${a.id}`)
      return o.usage[a.id] ?? { readable: false, reason: "none" }
    },
    memAvailableMb: async () => o.memMb ?? 8000,
    sink: () => {},
  })
  return { ctx: ctx as Ctx, global }
}

test("the account with the most headroom wins", async () => {
  const { ctx } = build({
    accounts: [acct("loop"), acct("main")],
    usage: { loop: tight(80), main: roomy() },
  })
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toMatchObject({ ok: true, account: "main" })
})

test("an unreadable account is ineligible, not ranked last", async () => {
  const { ctx } = build({
    accounts: [acct("loop"), acct("main")],
    usage: { loop: { readable: false, reason: "401 after refresh" }, main: tight(89) },
  })
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toEqual({ ok: false, global: false, reason: "STARVED no eligible account" })
})

test("allowWhenUnreadable opts an account back in at its own clamp", async () => {
  const { ctx } = build({
    accounts: [acct("alt", { provider: "grok", allowWhenUnreadable: true, maxConcurrent: 2 })],
    usage: { alt: { readable: false, reason: "no usage signal exists for this provider" } },
  })
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toMatchObject({ ok: true, account: "alt" })
})

// A newly logged-in account has started no window, so nothing in its payload
// carries a reset time and the reader can only call it unreadable. Left there
// the loop never spawns on it, so it never records the usage that would make it
// readable, and a working account looks broken until a human runs something on
// it by hand.
test("a fresh account is admitted for one worker, without allowWhenUnreadable", async () => {
  const { ctx } = build({
    accounts: [acct("loop")],
    usage: { loop: { readable: false, reason: "no usage windows yet", fresh: true } },
  })
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toMatchObject({ ok: true, account: "loop" })
  expect(r).toHaveProperty("reason", expect.stringContaining("fresh"))
})

// One worker, not the account's clamp: an account with no readings has no
// evidence of headroom, and one is all it takes to produce the first window.
test("a fresh account never outranks one with measured headroom", async () => {
  const { ctx } = build({
    accounts: [acct("loop"), acct("main")],
    usage: { loop: { readable: false, reason: "no usage windows yet", fresh: true }, main: roomy() },
  })
  expect(await chooseAccount(ctx, job(), item())).toMatchObject({ ok: true, account: "main" })
})

// The one worker it is allowed is also the one that ends the fresh state, so a
// payload that never gains windows cannot turn into a spawn every tick.
test("a fresh account already running its one worker is not admitted again", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: { readable: false, reason: "no usage windows yet", fresh: true } },
    agents: [{ cwd: `${BASE}/wt-review-r80`, status: "working", paneId: "w1:p1" }],
  })
  // The spawns table is what attributes a live worker to an account.
  global.spawnAdd("loop", "acme", "review", "r80", NOW)
  expect(await chooseAccount(ctx, job(), item())).toMatchObject({ ok: false, global: false })
})

test("an unreadable account stays out, and allowWhenUnreadable is the way back in", async () => {
  const out = build({
    accounts: [acct("loop")],
    usage: { loop: { readable: false, reason: "429 from the usage endpoint" } },
  })
  expect(await chooseAccount(out.ctx, job(), item())).toMatchObject({ ok: false, global: false })

  // A 429 from the metering endpoint is the one unreadable reason that used to
  // be barred from coming back, on the mistaken reading that it proved the
  // account spent. The operator's opt-in decides now, as it does for grok.
  const back = build({
    accounts: [acct("loop", { allowWhenUnreadable: true })],
    usage: { loop: { readable: false, reason: "429 from the usage endpoint" } },
  })
  expect(await chooseAccount(back.ctx, job(), item())).toMatchObject({ ok: true, account: "loop" })
})

test("requires filters the pool and prefer orders it", async () => {
  // "other" sorts after both "loop" and "main", so the id tie-break cannot
  // hand it the win by accident: it only wins because requires excluded them.
  const { ctx } = build({
    accounts: [acct("loop"), acct("main"), acct("other", { provider: "codex" })],
    usage: { loop: roomy(), main: roomy(), other: roomy() },
  })
  const only = await chooseAccount(ctx, job({ requires: ["codex"] }), item())
  expect(only).toMatchObject({ ok: true, account: "other" })
  const ordered = await chooseAccount(ctx, job({ prefer: ["main"] }), item())
  expect(ordered).toMatchObject({ ok: true, account: "main" })
})

test("requires with no matching account starves before ranking", async () => {
  const { ctx } = build({
    accounts: [acct("loop"), acct("main")],
    usage: { loop: roomy(), main: roomy() },
  })
  const r = await chooseAccount(ctx, job({ requires: ["codex"] }), item())
  expect(r).toEqual({ ok: false, global: false, reason: "STARVED no account matches requires" })
})

test("distinctFrom demotes the building account without excluding it", async () => {
  const both = {
    accounts: [acct("loop"), acct("main")],
    usage: { loop: roomy(), main: tight(85) },
    body: "some text\nbuilt-by: loop\nmore text",
  }
  const { ctx } = build(both)
  // loop has more headroom but built this item, so main wins despite less.
  expect(await chooseAccount(ctx, job({ distinctFrom: true }), item()))
    .toMatchObject({ ok: true, account: "main" })

  const alone = build({ ...both, accounts: [acct("loop")], usage: { loop: roomy() } })
  expect(await chooseAccount(alone.ctx, job({ distinctFrom: true }), item()))
    .toMatchObject({ ok: true, account: "loop" })
})

test("a missing built-by line is ignored and said so", async () => {
  const { ctx } = build({
    accounts: [acct("loop")],
    usage: { loop: roomy() },
    body: "no attribution here",
  })
  const r = await chooseAccount(ctx, job({ distinctFrom: true }), item())
  expect(r.ok === true && r.reason).toContain("built-by missing")
})

test("in-flight workers are attributed through the spawns table and subtracted", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop", { maxConcurrent: 1 }), acct("main")],
    usage: { loop: roomy(), main: tight(85) },
    agents: [{ cwd: `${BASE}/wt-review-r80-2fa-login`, status: "working", paneId: "p1" }],
  })
  global.spawnAdd("loop", "acme", "review", "r80", new Date("2026-08-19T08:00:00Z"))
  // loop's single slot is taken, so it is no longer eligible.
  expect(await chooseAccount(ctx, job(), item())).toMatchObject({ ok: true, account: "main" })
})

test("the daily spawn cap stops the whole walk", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: roomy() },
    config: { maxSpawnsPerDay: 2 },
  })
  global.spawnAdd("loop", "acme", "review", "r1", new Date("2026-08-19T01:00:00Z"))
  global.spawnAdd("loop", "acme", "review", "r2", new Date("2026-08-19T02:00:00Z"))
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toMatchObject({ ok: false, global: true })
  expect(r.ok === false && r.reason).toContain("CAP")
})

test("low memory only blocks while something is in flight", async () => {
  const idle = build({ accounts: [acct("loop")], usage: { loop: roomy() }, memMb: 100 })
  expect(await chooseAccount(idle.ctx, job(), item())).toMatchObject({ ok: true })

  const busy = build({
    accounts: [acct("loop")],
    usage: { loop: roomy() },
    memMb: 100,
    agents: [{ cwd: `${BASE}/wt-review-r80`, status: "working", paneId: "p1" }],
  })
  busy.global.spawnAdd("loop", "acme", "review", "r80", new Date("2026-08-19T08:00:00Z"))
  const r = await chooseAccount(busy.ctx, job(), item())
  expect(r).toMatchObject({ ok: false, global: true })
  expect(r.ok === false && r.reason).toContain("LOWMEM")
})

test("routing a readable account records its usage for the next tick", async () => {
  const { ctx, global } = build({ accounts: [acct("loop")], usage: { loop: roomy() } })
  await chooseAccount(ctx, job(), item())
  expect(global.lastUsage("loop", "session", NOW.getTime() + 1)).not.toBeNull()
})

test("one account's reader throwing degrades only that account, not the whole pool", async () => {
  // "loop" rejects the way a missing codex dir, an unrecognized claude window
  // kind, a bare fetch, or a database that won't open all reject. Without the
  // catch at the account boundary this propagates out of chooseAccount and,
  // because ctx.usage memoizes the rejected promise per account, keeps
  // propagating for every later job in the tick too - the whole pool stops
  // routing over one account's bad day.
  const { ctx } = build({
    accounts: [acct("loop"), acct("main")],
    usage: { main: roomy() },
    rejects: ["loop"],
  })
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toMatchObject({ ok: true, account: "main" })
})

test("a live route reserves the slot it just chose", async () => {
  const { ctx, global } = build({ accounts: [acct("loop")], usage: { loop: roomy() } })
  ;(ctx as any).live = true
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toMatchObject({ ok: true, account: "loop" })
  expect(global.spawnsSince(Date.UTC(2026, 7, 19))).toBe(1)
})

test("a dry route reserves nothing", async () => {
  const { ctx, global } = build({ accounts: [acct("loop")], usage: { loop: roomy() } })
  await chooseAccount(ctx, job(), item())
  expect(global.spawnsSince(Date.UTC(2026, 7, 19))).toBe(0)
})

test("losing the reservation race reads as a cap refusal, and stops the walk", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: roomy() },
    config: { maxSpawnsPerDay: 1 },
  })
  ;(ctx as any).live = true
  // Another workspace took the last slot between the count and the insert.
  global.reserve("main", "acme", "other", "x1", new Date("2026-08-19T08:00:00Z"), 5, Date.UTC(2026, 7, 19))
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toMatchObject({ ok: false, global: true })
  expect(r.ok === false && r.reason).toContain("CAP")
})

test("a worker under another workspace still counts against the account's concurrency", async () => {
  // Two services on one box. The account's slot is taken by a worker under the
  // first workspace's worktree base; the second workspace is the one routing.
  // Counting only its own jobs would let it spawn against a full account, and
  // the account would get double what maxConcurrent allows.
  const other = wsCfg("other", "/b2", [job({ name: "build" })])
  const mine = wsCfg("acme", BASE, [job()])
  const { ctx, global } = build({
    accounts: [acct("loop", { maxConcurrent: 1 }), acct("main")],
    usage: { loop: roomy(), main: tight(85) },
    workspace: mine,
    workspaces: [other, mine],
    agents: [{ cwd: "/b2/wt-build-b7", status: "working", paneId: "p1" }],
  })
  global.spawnAdd("loop", "other", "build", "b7", new Date("2026-08-19T08:00:00Z"))
  expect(await chooseAccount(ctx, job(), item())).toMatchObject({ ok: true, account: "main" })
})
