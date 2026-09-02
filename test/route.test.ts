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
    usage: { loop: { readable: false, reason: "429 from the usage endpoint", transient: true } },
  })
  expect(await chooseAccount(out.ctx, job(), item())).toMatchObject({ ok: false, global: false })

  // A 429 from the metering endpoint is the one unreadable reason that used to
  // be barred from coming back, on the mistaken reading that it proved the
  // account spent. The operator's opt-in decides now, as it does for grok.
  const back = build({
    accounts: [acct("loop", { allowWhenUnreadable: true })],
    usage: { loop: { readable: false, reason: "429 from the usage endpoint", transient: true } },
  })
  expect(await chooseAccount(back.ctx, job(), item())).toMatchObject({ ok: true, account: "loop" })
})

// The endpoint answers about five calls a minute per token and shares that
// budget with every interactive claude on the box, so a healthy account draws
// a 429 on a busy minute and the reader caches it for five. Benching the
// account for those five minutes throws away the reading the tick two minutes
// earlier took, which is still true: on 2026-08-31 a session window moved two
// points in half an hour under two workers, so a reading of that age is off by
// a fraction of a point against a ceiling of 90.
test("an unreadable account is priced on its last stored reading", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: { readable: false, reason: "429 from the usage endpoint", transient: true } },
  })
  global.recordUsage("loop", {
    kind: "session", group: "session", percent: 10,
    resetsAt: new Date(NOW.getTime() + 200 * 60000),
    windowMinutes: 300, observedAt: new Date(NOW.getTime() - 2 * 60000),
  })
  const r = await chooseAccount(ctx, job(), item())
  expect(r).toMatchObject({ ok: true, account: "loop" })
  // The log has to say the number is not a fresh one, or an operator reading
  // STARVED-then-SPAWN has no way to tell which readings the loop acted on.
  expect(r.ok === true && r.reason).toContain("stale")
  expect(r.ok === true && r.reason).toContain("429 from the usage endpoint")
})

// The bound is what separates a burst from an account nobody can read at all.
// A reading old enough to have been overtaken by the workers it priced is not
// evidence, and an account that has been unreadable for twenty minutes has
// something wrong with it that a stale number would hide.
test("a stored reading past the stale bound rescues nothing", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: { readable: false, reason: "429 from the usage endpoint", transient: true } },
  })
  global.recordUsage("loop", {
    kind: "session", group: "session", percent: 10,
    resetsAt: new Date(NOW.getTime() + 200 * 60000),
    windowMinutes: 300, observedAt: new Date(NOW.getTime() - 35 * 60000),
  })
  expect(await chooseAccount(ctx, job(), item())).toEqual({
    ok: false, global: false, reason: "STARVED no eligible account",
  })
})

// Half an hour, because the refusals chain. A 429 is held for five minutes by
// the reader, so an unlucky probe costs five, and on a token shared with four
// interactive sessions and two workers the probes kept losing: gaps of 10, 14,
// 20, 20 and 27 minutes between successful readings in one evening. Ten minutes
// rode out one hold and not a run of them.
test("a reading from twenty-five minutes ago still prices the account", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: { readable: false, reason: "429 from the usage endpoint", transient: true } },
  })
  global.recordUsage("loop", {
    kind: "session", group: "session", percent: 10,
    resetsAt: new Date(NOW.getTime() + 200 * 60000),
    windowMinutes: 300, observedAt: new Date(NOW.getTime() - 25 * 60000),
  })
  expect(await chooseAccount(ctx, job(), item())).toMatchObject({ ok: true, account: "loop" })
})

// What the widening costs is that the number is older, so it is aged forward by
// what the account could have spent since. At least one consumer, even with no
// worker of ours in flight: an account nothing is using does not drain a
// metering bucket, so a reading we cannot refresh is evidence something is
// spending. The same 84% is eligible read live and refused read from
// twenty-five minutes ago, which is the whole point of the adjustment.
test("a stale reading is aged forward by what the account could have spent", async () => {
  const live = build({ accounts: [acct("loop")], usage: { loop: tight(84) } })
  expect(await chooseAccount(live.ctx, job(), item())).toMatchObject({ ok: true })

  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: { readable: false, reason: "429 from the usage endpoint", transient: true } },
  })
  global.recordUsage("loop", {
    kind: "session", group: "session", percent: 84,
    resetsAt: new Date(NOW.getTime() + 200 * 60000),
    windowMinutes: 300, observedAt: new Date(NOW.getTime() - 25 * 60000),
  })
  expect(await chooseAccount(ctx, job(), item())).toMatchObject({ ok: false, global: false })
})

// The reason matters, not just the fact of being unreadable. On 2026-09-01 an
// account's credentials file went missing for half an hour; the reading from
// before it went kept the account eligible, and six builders spawned into it,
// each hitting "Invalid API key, please run /login", failing, and labelling a
// perfectly good issue agent-failed. A usage number cannot rescue an account a
// worker cannot authenticate to. Only the metering endpoint being busy is
// transient; everything else is a fact about the account.
test("a stale reading rescues a busy endpoint, never a broken account", async () => {
  const seed = (o: { reason: string; transient?: boolean }) => {
    const b = build({ accounts: [acct("loop")], usage: { loop: { readable: false, ...o } } })
    b.global.recordUsage("loop", {
      kind: "session", group: "session", percent: 10,
      resetsAt: new Date(NOW.getTime() + 200 * 60000),
      windowMinutes: 300, observedAt: new Date(NOW.getTime() - 2 * 60000),
    })
    return b.ctx
  }
  const busy = seed({ reason: "429 from the usage endpoint", transient: true })
  expect(await chooseAccount(busy, job(), item())).toMatchObject({ ok: true, account: "loop" })

  // The two that produced doomed workers: no credentials to read, and a
  // refresh the token endpoint refused.
  const gone = seed({ reason: "no credentials in ~/.loop" })
  expect(await chooseAccount(gone, job(), item())).toMatchObject({ ok: false, global: false })

  const stale = seed({ reason: "refresh failed: Error: token endpoint 400" })
  expect(await chooseAccount(stale, job(), item())).toMatchObject({ ok: false, global: false })
})

// A stale reading prices an account, it does not teach the fleet. The rate
// EWMA is fed by the delta between two live readings, and a reading replayed
// against a later clock is the same number at a different time: nothing spent.
test("a stale reading still refuses an account whose window is spent", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop", { reserve: 20 })],
    usage: { loop: { readable: false, reason: "429 from the usage endpoint", transient: true } },
  })
  global.recordUsage("loop", {
    kind: "session", group: "session", percent: 95,
    resetsAt: new Date(NOW.getTime() + 200 * 60000),
    windowMinutes: 300, observedAt: new Date(NOW.getTime() - 2 * 60000),
  })
  expect(await chooseAccount(ctx, job(), item())).toMatchObject({ ok: false, global: false })
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

test("a job that ignores the cap routes through a spent one", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: roomy() },
    config: { maxSpawnsPerDay: 2 },
  })
  global.spawnAdd("loop", "acme", "review", "r1", new Date("2026-08-19T01:00:00Z"))
  global.spawnAdd("loop", "acme", "review", "r2", new Date("2026-08-19T02:00:00Z"))
  expect(await chooseAccount(ctx, job({ ignoresSpawnCap: true }), item()))
    .toMatchObject({ ok: true, account: "loop" })
})

test("a job that ignores the cap also survives the reservation count", async () => {
  const { ctx, global } = build({
    accounts: [acct("loop")],
    usage: { loop: roomy() },
    config: { maxSpawnsPerDay: 1 },
  })
  ;(ctx as any).live = true
  global.reserve("main", "acme", "other", "x1", new Date("2026-08-19T08:00:00Z"), 5, Date.UTC(2026, 7, 19))
  expect(await chooseAccount(ctx, job({ ignoresSpawnCap: true }), item()))
    .toMatchObject({ ok: true, account: "loop" })
  // Still counted, so the day's total reads true and the capped jobs see it.
  expect(global.spawnsSince(Date.UTC(2026, 7, 19))).toBe(2)
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

// The maplista stall of 2026-08-31: a reviewer that had finished its round held
// the only eligible account, because its worktree stays until the pull request
// closes and anything not "missing" counted as a worker in flight.
test("an agent that has finished does not count as a worker in flight", async () => {
  const done = build({
    accounts: [acct("loop")],
    usage: { loop: roomy() },
    memMb: 100,
    agents: [{ cwd: `${BASE}/wt-review-r257`, status: "done", paneId: "pB" }],
  })
  done.global.spawnAdd("loop", "acme", "review", "r257", new Date("2026-08-19T08:00:00Z"))
  // Low memory only bites while something is in flight, so a pass here proves
  // the finished agent was not counted.
  expect(await chooseAccount(done.ctx, job(), item())).toMatchObject({ ok: true })
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
