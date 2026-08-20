import type { Ctx, Job } from "./types"
import { issues } from "./kinds/shared"

export type { FilingConfig } from "./types"

// openQueue is the consumer's own discover() result: unclaimed and unparked by
// construction, because that is what a job offers the spawn walk. Cached under
// the engine's key so the consumer's own spawn pass in this same tick pays for
// the read once.
export async function filingBudget(
  ctx: Ctx,
  job: Job,
): Promise<{ openQueue: number; filingBudget: number }> {
  const f = job.filing
  if (!f) return { openQueue: 0, filingBudget: 0 }
  const consumer = ctx.workspace.jobs.find((j) => j.name === f.queue)
  if (!consumer) throw new Error(`job "${job.name}": filing.queue "${f.queue}" names no job in this workspace`)
  const items = await ctx.cache(`engine:discover:${consumer.name}`, () => consumer.discover(ctx))
  const openQueue = items.length
  return {
    openQueue,
    filingBudget: openQueue >= f.maxOpen ? 0 : Math.min(f.perRound, f.maxOpen - openQueue),
  }
}

// Enforcement stays out of the engine (spec 5.2): a job that overfiles has a
// brief problem, and a loop that blocked `gh issue create` would break the one
// write the fences deliberately allow. So this counts and reports.
//
// tradeoff: attribution is by time window, not by author, so two workers of the
// same job filing in the same window share the count. Per-worker attribution
// needs the forge to record who filed what, which is a query this does not have.
export async function auditFiling(
  ctx: Ctx,
  job: Job,
  key: string,
): Promise<{ filed: number; budget: number } | null> {
  const f = job.filing
  if (!f) return null
  const consumer = ctx.workspace.jobs.find((j) => j.name === f.queue)
  if (!consumer) return null
  // How long ago this worker started. No mark means the loop never spawned this
  // key (a reboot, a hand-run), so there is no run to audit.
  const age = ctx.marks.age(job.name, key, "spawned")
  if (age === null) return null
  const since = ctx.now.getTime() - age * 60000
  // The shared helper, so this shares the consumer's own cached list rather
  // than issuing the same --state all read again under a second key.
  const items = await issues(ctx, consumer, "all")
  const filed = items.filter((i) => i.createdAt && Date.parse(i.createdAt) >= since).length
  // perRound rather than the budget the brief carried: the budget is recomputed
  // from a queue depth that has moved since, and perRound is the half of it that
  // does not move. A run that filed within perRound but above the room left is
  // therefore not flagged.
  return { filed, budget: f.perRound }
}
