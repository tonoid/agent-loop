import type { AccountConfig, AccountUsage, Ctx, Job, WorkItem, Window } from "../types"
import { selects } from "../config"
import { concurrencyFor } from "./budget"
import { checkWindows } from "./window"
import { rateOf, recordAndLearn } from "./rate"

export type Route =
  | { ok: true; account: string; reason: string }
  // `global` marks a refusal that describes the box or the day rather than this
  // job, so the spawn walk stops instead of asking the next job.
  | { ok: false; global: boolean; reason: string }

export const BUILT_BY = /^built-by:\s*(\S+)\s*$/m

// How old a recorded reading may be and still price an account the reader
// cannot reach. The usage endpoint answers about five calls a minute per token
// and shares that budget with every consumer of it: each interactive session's
// status line, each worker the loop starts, and the tick itself. A busy account
// draws a 429, and the reader holds a 429 for five minutes on purpose, so one
// unlucky probe costs five minutes and unlucky probes chain. Measured on one
// box over an evening, on a token held by four sessions and two workers: gaps
// of 10, 14, 20, 20 and 27 minutes between successful readings, and the account
// unreadable for 151 of 210 minutes. Ten minutes rode out a single hold and not
// a run of them, which is what benched an account with 93 percent of its week
// left. Half an hour covers the runs actually seen. Past it an account is not
// bursting, it is unreachable, and a stale number would hide that.
export const STALE_USAGE_MS = 30 * 60_000

// The reading to rank on when the live one did not arrive. Nothing is invented
// here: these are readings this loop took and recorded, replayed against a
// later clock, and windowSane still refuses one older than its own window.
// Empty for a fresh account, which has no recorded reading by definition, and
// for an account whose last reading is older than the bound.
//
// Aged forward by what the account could have spent since, because half an hour
// is long enough for the number to matter near a ceiling, and the ceiling is
// what stops a worker starting into a window that will refuse it mid-task. At
// least one consumer even with no worker of ours in flight: an account nothing
// is using does not drain a metering bucket, so a reading we cannot refresh is
// itself evidence that something is spending. The rate is the same one the
// budget prices workers with, so this errs the way that model errs and adds no
// second opinion of its own.
function staleWindows(ctx: Ctx, a: AccountConfig, usage: AccountUsage, workers: number): Window[] {
  // Only when the metering endpoint failed, never when the account did. An
  // account whose credentials are missing or whose refresh was refused cannot
  // authenticate a worker, and no usage number changes that: on 2026-09-01 half
  // an hour of a missing credentials file spawned six builders that each met
  // "Invalid API key, please run /login", failed, and labelled a sound issue
  // agent-failed on the way out.
  if (usage.readable || usage.fresh || !usage.transient) return []
  const windows = ctx.global.lastWindows(a.id, ctx.now.getTime() - STALE_USAGE_MS)
  if (windows.length === 0 || checkWindows(windows, ctx.now)) return []
  return windows.map((w) => {
    const minutes = (ctx.now.getTime() - w.observedAt.getTime()) / 60000
    const rate = rateOf(ctx.global, a.provider, w.kind, ctx.config.workerRateSeed, w.windowMinutes)
    return { ...w, percent: Math.min(100, w.percent + rate * Math.max(workers, 1) * minutes) }
  })
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

// Which account a live worker belongs to, from its cwd. Every workspace on the
// box is walked, not just this one: concurrency is an account-scoped fact, and
// counting only this workspace's workers lets a second workspace spawn against
// an account whose slots are already full.
function attribute(ctx: Ctx, cwd: string): string | null {
  for (const ws of ctx.workspaces) {
    for (const p of ws.jobs) {
      const prefix = `${ws.worktreeBase}/wt-${p.name}-`
      if (!cwd.startsWith(prefix)) continue
      // The worktree directory may carry a title slug after the key, so only
      // the first path segment under the base is used and the spawns table
      // does the matching.
      const dir = cwd.slice(prefix.length).split("/")[0]!
      return ctx.global.accountFor(ws.name, p.name, dir)
    }
  }
  return null
}

// Live workers, attributed to the account that spawned them through the spawns
// table.
async function inFlightByAccount(ctx: Ctx): Promise<Map<string, number>> {
  return ctx.cache("engine:inflight-by-account", async () => {
    const agents = await ctx.cache("engine:agents", () => ctx.herdr.agents())
    const out = new Map<string, number>()
    for (const a of agents) {
      // "missing" is no information, and "done" is an agent that has finished:
      // neither is spending quota, and counting either holds an account's budget
      // behind a worker that has gone home. On 2026-08-31 a maplista reviewer
      // finished its round and left three polling shells behind, which kept
      // herdr reporting "working" and starved the only eligible account with the
      // merge one step away. The shells were the bug and a Stop hook now kills
      // them, but the same starvation follows from any finished agent whose
      // worktree is legitimately held open, which for a reviewer is every round
      // until its pull request closes.
      if (a.status === "missing" || a.status === "done") continue
      const account = attribute(ctx, a.cwd)
      if (account) out.set(account, (out.get(account) ?? 0) + 1)
    }
    return out
  })
}

// The account that built an item is recorded in the PR body, so the constraint
// derives from the outside world like every other claim and the database stays
// a pure cache.
async function builtBy(ctx: Ctx, item: WorkItem): Promise<string | null> {
  // Anchored at the end so "<owner>/<name>/pull/<n>" is unambiguous, and host
  // agnostic so a self-hosted forge resolves the same way.
  const m = item.url?.match(/\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/)
  if (!m) return null
  const body = await ctx.cache(`engine:body:${item.id}`, () =>
    ctx.gh.prView(m[1]!, m[2]!, ["body"]),
  )
  return String(body?.body ?? "").match(BUILT_BY)?.[1] ?? null
}

interface Ranked {
  account: AccountConfig
  demoted: boolean
  prefer: number
  headroom: number
  why: string
}

export async function chooseAccount(ctx: Ctx, p: Job, item: WorkItem): Promise<Route> {
  const cfg = ctx.config

  // A job the cap does not apply to still spends the account's quota and still
  // waits for a worker slot, so usageMax, the reserves and maxConcurrent are
  // what pace it. Only the box-wide day counter is lifted.
  const cap = p.ignoresSpawnCap ? Infinity : cfg.maxSpawnsPerDay

  const spawned = ctx.global.spawnsSince(startOfUtcDay(ctx.now))
  if (spawned >= cap) {
    return { ok: false, global: true, reason: `CAP ${spawned}/${cfg.maxSpawnsPerDay} spawns today` }
  }

  const inFlight = await inFlightByAccount(ctx)
  const busy = [...inFlight.values()].reduce((a, b) => a + b, 0)
  if (busy > 0) {
    // Quota headroom says nothing about RAM, and workers each run installs, dev
    // servers and typecheckers. With nothing in flight the box is as free as it
    // will ever be, so refusing then would deadlock the loop.
    const free = await ctx.memAvailableMb()
    if (free < cfg.minFreeMb) {
      return { ok: false, global: true, reason: `LOWMEM ${Math.round(free)}MB < ${cfg.minFreeMb}MB` }
    }
  }

  const pool = cfg.accounts.filter((a) => !p.requires || p.requires.some((s) => selects(a, s)))
  if (pool.length === 0) {
    return { ok: false, global: false, reason: `STARVED no account matches requires` }
  }

  const builder = p.distinctFrom ? await builtBy(ctx, item) : null
  const unsatisfiable = p.distinctFrom && builder === null ? ", built-by missing so distinctFrom ignored" : ""

  const ranked: Ranked[] = []
  for (const a of pool) {
    // A reader can throw (missing dir, unrecognized payload shape, a bare
    // fetch, a database that won't open) and readers are meant to: the spec
    // wants that loud. But ctx.usage is memoized per account by ctx.cache, so
    // an unguarded throw here would reject the *cached* promise, and every
    // later job that ranks this same account in this tick would re-throw
    // it too, starving the whole pool over one account's bad day. Only this
    // boundary knows the failure is scoped to one account, so this is where
    // it gets turned into the same unreadable shape a reader would return on
    // purpose.
    const usage = await ctx.usage(a).catch(
      // Transient: a reader that threw is a reader that could not complete its
      // read, which says nothing about the account behind it.
      (err): AccountUsage => ({ readable: false, reason: `read failed: ${err}`, transient: true }),
    )
    const max = a.maxConcurrent ?? cfg.maxConcurrentPerAccount
    const have = inFlight.get(a.id) ?? 0
    const stale = staleWindows(ctx, a, usage, have)
    let concurrency: number
    let why: string

    if (!usage.readable && stale.length === 0) {
      // Unreadable is ineligible, not "usable but ranked last": the last-resort
      // reading sends work to the account most likely already exhausted,
      // precisely when every other account is out. allowWhenUnreadable is the
      // deliberate way back in, and it covers every unreadable reason: no
      // reader can prove an account spent without a reading to prove it with.
      if (!usage.fresh && !a.allowWhenUnreadable) continue
      // A fresh account gets one worker and not its clamp. It has no readings,
      // so there is no evidence of headroom to spend, and one worker is all it
      // takes to record the first window: the tick after it can rank the
      // account on measurements like any other. One is also what stops a
      // payload that never gains windows from spawning every tick, because the
      // worker already in flight fails the concurrency <= have test below.
      concurrency = usage.fresh ? Math.min(1, max) : max
      why = usage.fresh
        ? `fresh, one worker to record the first window (${usage.reason})`
        : `unreadable but allowed (${usage.reason})`
    } else {
      // A stale reading prices the account and teaches nothing. The rate EWMA
      // is the delta between two live readings, and a reading replayed against
      // a later clock is the same number at a different time: it would report
      // an account that spent nothing while its workers ran.
      const windows = usage.readable ? usage.windows : stale
      if (usage.readable) recordAndLearn(ctx.global, a, usage.windows, have)
      const b = concurrencyFor({
        windows,
        now: ctx.now,
        reserve: a.reserve,
        reservePerWeekday: a.reservePerWeekday,
        weekendWeight: a.weekendWeight,
        usageMax: cfg.usageMax,
        releaseBefore: cfg.releaseBefore,
        maxConcurrent: max,
        rateFor: (w) => rateOf(ctx.global, a.provider, w.kind, cfg.workerRateSeed, w.windowMinutes),
      })
      concurrency = b.concurrency
      const age = Math.round((ctx.now.getTime() - windows[0]!.observedAt.getTime()) / 60000)
      // The reason line is what an operator reads after a STARVED run turns
      // into a SPAWN, so a decision taken on an old number says so and says
      // which refusal made it old.
      const from = usage.readable ? "" : ` (stale by ${age}m, ${usage.reason})`
      why = `${b.limiting} ${b.detail} -> ${concurrency} workers, ${have} in flight${from}`
    }

    if (concurrency <= have) continue
    const preferIdx = p.prefer?.findIndex((s) => selects(a, s)) ?? -1
    ranked.push({
      account: a,
      demoted: builder !== null && builder === a.id,
      prefer: preferIdx === -1 ? Number.MAX_SAFE_INTEGER : preferIdx,
      headroom: concurrency - have,
      why,
    })
  }

  if (ranked.length === 0) return { ok: false, global: false, reason: "STARVED no eligible account" }

  ranked.sort(
    (x, y) =>
      Number(x.demoted) - Number(y.demoted) ||
      x.prefer - y.prefer ||
      y.headroom - x.headroom ||
      x.account.id.localeCompare(y.account.id),
  )
  const won = ranked[0]!
  const demoted = won.demoted ? ", demoted by distinctFrom and last standing" : ""
  const reason = `${won.why}${demoted}${unsatisfiable}`

  if (ctx.live) {
    // Choose-and-reserve is one step: counting first and inserting afterwards
    // is the race the daily cap exists to survive.
    const key = await p.key(ctx, item)
    if (!ctx.global.reserve(won.account.id, ctx.workspace.name, p.name, key, ctx.now, cap, startOfUtcDay(ctx.now))) {
      return { ok: false, global: true, reason: `CAP ${cfg.maxSpawnsPerDay} spawns today, reservation refused` }
    }
  }

  return { ok: true, account: won.account.id, reason }
}
