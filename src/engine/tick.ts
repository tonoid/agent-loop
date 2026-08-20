import type { Ctx, Job, Decision } from "../types"
import { sweepAll } from "./sweep"
import { monitorAll } from "./monitor"
import { spawnOne } from "./spawn"

export interface TickOpts { paused: boolean; pausedJobs?: string[]; gcDays?: number }

export async function runTick(ctx: Ctx, jobs: Job[], opts: TickOpts): Promise<Decision[]> {
  const started = Date.now()
  const out: Decision[] = []
  const emit = (ds: Decision[]) => {
    for (const d of ds) {
      out.push(d)
      ctx.log(d)
    }
  }

  emit([{ pass: "gc", removed: ctx.marks.gc(opts.gcDays ?? 14) }])
  emit(await sweepAll(ctx, jobs))
  emit(await monitorAll(ctx, jobs))
  if (!opts.paused) emit(await spawnOne(ctx, jobs, opts.pausedJobs ?? []))

  emit([{ pass: "tick", workspace: ctx.workspace.name, ms: Date.now() - started }])
  return out
}
