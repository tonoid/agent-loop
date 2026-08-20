import type { Ctx, Job, Decision } from "../types"
import { chooseAccount } from "../router/route"
import { applySpawn } from "../effects/spawn"

// Shared with render.ts, which uses it to tell an idle job (no candidates)
// apart from a job skipped for any other reason.
export const IDLE_REASON = "idle"

export async function spawnOne(
  ctx: Ctx,
  jobs: Job[],
  paused: string[] = [],
): Promise<Decision[]> {
  const out: Decision[] = []
  const skip = (job: string, reason: string): Decision => ({
    pass: "spawn", job, key: "", action: "skip", reason,
  })

  for (const p of jobs) {
    try {
      if (paused.includes(p.name)) {
        out.push(skip(p.name, "paused"))
        continue
      }

      if (p.admit) {
        const reason = await p.admit(ctx)
        if (reason) {
          out.push(skip(p.name, reason))
          continue
        }
      }

      const slots = p.slots ?? 1
      const inFlight = await ctx.cache(`engine:claimed:${p.name}`, () => p.discoverClaimed(ctx))
      if (inFlight.length >= slots) {
        out.push(skip(p.name, `slots ${inFlight.length}/${slots} in flight`))
        continue
      }

      // Cached under the same key the filing budget reads, so a reviewer that
      // asks how deep the builder's queue is and the builder's own spawn pass
      // pay for one remote read between them.
      const candidates = await ctx.cache(`engine:discover:${p.name}`, () => p.discover(ctx))
      if (candidates.length === 0) {
        out.push(skip(p.name, IDLE_REASON))
        continue
      }

      let picked = null
      for (const c of candidates) {
        if (p.guard && !(await p.guard(ctx, c))) continue
        picked = c
        break
      }
      if (!picked) {
        out.push(skip(p.name, `all ${candidates.length} candidates guarded out`))
        continue
      }

      const key = await p.key(ctx, picked)
      const route = await chooseAccount(ctx, p, picked)
      if (!route.ok) {
        out.push({ pass: "spawn", job: p.name, key, action: "skip", reason: route.reason })
        // CAP and LOWMEM describe the day and the box, so no later job can
        // do better. STARVED is this job's own requires/prefer, so the walk
        // continues; stopping there would let one constrained job mute the
        // whole workspace.
        if (route.global) return out
        continue
      }

      out.push({
        pass: "spawn",
        job: p.name,
        key,
        action: "spawn",
        account: route.account,
        reason: route.reason,
      })
      if (ctx.live) {
        const account = ctx.config.accounts.find((a) => a.id === route.account)!
        try {
          await applySpawn(ctx, p, picked, key, account)
        } catch (err) {
          out.push({ pass: "error", job: p.name, where: "spawn", reason: String(err) })
        }
      }
      // A live tick spawns one worker and stops, because the next tick re-reads
      // the world with that worker in it. A dry tick spawns nothing and its
      // marks are not persisted, so stopping here would hide every job after
      // this one behind the first due item and the mask would never lift: a
      // shadow week reports one job for seven days. Nothing downstream of the
      // decision is reserved without ctx.live, so the walk is free to continue.
      if (ctx.live) return out
    } catch (err) {
      out.push({ pass: "error", job: p.name, where: "spawn", reason: String(err) })
    }
  }
  return out
}
