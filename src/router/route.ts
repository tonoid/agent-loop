import type { AccountConfig, AccountUsage, Ctx, Job, WorkItem } from "../types"
import { selects } from "../config"
import { concurrencyFor } from "./budget"
import { rateOf, recordAndLearn } from "./rate"

export type Route =
  | { ok: true; account: string; reason: string }
  // `global` marks a refusal that describes the box or the day rather than this
  // job, so the spawn walk stops instead of asking the next job.
  | { ok: false; global: boolean; reason: string }

export const BUILT_BY = /^built-by:\s*(\S+)\s*$/m

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
      if (a.status === "missing") continue
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

  const spawned = ctx.global.spawnsSince(startOfUtcDay(ctx.now))
  if (spawned >= cfg.maxSpawnsPerDay) {
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
      (err): AccountUsage => ({ readable: false, reason: `read failed: ${err}` }),
    )
    const max = a.maxConcurrent ?? cfg.maxConcurrentPerAccount
    const have = inFlight.get(a.id) ?? 0
    let concurrency: number
    let why: string

    if (!usage.readable) {
      // Unreadable is ineligible, not "usable but ranked last": the last-resort
      // reading sends work to the account most likely already exhausted,
      // precisely when every other account is out. A 429 is never opted back in.
      if (usage.exhausted || !a.allowWhenUnreadable) continue
      concurrency = max
      why = `unreadable but allowed (${usage.reason})`
    } else {
      recordAndLearn(ctx.global, a, usage.windows, have)
      const b = concurrencyFor({
        windows: usage.windows,
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
      why = `${b.limiting} ${b.detail} -> ${concurrency} workers, ${have} in flight`
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
    if (!ctx.global.reserve(won.account.id, ctx.workspace.name, p.name, key, ctx.now, cfg.maxSpawnsPerDay, startOfUtcDay(ctx.now))) {
      return { ok: false, global: true, reason: `CAP ${cfg.maxSpawnsPerDay} spawns today, reservation refused` }
    }
  }

  return { ok: true, account: won.account.id, reason }
}
